import { Octokit } from "@octokit/rest";
import { getCached, setCache } from "@/lib/cache";
import { enrichMergeReadiness } from "@/lib/github-merge-readiness";
import type { GitHubMergeReadiness, GitHubPR, TrunkStatus } from "@/types";

const USER_NAME_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

async function resolveUserNames(octokit: Octokit, logins: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(logins.filter(Boolean))];
  const names = new Map<string, string>();

  await Promise.all(
    unique.map(async (login) => {
      const cacheKey = `github:user:${login}`;
      const cached = getCached<string>(cacheKey);
      if (cached !== null) {
        if (cached !== login) names.set(login, cached);
        return;
      }
      try {
        const { data } = await octokit.rest.users.getByUsername({ username: login });
        const name = data.name ?? login;
        setCache(cacheKey, name, USER_NAME_CACHE_TTL);
        if (name !== login) names.set(login, name);
      } catch {
        setCache(cacheKey, login, USER_NAME_CACHE_TTL);
      }
    })
  );

  return names;
}

export interface GitHubRateLimit {
  cost: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

// Raw PR data — JSON-serializable, cached as-is
export interface RawGitHubPR {
  id: number;
  title: string;
  userLogin: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  draft: boolean;
  merged: boolean;
  state: string;
  url: string;
  updatedAt: string;
  mergedAt: string | null;
  body: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews: { login: string; state: string }[];
  userDisplayName?: string; // resolved from GitHub API, present on review PRs
  requestedReviewers?: string[]; // individual logins requested for review
  requestedTeams?: { slug: string; name: string }[]; // teams requested for review
  bugBotThreadCount?: number;
  bugBotThreadUrls?: string[];
  reviewDecision?: string | null;
  checksState?: string | null;
  mergeReadiness?: GitHubMergeReadiness;
  trunk?: TrunkStatus | null;
}

export interface RawGitHubResult {
  prs: RawGitHubPR[];
  rateLimit?: GitHubRateLimit;
  searchRateLimit?: GitHubRateLimit;
}

// claude[bot] PR bodies include a Slack thread link and a Claude Code session link
// (e.g. "[Slack thread](https://*.slack.com/...)" and "https://claude.ai/code/session_...").
// Bodies are HTML-escaped, so decode &amp; back to & so the hrefs work.
function extractClaudeLinks(body: string | null | undefined): {
  slackThreadUrl: string | null;
  claudeSessionUrl: string | null;
} {
  if (!body) return { slackThreadUrl: null, claudeSessionUrl: null };
  const slack = body.match(/https:\/\/[a-z0-9-]+\.slack\.com\/[^\s)\]>]+/i);
  const session = body.match(/https:\/\/claude\.ai\/code\/[^\s)\]>]+/i);
  const clean = (u: string | undefined) => (u ? u.replace(/&amp;/g, "&") : null);
  return { slackThreadUrl: clean(slack?.[0]), claudeSessionUrl: clean(session?.[0]) };
}

// GitHub suffixes every GitHub App account's login with "[bot]" (e.g.
// claude[bot], cursor[bot]) — how we tell App-authored PRs and reviews apart
// from human ones.
export function isBotLogin(login: string): boolean {
  return login.endsWith("[bot]");
}

// Latest review state per reviewer. listReviews returns reviews chronologically,
// so the last APPROVED/CHANGES_REQUESTED entry for a login is their current one.
function latestReviewStates(reviews: { login: string; state: string }[]): Map<string, string> {
  const byUser = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
      byUser.set(r.login, r.state);
    }
  }
  return byUser;
}

// Bot-authored PRs (e.g. claude[bot]) require two *human* approvals before the
// repo will merge them — enforced by a CI check, but GitHub's own reviewDecision
// can read APPROVED off a single approval. Count distinct human reviewers whose
// latest review is an approval.
const REQUIRED_BOT_HUMAN_APPROVALS = 2;

function humanApprovalCount(reviews: { login: string; state: string }[]): number {
  let count = 0;
  for (const [login, state] of latestReviewStates(reviews)) {
    if (state === "APPROVED" && !isBotLogin(login)) count++;
  }
  return count;
}

// Transform raw PR to the app's GitHubPR type
export function transformPR(raw: RawGitHubPR): GitHubPR {
  let reviewDecision: string | null = raw.reviewDecision ?? null;
  if (!reviewDecision && !raw.draft && raw.reviews.length > 0) {
    const states = latestReviewStates(raw.reviews);
    if ([...states.values()].some(s => s === "CHANGES_REQUESTED")) {
      reviewDecision = "CHANGES_REQUESTED";
    } else if (states.size > 0) {
      reviewDecision = "REVIEW_REQUIRED";
    }
  }

  // A bot-authored PR isn't "approved" until two humans have approved it, no
  // matter what GitHub's reviewDecision says. Downgrade to REVIEW_REQUIRED so the
  // UI keeps showing it as waiting on review rather than ready to merge.
  if (
    reviewDecision === "APPROVED" &&
    isBotLogin(raw.userLogin) &&
    humanApprovalCount(raw.reviews) < REQUIRED_BOT_HUMAN_APPROVALS
  ) {
    reviewDecision = "REVIEW_REQUIRED";
  }

  return {
    id: raw.id,
    title: raw.title,
    author: raw.userDisplayName ?? raw.userLogin,
    authorLogin: raw.userLogin,
    repo: `${raw.owner}/${raw.repo}`,
    branch: raw.branch,
    baseBranch: raw.baseBranch,
    draft: raw.draft,
    merged: raw.merged,
    closed: raw.state === "closed" && !raw.merged,
    url: raw.url,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt ?? null,
    reviewDecision,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    checksState: raw.checksState ?? null,
    requestedReviewers: raw.requestedReviewers ?? [],
    requestedTeams: raw.requestedTeams ?? [],
    bugBotThreadCount: raw.bugBotThreadUrls?.length ?? raw.bugBotThreadCount ?? 0,
    bugBotThreadUrls: raw.bugBotThreadUrls ?? [],
    ...extractClaudeLinks(raw.body),
    mergeReadiness: raw.mergeReadiness ?? {
      ready: false,
      state: "unknown",
      reasons: raw.state === "open" && !raw.merged ? ["readiness unavailable"] : [],
      mergeable: null,
      mergeStateStatus: null,
      requiredChecksState: null,
      requiredChecks: [],
    },
    trunk: raw.trunk ?? null,
  };
}

export function transformPRs(raw: RawGitHubPR[]): GitHubPR[] {
  return raw.map(transformPR);
}

// Strategy to minimize rate limit cost:
// 1. REST search to get PR numbers + updatedAt (uses separate "search" rate limit, not graphql)
// 2. Diff against previous results — skip unchanged PRs
// 3. REST pulls.get only for new/changed PRs (1 core point each)
// Best case (nothing changed): 3 search points (from search bucket). Worst case: 3 + N core points.
export async function fetchRawAuthoredPRs(
  accessToken: string,
  previousPrs?: RawGitHubPR[],
  onReadinessProgress?: (done: number, total: number) => void
): Promise<RawGitHubResult> {
  const octokit = new Octokit({ auth: accessToken });

  // Phase 1: REST search for open + merged + closed PRs (uses search rate limit, not core/graphql)
  // Also pull open PRs the claude[bot] app opened on our behalf (we're involved but not the author).
  const [openRes, mergedRes, closedRes, claudeRes] = await Promise.all([
    octokit.rest.search.issuesAndPullRequests({
      q: "is:open is:pr author:@me",
      sort: "updated",
      per_page: 50,
    }),
    octokit.rest.search.issuesAndPullRequests({
      q: "is:merged is:pr author:@me",
      sort: "updated",
      per_page: 20,
    }),
    octokit.rest.search.issuesAndPullRequests({
      q: "is:unmerged is:closed is:pr author:@me",
      sort: "updated",
      per_page: 20,
    }),
    octokit.rest.search.issuesAndPullRequests({
      q: "is:open is:pr author:app/claude involves:@me archived:false",
      sort: "updated",
      per_page: 30,
    }),
  ]);

  // Read search rate limit from the last search response headers
  const searchHeaders = claudeRes.headers;
  const searchRemaining = Number(searchHeaders["x-ratelimit-remaining"]);
  const searchLimit = Number(searchHeaders["x-ratelimit-limit"]);
  const searchReset = Number(searchHeaders["x-ratelimit-reset"]);

  // Deduplicate
  const seen = new Set<number>();
  const searchItems = [...openRes.data.items, ...mergedRes.data.items, ...closedRes.data.items, ...claudeRes.data.items].filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  // Phase 2: Diff against previous results
  const prevById = new Map<number, RawGitHubPR>();
  if (previousPrs) {
    for (const pr of previousPrs) prevById.set(pr.id, pr);
  }

  const needFetch: typeof searchItems = [];
  const reusable = new Map<number, RawGitHubPR>();

  for (const item of searchItems) {
    const prev = prevById.get(item.id);
    if (prev && prev.updatedAt === item.updated_at) {
      reusable.set(item.id, prev);
    } else {
      needFetch.push(item);
    }
  }

  console.log(`[GitHub] ${searchItems.length} PRs: ${reusable.size} unchanged, ${needFetch.length} need refresh`);

  // Phase 3: Fetch full details only for changed PRs via REST (1 core point each).
  // Core rate limit is read off the response headers of these calls rather than
  // a dedicated rateLimit.get probe (which would add two serial round trips).
  const freshPrs = new Map<number, RawGitHubPR>();
  let coreHeaders: Record<string, string | number> | undefined;

  // Fetch in parallel, batches of 10 to avoid overwhelming
  for (let i = 0; i < needFetch.length; i += 10) {
    const batch = needFetch.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (item) => {
        const [owner, repo] = item.repository_url.split("/").slice(-2);
        try {
          const { data: pr, headers } = await octokit.rest.pulls.get({
            owner, repo, pull_number: item.number,
          });
          coreHeaders = headers as Record<string, string | number>;

          // Fetch reviews for non-draft PRs
          let reviews: { login: string; state: string }[] = [];
          if (!pr.draft) {
            try {
              const { data: rawReviews } = await octokit.rest.pulls.listReviews({
                owner, repo, pull_number: item.number, per_page: 100,
              });
              reviews = rawReviews
                .filter(r => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
                .map(r => ({ login: r.user?.login ?? "", state: r.state }));
            } catch { /* ignore review fetch errors */ }
          }

          return {
            id: item.id,
            title: pr.title,
            userLogin: pr.user?.login ?? "",
            owner,
            repo,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at ?? null,
            body: pr.body ?? null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            reviews,
          } satisfies RawGitHubPR;
        } catch {
          // Fallback to search data
          return {
            id: item.id,
            title: item.title,
            userLogin: item.user?.login ?? "",
            owner,
            repo,
            branch: "",
            baseBranch: "",
            draft: item.draft ?? false,
            merged: item.pull_request?.merged_at != null,
            state: item.state,
            url: item.html_url,
            updatedAt: item.updated_at,
            mergedAt: item.pull_request?.merged_at ?? null,
            body: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            reviews: [],
          } satisfies RawGitHubPR;
        }
      })
    );
    for (const pr of results) {
      freshPrs.set(pr.id, pr);
    }
  }

  // Merge in search order
  const allPrs: RawGitHubPR[] = [];
  for (const item of searchItems) {
    const pr = freshPrs.get(item.id) ?? reusable.get(item.id);
    if (pr) allPrs.push(pr);
  }

  await enrichMergeReadiness(octokit, allPrs, onReadinessProgress);

  // Core rate limit from the detail-fetch response headers (no extra probe).
  // When nothing changed there are no core calls, so leave it undefined and let
  // the caller keep the last-known value. Cost is approximated from the number
  // of changed PRs (pulls.get + listReviews each) since we no longer diff a
  // before/after remaining count.
  let rateLimit: RawGitHubResult["rateLimit"];
  let searchRateLimit: RawGitHubResult["searchRateLimit"];
  if (coreHeaders) {
    const remaining = Number(coreHeaders["x-ratelimit-remaining"]);
    const limit = Number(coreHeaders["x-ratelimit-limit"]);
    const reset = Number(coreHeaders["x-ratelimit-reset"]);
    if (!isNaN(remaining) && !isNaN(limit)) {
      rateLimit = {
        cost: needFetch.length * 2,
        remaining,
        limit,
        resetAt: new Date(reset * 1000).toISOString(),
      };
    }
  }

  // Search rate limit from response headers (more accurate than rateLimit.get())
  if (!isNaN(searchRemaining) && !isNaN(searchLimit)) {
    searchRateLimit = {
      cost: 2,
      remaining: searchRemaining,
      limit: searchLimit,
      resetAt: new Date(searchReset * 1000).toISOString(),
    };
  }

  return { prs: allPrs, rateLimit, searchRateLimit };
}

// Fetch PRs by their GitHub URLs (e.g. from Linear attachments)
// Returns only the ones we can successfully fetch (1 core point each)
export async function fetchRawPrsByUrls(
  accessToken: string,
  urls: string[]
): Promise<RawGitHubPR[]> {
  if (urls.length === 0) return [];
  const octokit = new Octokit({ auth: accessToken });
  const results: RawGitHubPR[] = [];

  // Parse owner/repo/number from URLs like https://github.com/owner/repo/pull/123
  const parsed = urls.map(url => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return match ? { owner: match[1], repo: match[2], number: Number(match[3]), url } : null;
  }).filter(Boolean) as { owner: string; repo: string; number: number; url: string }[];

  for (let i = 0; i < parsed.length; i += 10) {
    const batch = parsed.slice(i, i + 10);
    const fetched = await Promise.all(
      batch.map(async ({ owner, repo, number }) => {
        try {
          const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });

          // Reviews are only needed to gate the bot two-human-approval rule, so
          // fetch them just for open, non-draft, bot-authored PRs (otherwise the
          // gate can't confirm approvals and would keep the PR showing "needs
          // review"). Human-authored PRs skip this to save an API call.
          let reviews: { login: string; state: string }[] = [];
          if (!pr.draft && !pr.merged && isBotLogin(pr.user?.login ?? "")) {
            try {
              const { data: rawReviews } = await octokit.rest.pulls.listReviews({
                owner, repo, pull_number: number, per_page: 100,
              });
              reviews = rawReviews
                .filter(r => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
                .map(r => ({ login: r.user?.login ?? "", state: r.state }));
            } catch { /* ignore review fetch errors */ }
          }

          return {
            id: pr.id,
            title: pr.title,
            userLogin: pr.user?.login ?? "",
            owner,
            repo,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at ?? null,
            body: pr.body ?? null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            reviews,
          } satisfies RawGitHubPR;
        } catch {
          return null;
        }
      })
    );
    for (const pr of fetched) {
      if (pr) results.push(pr);
    }
  }

  await enrichMergeReadiness(octokit, results);

  return results;
}

// Recently merged PRs the claude[bot] app opened on our behalf — feeds the
// Completed view, which is otherwise Linear-assignment-driven and would miss them.
export async function fetchRawMergedClaudePrs(
  accessToken: string,
  previousPrs?: RawGitHubPR[]
): Promise<RawGitHubPR[]> {
  const octokit = new Octokit({ auth: accessToken });

  const res = await octokit.rest.search.issuesAndPullRequests({
    q: "is:merged is:pr author:app/claude involves:@me archived:false",
    sort: "updated",
    per_page: 20,
  });

  const prevById = new Map<number, RawGitHubPR>();
  for (const pr of previousPrs ?? []) prevById.set(pr.id, pr);

  const results: RawGitHubPR[] = [];
  for (const item of res.data.items) {
    const prev = prevById.get(item.id);
    if (prev && prev.updatedAt === item.updated_at) {
      results.push(prev);
      continue;
    }
    const [owner, repo] = item.repository_url.split("/").slice(-2);
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: item.number });
      results.push({
        id: item.id,
        title: pr.title,
        userLogin: pr.user?.login ?? "",
        owner,
        repo,
        branch: pr.head.ref,
        baseBranch: pr.base.ref,
        draft: pr.draft ?? false,
        merged: pr.merged,
        state: pr.state,
        url: pr.html_url,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at ?? null,
        body: pr.body ?? null,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        reviews: [],
      });
    } catch { /* skip PRs we can't fetch */ }
  }

  return results;
}

export async function fetchRawReviewRequestedPRs(
  accessToken: string,
  previousPrs?: RawGitHubPR[]
): Promise<{ prs: RawGitHubPR[]; viewerLogin: string }> {
  const octokit = new Octokit({ auth: accessToken });

  const res = await octokit.rest.search.issuesAndPullRequests({
    q: "is:open is:pr review-requested:@me",
    sort: "updated",
    per_page: 50,
  });

  const searchItems = res.data.items;

  // Diff against previous results
  const prevById = new Map<number, RawGitHubPR>();
  if (previousPrs) {
    for (const pr of previousPrs) prevById.set(pr.id, pr);
  }

  const needFetch: typeof searchItems = [];
  const reusable = new Map<number, RawGitHubPR>();

  for (const item of searchItems) {
    const prev = prevById.get(item.id);
    if (prev && prev.updatedAt === item.updated_at) {
      reusable.set(item.id, prev);
    } else {
      needFetch.push(item);
    }
  }

  const freshPrs = new Map<number, RawGitHubPR>();

  for (let i = 0; i < needFetch.length; i += 10) {
    const batch = needFetch.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (item) => {
        const [owner, repo] = item.repository_url.split("/").slice(-2);
        try {
          const { data: pr } = await octokit.rest.pulls.get({
            owner, repo, pull_number: item.number,
          });
          return {
            id: item.id,
            title: pr.title,
            userLogin: pr.user?.login ?? "",
            owner,
            repo,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at ?? null,
            body: pr.body ?? null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            reviews: [],
            requestedReviewers: (pr.requested_reviewers ?? []).map((r) => r.login),
            requestedTeams: (pr.requested_teams ?? []).map((t) => ({ slug: t.slug, name: t.name ?? t.slug })),
          } satisfies RawGitHubPR;
        } catch {
          return {
            id: item.id,
            title: item.title,
            userLogin: item.user?.login ?? "",
            owner,
            repo,
            branch: "",
            baseBranch: "",
            draft: item.draft ?? false,
            merged: false,
            state: "open",
            url: item.html_url,
            updatedAt: item.updated_at,
            mergedAt: null,
            body: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            reviews: [],
          } satisfies RawGitHubPR;
        }
      })
    );
    for (const pr of results) freshPrs.set(pr.id, pr);
  }

  const allPrs: RawGitHubPR[] = [];
  for (const item of searchItems) {
    const pr = freshPrs.get(item.id) ?? reusable.get(item.id);
    if (pr) allPrs.push(pr);
  }

  // Resolve GitHub logins to display names and store in raw data
  const names = await resolveUserNames(octokit, allPrs.map(pr => pr.userLogin));
  for (const pr of allPrs) {
    const name = names.get(pr.userLogin);
    if (name) pr.userDisplayName = name;
  }

  const viewerLogin = await octokit.rest.users.getAuthenticated().then(r => r.data.login).catch(() => "");

  return { prs: allPrs, viewerLogin };
}

export function transformReviewPRs(raw: RawGitHubPR[]): GitHubPR[] {
  return raw.map(transformPR);
}

// Lightweight signal for "has anything happened on GitHub that I care about?"
// Uses the /notifications endpoint with If-Modified-Since — a 304 response
// doesn't count against the rate limit, so we can poll this frequently without
// burning quota. `participating=true` filters down to things the viewer is
// directly involved in (review requests, mentions, PR updates on authored PRs).
export interface NotificationSignal {
  modified: boolean;
  lastModified: string;
  pollInterval: number;
}

export async function checkGitHubNotificationSignal(
  token: string,
  lastModified?: string,
): Promise<NotificationSignal | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  let res: Response;
  try {
    res = await fetch("https://api.github.com/notifications?participating=true", { headers });
  } catch {
    return null;
  }

  const pollInterval = parseInt(res.headers.get("X-Poll-Interval") ?? "60", 10);

  if (res.status === 304) {
    return { modified: false, lastModified: lastModified ?? "", pollInterval };
  }
  if (!res.ok) return null;

  const newLastModified = res.headers.get("Last-Modified") ?? lastModified ?? "";
  return { modified: true, lastModified: newLastModified, pollInterval };
}
