import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { fetchAuthoredPRs, fetchReviewRequestedPRs, fetchPrsByUrls } from "@/lib/github";
import { fetchAssignedIssues, fetchSubscribedIssues, fetchIssuesByIdentifiers } from "@/lib/linear";
import { fetchBGAJobs } from "@/lib/cursor";
import { getCached, setCache, logApiCall, dedupe, getApiCallStats, getRecentApiCalls } from "@/lib/cache";
import { buildWorkItems, findMissingLinearIds, findMissingPrUrls } from "@/lib/work-items";
import type { WorkItem, LinearIssue, GitHubPR, CursorAgent } from "@/types";

const CACHE_KEY_GITHUB_REVIEWS = "github:reviewPrs";
const CACHE_KEY_LINEAR_REVIEWS = "linear:reviewIssues";
const CACHE_TTL_GITHUB_REVIEWS = 5 * 60 * 1000;
const CACHE_TTL_LINEAR_REVIEWS = 5 * 60 * 1000;

const CACHE_KEY_LINEAR = "linear:issues";
const CACHE_KEY_LINEAR_RATE = "linear:rateLimit";
const CACHE_KEY_GITHUB = "github:prs";
const CACHE_KEY_GITHUB_RATE = "github:rateLimit";
const CACHE_KEY_CURSOR = "cursor:agents";
const CACHE_KEY_WORK_ITEMS = "work-items";
const CACHE_TTL_LINEAR = 5 * 60 * 1000;
const CACHE_TTL_GITHUB = 5 * 60 * 1000;
const CACHE_TTL_CURSOR = 2 * 60 * 1000;
const CACHE_TTL_ITEMS = 2 * 60 * 1000;

interface RateLimit {
  cost?: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

interface WorkItemsResponse {
  items: WorkItem[];
  reviewPrs: GitHubPR[];
  reviewIssues: LinearIssue[];
  rateLimits: { github?: RateLimit; githubSearch?: RateLimit; linear?: RateLimit };
  errors: string[];
}

export async function GET(request: Request) {
  const bypass = new URL(request.url).searchParams.get("fresh") === "1";

  // Serve items from cache if not bypassing (stats are always fresh)
  let cached = !bypass ? getCached<WorkItemsResponse>(CACHE_KEY_WORK_ITEMS) : null;

  if (!cached) {
    const errors: string[] = [];
    const rateLimits: WorkItemsResponse["rateLimits"] = {};

    // Phase 1: Fetch all services in parallel
    const [linearResult, githubResult, cursorResult, reviewResult, linearReviewResult] = await Promise.all([
      fetchLinear(bypass, errors),
      fetchGitHub(bypass, errors),
      fetchCursor(bypass, errors),
      fetchGitHubReviews(bypass, errors),
      fetchLinearReviews(bypass, errors),
    ]);

    if (linearResult.rateLimit) rateLimits.linear = linearResult.rateLimit;
    if (githubResult.rateLimit) rateLimits.github = githubResult.rateLimit;
    if (githubResult.searchRateLimit) rateLimits.githubSearch = githubResult.searchRateLimit;

    // Phase 2: Build work items
    let items = buildWorkItems(linearResult.issues, githubResult.prs, cursorResult.agents);

    // Phase 3: Look up missing Linear issues (referenced in PRs/agents but not assigned)
    const knownIds = new Set(linearResult.issues.map(i => i.identifier.toLowerCase()));
    const missingIds = findMissingLinearIds(items, knownIds);

    if (missingIds.length > 0 && process.env.LINEAR_API_KEY) {
      try {
        const cacheKey = `linear:lookup:${missingIds.sort().join(",")}`;
        const cachedLookup = getCached<LinearIssue[]>(cacheKey);
        let extraIssues: LinearIssue[];

        if (cachedLookup) {
          logApiCall("linear", "lookup", "cached", 0);
          extraIssues = cachedLookup;
        } else {
          const lookupStart = Date.now();
          extraIssues = await dedupe(cacheKey, () =>
            fetchIssuesByIdentifiers(process.env.LINEAR_API_KEY!, missingIds)
          );
          logApiCall("linear", "lookup", "ok", Date.now() - lookupStart);
          setCache(cacheKey, extraIssues, CACHE_TTL_LINEAR);
        }

        if (extraIssues.length > 0) {
          const allIssues = [...linearResult.issues, ...extraIssues];
          items = buildWorkItems(allIssues, githubResult.prs, cursorResult.agents);
        }
      } catch (e: any) {
        errors.push(`linear-lookup: ${e.message}`);
      }
    }

    // Phase 3b: Look up GitHub PRs referenced in Linear prUrls but not in search results
    const knownPrUrls = new Set(githubResult.prs.map(pr => pr.url));
    const missingPrUrls = findMissingPrUrls(items, knownPrUrls);

    if (missingPrUrls.length > 0 && process.env.GITHUB_TOKEN) {
      try {
        const cacheKey = `github:pr-lookup:${missingPrUrls.sort().join(",")}`;
        const cachedLookup = getCached<GitHubPR[]>(cacheKey);
        let extraPrs: GitHubPR[];

        if (cachedLookup) {
          logApiCall("github", "pr-lookup", "cached", 0);
          extraPrs = cachedLookup;
        } else {
          const lookupStart = Date.now();
          extraPrs = await dedupe(cacheKey, () =>
            fetchPrsByUrls(process.env.GITHUB_TOKEN!, missingPrUrls)
          );
          logApiCall("github", "pr-lookup", "ok", Date.now() - lookupStart);
          setCache(cacheKey, extraPrs, CACHE_TTL_GITHUB);
        }

        if (extraPrs.length > 0) {
          const allPrs = [...githubResult.prs, ...extraPrs];
          // Collect all known issues (original + any extras from Phase 3)
          const issueById = new Map(linearResult.issues.map(i => [i.id, i]));
          for (const item of items) {
            if (item.linear && !issueById.has(item.linear.id)) issueById.set(item.linear.id, item.linear);
          }
          items = buildWorkItems([...issueById.values()], allPrs, cursorResult.agents);
        }
      } catch (e: any) {
        errors.push(`github-pr-lookup: ${e.message}`);
      }
    }

    // Phase 4: Look up Linear issues for review PRs by identifier in title/branch
    let reviewIssues = linearReviewResult.issues;
    if (reviewResult.prs.length > 0 && process.env.LINEAR_API_KEY) {
      const idRe = /[A-Z]+-\d+/gi;
      const reviewIds = new Set<string>();
      for (const pr of reviewResult.prs) {
        const text = `${pr.title} ${pr.branch}`;
        for (const m of text.matchAll(idRe)) reviewIds.add(m[0].toUpperCase());
      }
      // Remove IDs we already have from the subscribed issues
      const knownIds = new Set(reviewIssues.map(i => i.identifier.toUpperCase()));
      const missingIds = [...reviewIds].filter(id => !knownIds.has(id));
      if (missingIds.length > 0) {
        try {
          const cacheKey = `linear:review-lookup:${missingIds.sort().join(",")}`;
          const cachedLookup = getCached<LinearIssue[]>(cacheKey);
          let extra: LinearIssue[];
          if (cachedLookup) {
            logApiCall("linear", "review-lookup", "cached", 0);
            extra = cachedLookup;
          } else {
            const start = Date.now();
            extra = await dedupe(cacheKey, () =>
              fetchIssuesByIdentifiers(process.env.LINEAR_API_KEY!, missingIds)
            );
            logApiCall("linear", "review-lookup", "ok", Date.now() - start);
            setCache(cacheKey, extra, CACHE_TTL_LINEAR);
          }
          if (extra.length > 0) reviewIssues = [...reviewIssues, ...extra];
        } catch (e: any) {
          errors.push(`linear-review-lookup: ${e.message}`);
        }
      }
    }

    cached = { items, reviewPrs: reviewResult.prs, reviewIssues, rateLimits, errors };
    setCache(CACHE_KEY_WORK_ITEMS, cached, CACHE_TTL_ITEMS);
  }

  // Stats are always fresh from SQLite, not cached
  return NextResponse.json({
    ...cached,
    stats: getApiCallStats(),
    recent: getRecentApiCalls(100),
  });
}

async function fetchLinear(bypass: boolean, errors: string[]) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return { issues: [] as LinearIssue[], rateLimit: undefined };

  if (!bypass) {
    const cached = getCached<LinearIssue[]>(CACHE_KEY_LINEAR);
    if (cached) {
      logApiCall("linear", "issues", "cached", 0);
      const rl = getCached<RateLimit>(CACHE_KEY_LINEAR_RATE);
      return { issues: cached, rateLimit: rl ?? undefined };
    }
  }

  try {
    const start = Date.now();
    const { issues, rateLimit } = await dedupe("linear:issues", () => fetchAssignedIssues(apiKey));
    logApiCall("linear", "issues", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache(CACHE_KEY_LINEAR, issues, CACHE_TTL_LINEAR);
    if (rateLimit) setCache(CACHE_KEY_LINEAR_RATE, rateLimit, CACHE_TTL_LINEAR);
    return { issues, rateLimit };
  } catch (e: any) {
    errors.push(`linear: ${e.message}`);
    const stale = getCached<LinearIssue[]>(CACHE_KEY_LINEAR, true);
    return { issues: stale ?? [], rateLimit: undefined };
  }
}

async function fetchGitHub(bypass: boolean, errors: string[]) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { prs: [] as GitHubPR[], rateLimit: undefined, searchRateLimit: undefined };

  if (!bypass) {
    const cached = getCached<GitHubPR[]>(CACHE_KEY_GITHUB);
    if (cached) {
      logApiCall("github", "prs", "cached", 0);
      const rl = getCached<RateLimit>(CACHE_KEY_GITHUB_RATE);
      return { prs: cached, rateLimit: rl ?? undefined, searchRateLimit: undefined };
    }
  }

  try {
    const previous = getCached<GitHubPR[]>(CACHE_KEY_GITHUB, true) ?? undefined;
    const start = Date.now();
    const { prs, rateLimit, searchRateLimit } = await dedupe("github:prs", () => fetchAuthoredPRs(token, previous));
    logApiCall("github", "prs", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache(CACHE_KEY_GITHUB, prs, CACHE_TTL_GITHUB);
    if (rateLimit) setCache(CACHE_KEY_GITHUB_RATE, rateLimit, CACHE_TTL_GITHUB);
    return { prs, rateLimit, searchRateLimit };
  } catch (e: any) {
    errors.push(`github: ${e.message}`);
    const stale = getCached<GitHubPR[]>(CACHE_KEY_GITHUB, true);
    let rl = getCached<RateLimit>(CACHE_KEY_GITHUB_RATE, true);
    if (!rl) {
      try {
        const octokit = new Octokit({ auth: token });
        const resp = await octokit.rest.rateLimit.get();
        const core = resp.data.resources.core;
        rl = {
          remaining: core.remaining,
          limit: core.limit,
          resetAt: new Date(core.reset * 1000).toISOString(),
        };
        setCache(CACHE_KEY_GITHUB_RATE, rl, 60 * 60 * 1000);
      } catch { /* ignore */ }
    }
    return { prs: stale ?? [], rateLimit: rl, searchRateLimit: undefined };
  }
}

async function fetchLinearReviews(bypass: boolean, errors: string[]) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return { issues: [] as LinearIssue[] };

  if (!bypass) {
    const cached = getCached<LinearIssue[]>(CACHE_KEY_LINEAR_REVIEWS);
    if (cached) {
      logApiCall("linear", "reviews", "cached", 0);
      return { issues: cached };
    }
  }

  try {
    const start = Date.now();
    const issues = await dedupe("linear:reviews", () => fetchSubscribedIssues(apiKey));
    logApiCall("linear", "reviews", "ok", Date.now() - start);
    setCache(CACHE_KEY_LINEAR_REVIEWS, issues, CACHE_TTL_LINEAR_REVIEWS);
    return { issues };
  } catch (e: any) {
    errors.push(`linear-reviews: ${e.message}`);
    const stale = getCached<LinearIssue[]>(CACHE_KEY_LINEAR_REVIEWS, true);
    return { issues: stale ?? [] };
  }
}

async function fetchGitHubReviews(bypass: boolean, errors: string[]) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { prs: [] as GitHubPR[] };

  if (!bypass) {
    const cached = getCached<GitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS);
    if (cached) {
      logApiCall("github", "reviews", "cached", 0);
      return { prs: cached };
    }
  }

  try {
    const previous = getCached<GitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS, true) ?? undefined;
    const start = Date.now();
    const { prs } = await dedupe("github:reviews", () => fetchReviewRequestedPRs(token, previous));
    logApiCall("github", "reviews", "ok", Date.now() - start);
    setCache(CACHE_KEY_GITHUB_REVIEWS, prs, CACHE_TTL_GITHUB_REVIEWS);
    return { prs };
  } catch (e: any) {
    errors.push(`github-reviews: ${e.message}`);
    const stale = getCached<GitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS, true);
    return { prs: stale ?? [] };
  }
}

async function fetchCursor(bypass: boolean, errors: string[]) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return { agents: [] as CursorAgent[] };

  if (!bypass) {
    const cached = getCached<CursorAgent[]>(CACHE_KEY_CURSOR);
    if (cached) {
      logApiCall("cursor", "agents", "cached", 0);
      return { agents: cached };
    }
  }

  try {
    const start = Date.now();
    const agents = await dedupe("cursor:agents", () => fetchBGAJobs(apiKey));
    logApiCall("cursor", "agents", "ok", Date.now() - start);
    setCache(CACHE_KEY_CURSOR, agents, CACHE_TTL_CURSOR);
    return { agents };
  } catch (e: any) {
    errors.push(`cursor: ${e.message}`);
    const stale = getCached<CursorAgent[]>(CACHE_KEY_CURSOR, true);
    return { agents: stale ?? [] };
  }
}
