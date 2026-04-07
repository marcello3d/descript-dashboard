import { Octokit } from "@octokit/rest";
import type { GitHubPR } from "@/types";

export interface GitHubResult {
  prs: GitHubPR[];
  rateLimit?: { cost: number; remaining: number; limit: number; resetAt: string };
}

// Strategy to minimize rate limit cost:
// 1. REST search to get PR numbers + updatedAt (uses separate "search" rate limit, not graphql)
// 2. Diff against previous results — skip unchanged PRs
// 3. REST pulls.get only for new/changed PRs (1 core point each)
// Best case (nothing changed): 2 search points (from search bucket). Worst case: 2 + N core points.
export async function fetchAuthoredPRs(
  accessToken: string,
  previousPrs?: GitHubPR[]
): Promise<GitHubResult> {
  const octokit = new Octokit({ auth: accessToken });

  // Phase 1: REST search for open + merged PRs (uses search rate limit, not core/graphql)
  const [openRes, mergedRes] = await Promise.all([
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
  ]);

  // Deduplicate
  const seen = new Set<number>();
  const searchItems = [...openRes.data.items, ...mergedRes.data.items].filter(item => {
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

          // Get review decision for open, non-draft PRs
          let reviewDecision: string | null = null;
          if (!pr.draft && !pr.merged && pr.state === "open") {
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
            repo: `${owner}/${repo}`,
            branch: pr.head.ref,
            draft: pr.draft ?? false,
            merged: pr.merged,
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
            repo: `${owner}/${repo}`,
            branch: "",
            draft: item.draft ?? false,
            merged: item.pull_request?.merged_at != null,
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

  // Get actual cost from core rate limit delta
  let rateLimit: GitHubResult["rateLimit"];
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
    console.log(`[GitHub] Actual core cost: ${actualCost} | ${core.remaining}/${core.limit} remaining`);
  } catch { /* ignore */ }

  return { prs: allPrs, rateLimit };
}
