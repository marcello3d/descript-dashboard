import type { Octokit } from "@octokit/rest";
import { getCached, setCache } from "@/lib/cache";
import { trunkStatusFromComments } from "@/lib/github-trunk";
import type { GitHubMergeReadiness } from "@/types";
import type { RawGitHubPR } from "@/lib/github";

const RULES_CACHE_TTL = 5 * 60 * 1000;
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

interface RequiredStatusCheck {
  context: string;
  integration_id?: number | null;
}

export interface BranchRules {
  requiredStatusChecks: RequiredStatusCheck[];
  requiredApprovingReviewCount: number;
  requiresCodeOwnerReview: boolean;
  requiresReviewThreadResolution: boolean;
}

interface RepositoryRule {
  type: string;
  parameters: {
    required_status_checks?: RequiredStatusCheck[];
    required_approving_review_count?: number;
    require_code_owner_review?: boolean;
    required_review_thread_resolution?: boolean;
  } | null;
}

export type CheckContextNode =
  | {
      __typename: "CheckRun";
      name: string;
      status: string | null;
      conclusion: string | null;
      checkSuite: { app: { databaseId: number | null } | null } | null;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string | null;
    };

export interface PullRequestReadinessData {
  headRefOid: string;
  isDraft: boolean;
  merged: boolean;
  closed: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  reviewThreads: {
    nodes: { isResolved: boolean }[];
    pageInfo: { hasNextPage: boolean };
  } | null;
  comments: {
    nodes: { author: { login: string } | null; body: string }[];
  } | null;
}

interface CheckRunsResponse {
  check_runs?: {
    name: string;
    status: string | null;
    conclusion: string | null;
    app: { id: number | null } | null;
  }[];
}

interface CombinedStatusResponse {
  statuses?: {
    context: string;
    state: string | null;
  }[];
}

interface PullRequestReadinessResult {
  repository: {
    pullRequest: PullRequestReadinessData | null;
  } | null;
}

const PR_READINESS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        isDraft
        merged
        closed
        mergeable
        mergeStateStatus
        reviewDecision
        reviewThreads(first: 100) {
          nodes {
            isResolved
          }
          pageInfo {
            hasNextPage
          }
        }
        comments(first: 30) {
          nodes {
            author {
              login
            }
            body
          }
        }
      }
    }
  }
`;

export async function enrichMergeReadiness(octokit: Octokit, prs: RawGitHubPR[]): Promise<void> {
  const openPrs = prs.filter(pr => pr.state === "open" && !pr.merged);
  const BATCH_SIZE = 5;

  for (let i = 0; i < openPrs.length; i += BATCH_SIZE) {
    const batch = openPrs.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(pr => enrichOnePr(octokit, pr)));
  }

  for (const pr of prs) {
    if (!pr.mergeReadiness) {
      pr.mergeReadiness = defaultReadiness(pr);
    }
    if (pr.checksState === undefined) {
      pr.checksState = pr.mergeReadiness.requiredChecksState;
    }
    if (pr.trunk === undefined) {
      pr.trunk = null;
    }
  }
}

async function enrichOnePr(octokit: Octokit, pr: RawGitHubPR): Promise<void> {
  const number = getPullNumber(pr.url);
  if (!number || !pr.baseBranch) {
    applyUnknownReadiness(pr, "readiness unavailable");
    return;
  }

  const [rules, result] = await Promise.all([
    fetchBranchRules(octokit, pr.owner, pr.repo, pr.baseBranch),
    fetchPullRequestReadiness(octokit, pr.owner, pr.repo, number),
  ]);

  const pullRequest = result?.repository?.pullRequest;
  if (!pullRequest) {
    applyUnknownReadiness(pr, "readiness unavailable");
    return;
  }

  // Sync core PR fields and Trunk status before the branch-rules gate: a
  // failed rules fetch only degrades readiness, it shouldn't wipe these too.
  pr.draft = pullRequest.isDraft;
  pr.merged = pullRequest.merged;
  pr.state = pullRequest.closed ? "closed" : "open";
  pr.reviewDecision = pullRequest.reviewDecision;
  pr.trunk = trunkStatusFromComments(
    (pullRequest.comments?.nodes ?? []).map(node => ({ author: node.author?.login, body: node.body }))
  );

  if (!rules) {
    applyUnknownReadiness(pr, "readiness unavailable");
    return;
  }

  const requiredContexts = await fetchRequiredCheckContexts(octokit, pr.owner, pr.repo, pullRequest.headRefOid, rules.requiredStatusChecks);
  pr.mergeReadiness = computeMergeReadiness(pr, pullRequest, rules, requiredContexts);
  pr.checksState = pr.mergeReadiness.requiredChecksState;
}

async function fetchBranchRules(octokit: Octokit, owner: string, repo: string, branch: string): Promise<BranchRules | null> {
  const cacheKey = `github:rules:${owner}/${repo}:${branch}`;
  const cached = getCached<BranchRules>(cacheKey);
  if (cached) return cached;

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
      owner,
      repo,
      branch,
      per_page: 100,
    });
    const rules = parseBranchRules(response.data as RepositoryRule[]);
    setCache(cacheKey, rules, RULES_CACHE_TTL);
    return rules;
  } catch {
    return null;
  }
}

// GraphQL nulls out just the fields a token can't read (e.g. a fine-grained
// PAT without "Checks: read" gets FORBIDDEN on check-run nodes) but
// octokit.graphql throws whenever ANY error is present — even alongside a
// perfectly usable partial payload. Salvage that payload instead of
// discarding the whole PR.
export function graphqlErrorData<T>(error: unknown): T | null {
  if (
    error !== null &&
    typeof error === "object" &&
    (error as Error).name === "GraphqlResponseError" &&
    "data" in error &&
    (error as { data: unknown }).data
  ) {
    return (error as { data: T }).data;
  }
  return null;
}

async function fetchPullRequestReadiness(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number
): Promise<PullRequestReadinessResult | null> {
  try {
    return await octokit.graphql<PullRequestReadinessResult>(PR_READINESS_QUERY, { owner, repo, number });
  } catch (error) {
    return graphqlErrorData<PullRequestReadinessResult>(error);
  }
}

async function fetchRequiredCheckContexts(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  requiredChecks: RequiredStatusCheck[]
): Promise<CheckContextNode[]> {
  if (requiredChecks.length === 0) return [];

  const [checkRunContexts, statusContexts] = await Promise.all([
    fetchRequiredCheckRuns(octokit, owner, repo, ref, requiredChecks),
    fetchCommitStatusContexts(octokit, owner, repo, ref),
  ]);

  return [...checkRunContexts, ...statusContexts];
}

const CHECK_RUNS_FORBIDDEN_TTL = 24 * 60 * 60 * 1000;

async function fetchRequiredCheckRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  requiredChecks: RequiredStatusCheck[]
): Promise<CheckContextNode[]> {
  // A 403 means the token can't read check runs on this repo at all (e.g. a
  // fine-grained PAT without "Checks: read"). Remember that per-repo instead
  // of burning one failed request per required check on every sync; the
  // mergeStateStatus fallback in computeMergeReadiness covers the gap.
  const forbiddenKey = `github:check-runs-forbidden:${owner}/${repo}`;
  if (getCached<boolean>(forbiddenKey)) return [];

  const contexts: CheckContextNode[] = [];

  await Promise.all(requiredChecks.map(async (check) => {
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo,
        ref,
        check_name: check.context,
        per_page: 100,
      });
      const data = response.data as CheckRunsResponse;
      for (const run of data.check_runs ?? []) {
        contexts.push({
          __typename: "CheckRun",
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          checkSuite: { app: { databaseId: run.app?.id ?? null } },
        });
      }
    } catch (error) {
      // Missing exact check data is handled as pending by the readiness reducer.
      if ((error as { status?: number }).status === 403) {
        setCache(forbiddenKey, true, CHECK_RUNS_FORBIDDEN_TTL);
      }
    }
  }));

  return contexts;
}

async function fetchCommitStatusContexts(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<CheckContextNode[]> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
      owner,
      repo,
      ref,
      per_page: 100,
    });
    const data = response.data as CombinedStatusResponse;
    return (data.statuses ?? []).map(status => ({
      __typename: "StatusContext",
      context: status.context,
      state: status.state,
    }));
  } catch {
    return [];
  }
}

function parseBranchRules(rules: RepositoryRule[]): BranchRules {
  const branchRules: BranchRules = {
    requiredStatusChecks: [],
    requiredApprovingReviewCount: 0,
    requiresCodeOwnerReview: false,
    requiresReviewThreadResolution: false,
  };

  for (const rule of rules) {
    if (rule.type === "required_status_checks") {
      branchRules.requiredStatusChecks.push(...(rule.parameters?.required_status_checks ?? []));
    }
    if (rule.type === "pull_request") {
      branchRules.requiredApprovingReviewCount = Math.max(
        branchRules.requiredApprovingReviewCount,
        rule.parameters?.required_approving_review_count ?? 0
      );
      branchRules.requiresCodeOwnerReview ||= rule.parameters?.require_code_owner_review ?? false;
      branchRules.requiresReviewThreadResolution ||= rule.parameters?.required_review_thread_resolution ?? false;
    }
  }

  return branchRules;
}

// mergeStateStatus values where GitHub has itself verified every required
// check: CLEAN (merge box green), UNSTABLE (only non-required checks failing),
// HAS_HOOKS (passing, pre-receive hooks pending). Used as a fallback when
// per-check data is unreadable — required checks still pending would be
// BLOCKED, never one of these.
const CHECKS_SATISFIED_MERGE_STATES = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

export function computeMergeReadiness(
  pr: RawGitHubPR,
  pullRequest: PullRequestReadinessData,
  rules: BranchRules,
  contexts: CheckContextNode[]
): GitHubMergeReadiness {
  let requiredChecksState = getRequiredChecksState(rules.requiredStatusChecks, contexts);
  // No per-check visibility (403 on check-runs) reads as PENDING; trust
  // GitHub's aggregate merge state before reporting checks forever-pending.
  if (requiredChecksState === "PENDING" && CHECKS_SATISFIED_MERGE_STATES.has(normalize(pullRequest.mergeStateStatus))) {
    requiredChecksState = "SUCCESS";
  }
  const reasons: string[] = [];

  if (pr.baseBranch && pr.baseBranch !== "main") reasons.push(`stacked on ${pr.baseBranch}`);
  if (pr.state !== "open" || pullRequest.closed || pullRequest.merged) reasons.push("not open");
  if (pullRequest.isDraft) reasons.push("draft");
  if (pullRequest.mergeable === "CONFLICTING") reasons.push("merge conflicts");
  else if (pullRequest.mergeable !== "MERGEABLE") reasons.push("mergeability unknown");
  if (pullRequest.mergeStateStatus === "DRAFT") reasons.push("draft");
  if (pullRequest.mergeStateStatus === "DIRTY") reasons.push("merge conflicts");
  if (pullRequest.mergeStateStatus === "BEHIND" && rules.requiredStatusChecks.some(Boolean)) reasons.push("branch behind");
  if (pullRequest.mergeStateStatus === "UNKNOWN" || !pullRequest.mergeStateStatus) reasons.push("merge status unknown");
  if (requiredChecksState === "FAILURE") reasons.push("required checks failing");
  if (requiredChecksState === "PENDING") reasons.push("required checks pending");
  if (requiredChecksState === "UNKNOWN") reasons.push("required checks unknown");

  const requiresReview = rules.requiredApprovingReviewCount > 0 || rules.requiresCodeOwnerReview;
  if (requiresReview && pullRequest.reviewDecision !== "APPROVED") {
    reasons.push(pullRequest.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "review required");
  }

  if (rules.requiresReviewThreadResolution) {
    const hasUnresolvedThread = (pullRequest.reviewThreads?.nodes ?? []).some(thread => !thread.isResolved);
    if (hasUnresolvedThread || pullRequest.reviewThreads?.pageInfo?.hasNextPage) {
      reasons.push("review threads unresolved");
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const state = uniqueReasons.length === 0 ? "ready" : "not_ready";

  return {
    ready: state === "ready",
    state,
    reasons: uniqueReasons,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    requiredChecksState,
    requiredChecks: rules.requiredStatusChecks.map(check => check.context),
  };
}

function getRequiredChecksState(requiredChecks: RequiredStatusCheck[], contexts: CheckContextNode[]): GitHubMergeReadiness["requiredChecksState"] {
  if (requiredChecks.length === 0) return "SUCCESS";

  let hasPending = false;
  for (const check of requiredChecks) {
    const matches = contexts.filter(context => matchesRequiredCheck(check, context));
    if (matches.length === 0) {
      hasPending = true;
      continue;
    }
    if (matches.some(isPassingContext)) continue;
    if (matches.some(isPendingContext)) {
      hasPending = true;
      continue;
    }
    return "FAILURE";
  }

  return hasPending ? "PENDING" : "SUCCESS";
}

function matchesRequiredCheck(check: RequiredStatusCheck, context: CheckContextNode): boolean {
  const contextName = context.__typename === "CheckRun" ? context.name : context.context;
  if (contextName !== check.context) return false;
  if (check.integration_id == null) return true;
  return context.__typename === "CheckRun" && context.checkSuite?.app?.databaseId === check.integration_id;
}

function isPassingContext(context: CheckContextNode): boolean {
  if (context.__typename === "StatusContext") {
    return normalize(context.state) === "SUCCESS";
  }
  return normalize(context.status) === "COMPLETED" && PASSING_CHECK_CONCLUSIONS.has(normalize(context.conclusion));
}

function isPendingContext(context: CheckContextNode): boolean {
  if (context.__typename === "StatusContext") {
    return normalize(context.state) === "PENDING";
  }
  return normalize(context.status) !== "COMPLETED";
}

function applyUnknownReadiness(pr: RawGitHubPR, reason: string): void {
  pr.mergeReadiness = {
    ...defaultReadiness(pr),
    reasons: [reason],
  };
  pr.checksState = "UNKNOWN";
}

function defaultReadiness(pr: RawGitHubPR): GitHubMergeReadiness {
  return {
    ready: false,
    state: "unknown",
    reasons: pr.state === "open" && !pr.merged ? ["readiness unavailable"] : [],
    mergeable: null,
    mergeStateStatus: null,
    requiredChecksState: null,
    requiredChecks: [],
  };
}

function getPullNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").toUpperCase();
}
