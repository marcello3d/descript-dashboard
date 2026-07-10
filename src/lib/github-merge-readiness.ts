import type { Octokit } from "@octokit/rest";
import { getCached, setCache } from "@/lib/cache";
import { parseTrunkComment, TRUNK_BOT_LOGINS } from "@/lib/github-trunk";
import type { GitHubMergeReadiness } from "@/types";
import type { RawGitHubPR } from "@/lib/github";

const RULES_CACHE_TTL = 5 * 60 * 1000;
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
// cursor[bot] authors bug-bot review threads; unresolved ones surface in the UI.
const BUG_BOT_LOGIN = "cursor";

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
    nodes: {
      isResolved: boolean;
      comments: { nodes: { author: { login: string } | null; url: string }[] };
    }[];
    pageInfo: { hasNextPage: boolean };
  } | null;
  // Authors + ids only — bodies are fetched in a second pass for just the
  // trunk sticky comment, since ~95% of comment-body bytes come from other
  // bots we never read.
  comments: {
    nodes: { id: string; author: { login: string } | null }[];
  } | null;
  // Check + status contexts for the head commit, fetched inline via
  // statusCheckRollup so readiness needs a single GraphQL request per PR
  // instead of extra per-check REST calls. Optional/nullable so a token
  // without "Checks: read" (fields nulled) degrades to the mergeStateStatus
  // fallback in computeMergeReadiness.
  commits?: {
    nodes: {
      commit: {
        statusCheckRollup: {
          contexts: { nodes: CheckContextNode[] };
        } | null;
      };
    }[];
  } | null;
}

// The fields we read off each pull request. Inlined per-alias into a batched
// query (see buildReadinessBatchQuery) so many PRs resolve in one request.
const READINESS_FIELDS = `
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
      comments(first: 1) {
        nodes { author { login } url }
      }
    }
    pageInfo { hasNextPage }
  }
  comments(first: 30) {
    nodes { id author { login } }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                checkSuite { app { databaseId } }
              }
              ... on StatusContext {
                context
                state
              }
            }
          }
        }
      }
    }
  }
`;

// GitHub GraphQL lets us query many PRs in one request via aliases. Chunking
// keeps each request's response bounded and limits the blast radius if one
// errors. ~12 PRs/request turns ~80 round trips into a handful — the dominant
// win on a high-latency connection, where round-trip count, not payload, rules.
const READINESS_CHUNK_SIZE = 12;

type ReadinessBatchResult = Record<string, { pullRequest: PullRequestReadinessData | null } | null>;
type CommentBodyBatchResult = Record<string, { body: string } | null>;

function buildReadinessBatchQuery(targets: { owner: string; repo: string; number: number }[]): string {
  // owner/repo come from GitHub and are restricted to [A-Za-z0-9-_.]; number is
  // an int. JSON.stringify yields a valid GraphQL string literal for the names.
  const aliases = targets.map((t, j) =>
    `pr${j}: repository(owner: ${JSON.stringify(t.owner)}, name: ${JSON.stringify(t.repo)}) {\n` +
    `  pullRequest(number: ${t.number}) { ${READINESS_FIELDS} }\n}`
  );
  return `query {\n${aliases.join("\n")}\n}`;
}

function buildCommentBodiesQuery(commentIds: string[]): string {
  const aliases = commentIds.map((id, j) =>
    `c${j}: node(id: ${JSON.stringify(id)}) { ... on IssueComment { body } }`
  );
  return `query {\n${aliases.join("\n")}\n}`;
}

export async function enrichMergeReadiness(
  octokit: Octokit,
  prs: RawGitHubPR[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const openPrs = prs.filter(pr => pr.state === "open" && !pr.merged);

  // Skip PRs whose head commit is unchanged and whose readiness has already
  // settled: an unchanged updatedAt means no new push (same SHA), and checks
  // for a fixed SHA don't move once terminal, so the cached readiness/trunk/
  // checks/bug-bot on the reused raw PR is still accurate. Only re-query PRs
  // that are new/changed or still in flight. (Reused PRs carry prior readiness;
  // freshly fetched ones don't — see fetchRawAuthoredPRs.)
  const toEnrich = openPrs.filter(needsReadinessRefresh);

  // Reused PRs are already "done" for progress purposes.
  let enriched = openPrs.length - toEnrich.length;
  onProgress?.(enriched, openPrs.length);

  // Resolve each PR's number + base-branch rules first (rules are cached per
  // branch, so this is mostly cache hits and only a few real requests).
  const targets = await Promise.all(toEnrich.map(async pr => {
    const number = getPullNumber(pr.url);
    if (!number || !pr.baseBranch) return { pr, number: null as number | null, rules: null as BranchRules | null };
    const rules = await fetchBranchRules(octokit, pr.owner, pr.repo, pr.baseBranch);
    return { pr, number, rules };
  }));

  // Batch the readiness queries across PRs via GraphQL aliases.
  const chunks: (typeof targets)[] = [];
  for (let i = 0; i < targets.length; i += READINESS_CHUNK_SIZE) {
    chunks.push(targets.slice(i, i + READINESS_CHUNK_SIZE));
  }

  // PRs with a Trunk sticky comment, paired with that comment's node id. We
  // only fetch the body (a big markdown table) for these, in a second pass.
  const trunkTargets: { pr: RawGitHubPR; commentId: string }[] = [];

  await Promise.all(chunks.map(async chunk => {
    const fetchable = chunk.filter(t => t.number != null) as { pr: RawGitHubPR; number: number; rules: BranchRules | null }[];
    const data = fetchable.length
      ? await fetchReadinessBatch(octokit, fetchable.map(t => ({ owner: t.pr.owner, repo: t.pr.repo, number: t.number })))
      : {};
    let k = 0;
    for (const t of chunk) {
      if (t.number == null) {
        applyUnknownReadiness(t.pr, "readiness unavailable");
        continue;
      }
      const pullRequest = data[`pr${k}`]?.pullRequest ?? null;
      applyReadinessData(t.pr, pullRequest, t.rules);
      const trunkComment = (pullRequest?.comments?.nodes ?? []).find(
        c => c.author != null && TRUNK_BOT_LOGINS.includes(c.author.login)
      );
      if (trunkComment) trunkTargets.push({ pr: t.pr, commentId: trunkComment.id });
      k++;
    }
    enriched += chunk.length;
    onProgress?.(enriched, openPrs.length);
  }));

  // Second pass: fetch just the Trunk sticky bodies and parse merge state.
  await enrichTrunkStatus(octokit, trunkTargets);

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

// Trunk queue states that change without a new commit — always re-check these.
const ACTIVE_TRUNK_STATES = new Set(["submitted", "waiting_batch", "testing"]);

// How long a PR's head SHA (via updatedAt) must be stable before we treat even
// still-pending checks as settled. CI finishes well within this; a pending
// check older than this is effectively stuck awaiting a human action (review,
// approval), and any such action bumps updatedAt and forces a re-fetch anyway.
const PENDING_SETTLE_MS = 120 * 60 * 1000;

// Whether a PR needs its readiness re-queried this sync. An unchanged updatedAt
// means no new push (same head SHA), so cached readiness/trunk/checks/bug-bot
// is reused unless something can still move on that SHA:
//   - readiness was never resolved (new/changed PR),
//   - it's sitting in the Trunk merge queue (state advances on its own),
//   - checks are non-terminal AND the SHA changed recently (CI may still finish).
function needsReadinessRefresh(pr: RawGitHubPR): boolean {
  const readiness = pr.mergeReadiness;
  if (!readiness || readiness.state === "unknown") return true;
  if (pr.trunk && ACTIVE_TRUNK_STATES.has(pr.trunk.state)) return true;

  const checks = readiness.requiredChecksState;
  if (checks === "SUCCESS" || checks === "FAILURE") return false;

  // Non-terminal checks: re-check only while the SHA is recent enough that CI
  // could still be running; once it's been stable past PENDING_SETTLE_MS, reuse.
  const ageMs = Date.now() - new Date(pr.updatedAt).getTime();
  return !(ageMs > PENDING_SETTLE_MS);
}

function applyReadinessData(pr: RawGitHubPR, pullRequest: PullRequestReadinessData | null, rules: BranchRules | null): void {
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
  // pr.trunk is set by the second-pass enrichTrunkStatus, which fetches only
  // the Trunk sticky comment body rather than every comment body here.

  // Unresolved bug-bot threads come from the same reviewThreads the readiness
  // query already fetches — no separate per-PR request. Set before the rules
  // gate so a failed rules fetch doesn't wipe this either.
  const bugBotUrls: string[] = [];
  for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
    if (thread.isResolved) continue;
    const first = thread.comments?.nodes?.[0];
    if (first?.author?.login !== BUG_BOT_LOGIN) continue;
    if (first.url) bugBotUrls.push(first.url);
  }
  pr.bugBotThreadUrls = bugBotUrls;
  pr.bugBotThreadCount = bugBotUrls.length;

  if (!rules) {
    applyUnknownReadiness(pr, "readiness unavailable");
    return;
  }

  // Contexts ride along on the readiness query (statusCheckRollup) — no extra
  // REST round trips. A token without "Checks: read" gets these nulled, which
  // reads as PENDING and falls back to mergeStateStatus in computeMergeReadiness.
  const contexts = pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  pr.mergeReadiness = computeMergeReadiness(pr, pullRequest, rules, contexts);
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

async function fetchReadinessBatch(
  octokit: Octokit,
  targets: { owner: string; repo: string; number: number }[]
): Promise<ReadinessBatchResult> {
  const query = buildReadinessBatchQuery(targets);
  try {
    return await octokit.graphql<ReadinessBatchResult>(query);
  } catch (error) {
    // A partial payload (e.g. checks forbidden on some PRs) rides along on the
    // error; salvage it so the readable PRs still enrich.
    return graphqlErrorData<ReadinessBatchResult>(error) ?? {};
  }
}

// Fetch Trunk sticky comment bodies (batched by node id) and set pr.trunk. This
// is the only place we pull comment bodies — everything else works off authors.
async function enrichTrunkStatus(
  octokit: Octokit,
  targets: { pr: RawGitHubPR; commentId: string }[]
): Promise<void> {
  if (targets.length === 0) return;

  const chunks: (typeof targets)[] = [];
  for (let i = 0; i < targets.length; i += READINESS_CHUNK_SIZE) {
    chunks.push(targets.slice(i, i + READINESS_CHUNK_SIZE));
  }

  await Promise.all(chunks.map(async chunk => {
    let data: CommentBodyBatchResult;
    try {
      data = await octokit.graphql<CommentBodyBatchResult>(buildCommentBodiesQuery(chunk.map(t => t.commentId)));
    } catch (error) {
      data = graphqlErrorData<CommentBodyBatchResult>(error) ?? {};
    }
    chunk.forEach((t, j) => {
      t.pr.trunk = parseTrunkComment(data[`c${j}`]?.body);
    });
  }));
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
