import { Octokit } from "@octokit/rest";
import { getCached, setCache } from "@/lib/cache";
import type { GitHubPR } from "@/types";

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
  draft: boolean;
  merged: boolean;
  state: string;
  url: string;
  updatedAt: string;
  body: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews: { login: string; state: string }[];
  userDisplayName?: string; // resolved from GitHub API, present on review PRs
  requestedReviewers?: string[]; // individual logins requested for review
  requestedTeams?: string[]; // team slugs requested for review
}

export interface RawGitHubResult {
  prs: RawGitHubPR[];
  rateLimit?: GitHubRateLimit;
  searchRateLimit?: GitHubRateLimit;
}

// Transform raw PR to the app's GitHubPR type
export function transformPR(raw: RawGitHubPR): GitHubPR {
  let reviewDecision: string | null = null;
  if (!raw.draft && raw.reviews.length > 0) {
    const byUser = new Map<string, string>();
    for (const r of raw.reviews) {
      if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
        byUser.set(r.login, r.state);
      }
    }
    if ([...byUser.values()].some(s => s === "CHANGES_REQUESTED")) {
      reviewDecision = "CHANGES_REQUESTED";
    } else if (byUser.size > 0 && [...byUser.values()].every(s => s === "APPROVED")) {
      reviewDecision = "APPROVED";
    } else if (byUser.size > 0) {
      reviewDecision = "REVIEW_REQUIRED";
    }
  }

  return {
    id: raw.id,
    title: raw.title,
    author: raw.userDisplayName ?? raw.userLogin,
    authorLogin: raw.userLogin,
    repo: `${raw.owner}/${raw.repo}`,
    branch: raw.branch,
    draft: raw.draft,
    merged: raw.merged,
    closed: raw.state === "closed" && !raw.merged,
    url: raw.url,
    updatedAt: raw.updatedAt,
    reviewDecision,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    checksState: null,
    requestedReviewers: raw.requestedReviewers ?? [],
    requestedTeams: raw.requestedTeams ?? [],
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
  previousPrs?: RawGitHubPR[]
): Promise<RawGitHubResult> {
  const octokit = new Octokit({ auth: accessToken });

  // Phase 1: REST search for open + merged + closed PRs (uses search rate limit, not core/graphql)
  const [openRes, mergedRes, closedRes] = await Promise.all([
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
  ]);

  // Read search rate limit from the last search response headers
  const searchHeaders = closedRes.headers;
  const searchRemaining = Number(searchHeaders["x-ratelimit-remaining"]);
  const searchLimit = Number(searchHeaders["x-ratelimit-limit"]);
  const searchReset = Number(searchHeaders["x-ratelimit-reset"]);

  // Deduplicate
  const seen = new Set<number>();
  const searchItems = [...openRes.data.items, ...mergedRes.data.items, ...closedRes.data.items].filter(item => {
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

  // Phase 3: Fetch full details only for changed PRs via REST (1 core point each)
  // Get core rate limit before
  let coreBefore: number | undefined;
  try {
    const rlBefore = await octokit.rest.rateLimit.get();
    coreBefore = rlBefore.data.resources.core.remaining;
  } catch { /* ignore */ }

  const freshPrs = new Map<number, RawGitHubPR>();

  // Fetch in parallel, batches of 10 to avoid overwhelming
  for (let i = 0; i < needFetch.length; i += 10) {
    const batch = needFetch.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (item) => {
        const [owner, repo] = item.repository_url.split("/").slice(-2);
        try {
          const { data: pr } = await octokit.rest.pulls.get({
            owner, repo, pull_number: item.number,
          });

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
            draft: pr.draft ?? false,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            updatedAt: pr.updated_at,
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
            draft: item.draft ?? false,
            merged: item.pull_request?.merged_at != null,
            state: item.state,
            url: item.html_url,
            updatedAt: item.updated_at,
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

  // Get actual core cost from rate limit delta
  let rateLimit: RawGitHubResult["rateLimit"];
  let searchRateLimit: RawGitHubResult["searchRateLimit"];
  try {
    const rlAfter = await octokit.rest.rateLimit.get();
    const core = rlAfter.data.resources.core;
    const actualCost = coreBefore != null ? coreBefore - core.remaining : needFetch.length * 2;
    rateLimit = {
      cost: actualCost,
      remaining: core.remaining,
      limit: core.limit,
      resetAt: new Date(core.reset * 1000).toISOString(),
    };
    console.log(`[GitHub] Core cost: ${actualCost} (${core.remaining}/${core.limit}) | Search: ${searchRemaining}/${searchLimit}`);
  } catch { /* ignore */ }

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
          return {
            id: pr.id,
            title: pr.title,
            userLogin: pr.user?.login ?? "",
            owner,
            repo,
            branch: pr.head.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            body: pr.body ?? null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            reviews: [],
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
            draft: pr.draft ?? false,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            body: pr.body ?? null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            reviews: [],
            requestedReviewers: (pr.requested_reviewers ?? []).map((r: any) => r.login),
            requestedTeams: (pr.requested_teams ?? []).map((t: any) => t.slug),
          } satisfies RawGitHubPR;
        } catch {
          return {
            id: item.id,
            title: item.title,
            userLogin: item.user?.login ?? "",
            owner,
            repo,
            branch: "",
            draft: item.draft ?? false,
            merged: false,
            state: "open",
            url: item.html_url,
            updatedAt: item.updated_at,
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

  // Get authenticated user login
  let viewerLogin = "";
  try {
    const { data: viewer } = await octokit.rest.users.getAuthenticated();
    viewerLogin = viewer.login;
  } catch { /* ignore */ }

  return { prs: allPrs, viewerLogin };
}

export function transformReviewPRs(raw: RawGitHubPR[]): GitHubPR[] {
  return raw.map(transformPR);
}
