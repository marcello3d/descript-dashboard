import { Octokit } from "@octokit/rest";
import type { GitHubPR } from "@/types";

// Cache GitHub login -> display name (persists across requests in the same process)
const userNameCache = new Map<string, string>();

async function resolveUserNames(octokit: Octokit, logins: string[]): Promise<void> {
  const unknown = logins.filter(l => l && !userNameCache.has(l));
  const unique = [...new Set(unknown)];
  if (unique.length === 0) return;

  await Promise.all(
    unique.map(async (login) => {
      try {
        const { data } = await octokit.rest.users.getByUsername({ username: login });
        userNameCache.set(login, data.name ?? login);
      } catch {
        userNameCache.set(login, login);
      }
    })
  );
}

function displayName(login: string): string {
  return userNameCache.get(login) ?? login;
}

export interface GitHubRateLimit {
  cost: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface GitHubResult {
  prs: GitHubPR[];
  rateLimit?: GitHubRateLimit;
  searchRateLimit?: GitHubRateLimit;
}

// Strategy to minimize rate limit cost:
// 1. REST search to get PR numbers + updatedAt (uses separate "search" rate limit, not graphql)
// 2. Diff against previous results — skip unchanged PRs
// 3. REST pulls.get only for new/changed PRs (1 core point each)
// Best case (nothing changed): 3 search points (from search bucket). Worst case: 3 + N core points.
export async function fetchAuthoredPRs(
  accessToken: string,
  previousPrs?: GitHubPR[]
): Promise<GitHubResult> {
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
  const prevById = new Map<number, GitHubPR>();
  if (previousPrs) {
    for (const pr of previousPrs) prevById.set(pr.id, pr);
  }

  const needFetch: typeof searchItems = [];
  const reusable = new Map<number, GitHubPR>();

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

  const freshPrs = new Map<number, GitHubPR>();

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

          // Get review decision for non-draft PRs (open and merged)
          let reviewDecision: string | null = null;
          if (!pr.draft) {
            try {
              const { data: reviews } = await octokit.rest.pulls.listReviews({
                owner, repo, pull_number: item.number, per_page: 100,
              });
              const byUser = new Map<string, string>();
              for (const r of reviews) {
                if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
                  byUser.set(r.user?.login ?? "", r.state);
                }
              }
              if ([...byUser.values()].some(s => s === "CHANGES_REQUESTED")) {
                reviewDecision = "CHANGES_REQUESTED";
              } else if (byUser.size > 0 && [...byUser.values()].every(s => s === "APPROVED")) {
                reviewDecision = "APPROVED";
              } else {
                reviewDecision = "REVIEW_REQUIRED";
              }
            } catch { /* ignore review fetch errors */ }
          }

          return {
            id: item.id,
            title: pr.title,
            author: pr.user?.login ?? "",
            repo: `${owner}/${repo}`,
            branch: pr.head.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            closed: pr.state === "closed" && !pr.merged,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            reviewDecision,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            checksState: null,
          } satisfies GitHubPR;
        } catch {
          // Fallback to search data
          const [owner, repo] = item.repository_url.split("/").slice(-2);
          return {
            id: item.id,
            title: item.title,
            author: item.user?.login ?? "",
            repo: `${owner}/${repo}`,
            branch: "",
            draft: item.draft ?? false,
            merged: item.pull_request?.merged_at != null,
            closed: item.state === "closed" && item.pull_request?.merged_at == null,
            url: item.html_url,
            updatedAt: item.updated_at,
            reviewDecision: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            checksState: null,
          } satisfies GitHubPR;
        }
      })
    );
    for (const pr of results) {
      freshPrs.set(pr.id, pr);
    }
  }

  // Merge in search order
  const allPrs: GitHubPR[] = [];
  for (const item of searchItems) {
    const pr = freshPrs.get(item.id) ?? reusable.get(item.id);
    if (pr) allPrs.push(pr);
  }

  // Get actual core cost from rate limit delta
  let rateLimit: GitHubResult["rateLimit"];
  let searchRateLimit: GitHubResult["searchRateLimit"];
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
export async function fetchPrsByUrls(
  accessToken: string,
  urls: string[]
): Promise<GitHubPR[]> {
  if (urls.length === 0) return [];
  const octokit = new Octokit({ auth: accessToken });
  const results: GitHubPR[] = [];

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
            author: pr.user?.login ?? "",
            repo: `${owner}/${repo}`,
            branch: pr.head.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            closed: pr.state === "closed" && !pr.merged,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            reviewDecision: null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            checksState: null,
          } satisfies GitHubPR;
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

export async function fetchReviewRequestedPRs(
  accessToken: string,
  previousPrs?: GitHubPR[]
): Promise<{ prs: GitHubPR[] }> {
  const octokit = new Octokit({ auth: accessToken });

  const res = await octokit.rest.search.issuesAndPullRequests({
    q: "is:open is:pr review-requested:@me",
    sort: "updated",
    per_page: 50,
  });

  const searchItems = res.data.items;

  // Diff against previous results
  const prevById = new Map<number, GitHubPR>();
  if (previousPrs) {
    for (const pr of previousPrs) prevById.set(pr.id, pr);
  }

  const needFetch: typeof searchItems = [];
  const reusable = new Map<number, GitHubPR>();

  for (const item of searchItems) {
    const prev = prevById.get(item.id);
    if (prev && prev.updatedAt === item.updated_at) {
      reusable.set(item.id, prev);
    } else {
      needFetch.push(item);
    }
  }

  const freshPrs = new Map<number, GitHubPR>();

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
            author: pr.user?.login ?? "",
            repo: `${owner}/${repo}`,
            branch: pr.head.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
            closed: false,
            url: pr.html_url,
            updatedAt: pr.updated_at,
            reviewDecision: null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
            checksState: null,
          } satisfies GitHubPR;
        } catch {
          const [owner, repo] = item.repository_url.split("/").slice(-2);
          return {
            id: item.id,
            title: item.title,
            author: item.user?.login ?? "",
            repo: `${owner}/${repo}`,
            branch: "",
            draft: item.draft ?? false,
            merged: false,
            closed: false,
            url: item.html_url,
            updatedAt: item.updated_at,
            reviewDecision: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            checksState: null,
          } satisfies GitHubPR;
        }
      })
    );
    for (const pr of results) freshPrs.set(pr.id, pr);
  }

  const allPrs: GitHubPR[] = [];
  for (const item of searchItems) {
    const pr = freshPrs.get(item.id) ?? reusable.get(item.id);
    if (pr) allPrs.push(pr);
  }

  // Resolve GitHub logins to display names
  await resolveUserNames(octokit, allPrs.map(pr => pr.author));
  for (const pr of allPrs) {
    pr.author = displayName(pr.author);
  }

  return { prs: allPrs };
}
