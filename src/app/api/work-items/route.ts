import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { fetchRawAuthoredPRs, fetchRawReviewRequestedPRs, fetchRawPrsByUrls, transformPRs, transformReviewPRs, type RawGitHubPR } from "@/lib/github";
import { fetchRawAssignedIssues, fetchRawSubscribedIssues, fetchRawIssuesByIdentifiers, transformIssues, type RawLinearIssue } from "@/lib/linear";
import { fetchRawAgents, transformAgents, type RawCursorAgent } from "@/lib/cursor";
import { getCached, setCache, logApiCall, dedupe, getApiCallStats, getRecentApiCalls } from "@/lib/cache";
import { buildWorkItems, findMissingLinearIds, findMissingPrUrls } from "@/lib/work-items";
import type { WorkItem, LinearIssue, GitHubPR } from "@/types";

const CACHE_KEY_GITHUB_REVIEWS = "github:raw:reviewPrs";
const CACHE_KEY_LINEAR_REVIEWS = "linear:raw:reviewIssues";
const CACHE_TTL_GITHUB_REVIEWS = 5 * 60 * 1000;
const CACHE_TTL_LINEAR_REVIEWS = 5 * 60 * 1000;

const CACHE_KEY_LINEAR = "linear:raw:issues";
const CACHE_KEY_LINEAR_RATE = "linear:rateLimit";
const CACHE_KEY_GITHUB = "github:raw:prs";
const CACHE_KEY_GITHUB_RATE = "github:rateLimit";
const CACHE_KEY_CURSOR = "cursor:raw:agents";
const CACHE_TTL_LINEAR = 5 * 60 * 1000;
const CACHE_TTL_GITHUB = 5 * 60 * 1000;
const CACHE_TTL_CURSOR = 2 * 60 * 1000;

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

  const errors: string[] = [];
  const rateLimits: WorkItemsResponse["rateLimits"] = {};

  // Phase 1: Fetch raw data from all services in parallel (cached at raw layer)
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

  // Phase 2: Transform raw data to app types (always fresh, never cached)
  const issues = transformIssues(linearResult.raw);
  const prs = transformPRs(githubResult.raw);
  const agents = transformAgents(cursorResult.raw);

  let items = buildWorkItems(issues, prs, agents);

  // Phase 3: Look up missing Linear issues (referenced in PRs/agents but not assigned)
  const knownIds = new Set(issues.map(i => i.identifier.toLowerCase()));
  const missingIds = findMissingLinearIds(items, knownIds);

  if (missingIds.length > 0 && process.env.LINEAR_API_KEY) {
    try {
      const cacheKey = `linear:raw:lookup:${missingIds.sort().join(",")}`;
      const cachedLookup = getCached<RawLinearIssue[]>(cacheKey);
      let extraRaw: RawLinearIssue[];

      if (cachedLookup) {
        logApiCall("linear", "lookup", "cached", 0);
        extraRaw = cachedLookup;
      } else {
        const lookupStart = Date.now();
        extraRaw = await dedupe(cacheKey, () =>
          fetchRawIssuesByIdentifiers(process.env.LINEAR_API_KEY!, missingIds)
        );
        logApiCall("linear", "lookup", "ok", Date.now() - lookupStart);
        setCache(cacheKey, extraRaw, CACHE_TTL_LINEAR);
      }

      if (extraRaw.length > 0) {
        const allIssues = [...issues, ...transformIssues(extraRaw)];
        items = buildWorkItems(allIssues, prs, agents);
      }
    } catch (e: any) {
      errors.push(`linear-lookup: ${e.message}`);
    }
  }

  // Phase 3b: Look up GitHub PRs referenced in Linear prUrls but not in search results
  const knownPrUrls = new Set(prs.map(pr => pr.url));
  const missingPrUrls = findMissingPrUrls(items, knownPrUrls);

  if (missingPrUrls.length > 0 && process.env.GITHUB_TOKEN) {
    try {
      const cacheKey = `github:raw:pr-lookup:${missingPrUrls.sort().join(",")}`;
      const cachedLookup = getCached<RawGitHubPR[]>(cacheKey);
      let extraRaw: RawGitHubPR[];

      if (cachedLookup) {
        logApiCall("github", "pr-lookup", "cached", 0);
        extraRaw = cachedLookup;
      } else {
        const lookupStart = Date.now();
        extraRaw = await dedupe(cacheKey, () =>
          fetchRawPrsByUrls(process.env.GITHUB_TOKEN!, missingPrUrls)
        );
        logApiCall("github", "pr-lookup", "ok", Date.now() - lookupStart);
        setCache(cacheKey, extraRaw, CACHE_TTL_GITHUB);
      }

      if (extraRaw.length > 0) {
        const allPrs = [...prs, ...transformPRs(extraRaw)];
        // Collect all known issues (original + any extras from Phase 3)
        const issueById = new Map(issues.map(i => [i.id, i]));
        for (const item of items) {
          if (item.linear && !issueById.has(item.linear.id)) issueById.set(item.linear.id, item.linear);
        }
        items = buildWorkItems([...issueById.values()], allPrs, agents);
      }
    } catch (e: any) {
      errors.push(`github-pr-lookup: ${e.message}`);
    }
  }

  // Phase 4: Look up Linear issues for review PRs by identifier in title/branch
  const reviewPrs = transformReviewPRs(reviewResult.raw);
  let reviewIssues = transformIssues(linearReviewResult.raw);
  if (reviewPrs.length > 0 && process.env.LINEAR_API_KEY) {
    const idRe = /[A-Z]+-\d+/gi;
    const reviewIds = new Set<string>();
    for (const pr of reviewPrs) {
      const text = `${pr.title} ${pr.branch}`;
      for (const m of text.matchAll(idRe)) reviewIds.add(m[0].toUpperCase());
    }
    // Remove IDs we already have from the subscribed issues
    const knownReviewIds = new Set(reviewIssues.map(i => i.identifier.toUpperCase()));
    const missingReviewIds = [...reviewIds].filter(id => !knownReviewIds.has(id));
    if (missingReviewIds.length > 0) {
      try {
        const cacheKey = `linear:raw:review-lookup:${missingReviewIds.sort().join(",")}`;
        const cachedLookup = getCached<RawLinearIssue[]>(cacheKey);
        let extraRaw: RawLinearIssue[];
        if (cachedLookup) {
          logApiCall("linear", "review-lookup", "cached", 0);
          extraRaw = cachedLookup;
        } else {
          const start = Date.now();
          extraRaw = await dedupe(cacheKey, () =>
            fetchRawIssuesByIdentifiers(process.env.LINEAR_API_KEY!, missingReviewIds)
          );
          logApiCall("linear", "review-lookup", "ok", Date.now() - start);
          setCache(cacheKey, extraRaw, CACHE_TTL_LINEAR);
        }
        if (extraRaw.length > 0) reviewIssues = [...reviewIssues, ...transformIssues(extraRaw)];
      } catch (e: any) {
        errors.push(`linear-review-lookup: ${e.message}`);
      }
    }
  }

  return NextResponse.json({
    viewerLogin: reviewResult.viewerLogin,
    items,
    reviewPrs,
    reviewIssues,
    rateLimits,
    errors,
    stats: getApiCallStats(),
    recent: getRecentApiCalls(100),
  });
}

async function fetchLinear(bypass: boolean, errors: string[]) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return { raw: [] as RawLinearIssue[], rateLimit: undefined };

  if (!bypass) {
    const cached = getCached<RawLinearIssue[]>(CACHE_KEY_LINEAR);
    if (cached) {
      logApiCall("linear", "issues", "cached", 0);
      const rl = getCached<RateLimit>(CACHE_KEY_LINEAR_RATE);
      return { raw: cached, rateLimit: rl ?? undefined };
    }
  }

  try {
    const start = Date.now();
    const { issues, rateLimit } = await dedupe("linear:issues", () => fetchRawAssignedIssues(apiKey));
    logApiCall("linear", "issues", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache(CACHE_KEY_LINEAR, issues, CACHE_TTL_LINEAR);
    if (rateLimit) setCache(CACHE_KEY_LINEAR_RATE, rateLimit, CACHE_TTL_LINEAR);
    return { raw: issues, rateLimit };
  } catch (e: any) {
    errors.push(`linear: ${e.message}`);
    const stale = getCached<RawLinearIssue[]>(CACHE_KEY_LINEAR, true);
    return { raw: stale ?? [], rateLimit: undefined };
  }
}

async function fetchGitHub(bypass: boolean, errors: string[]) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { raw: [] as RawGitHubPR[], rateLimit: undefined, searchRateLimit: undefined };

  if (!bypass) {
    const cached = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB);
    if (cached) {
      logApiCall("github", "prs", "cached", 0);
      const rl = getCached<RateLimit>(CACHE_KEY_GITHUB_RATE);
      return { raw: cached, rateLimit: rl ?? undefined, searchRateLimit: undefined };
    }
  }

  try {
    const previous = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB, true) ?? undefined;
    const start = Date.now();
    const { prs, rateLimit, searchRateLimit } = await dedupe("github:prs", () => fetchRawAuthoredPRs(token, previous));
    logApiCall("github", "prs", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache(CACHE_KEY_GITHUB, prs, CACHE_TTL_GITHUB);
    if (rateLimit) setCache(CACHE_KEY_GITHUB_RATE, rateLimit, CACHE_TTL_GITHUB);
    return { raw: prs, rateLimit, searchRateLimit };
  } catch (e: any) {
    errors.push(`github: ${e.message}`);
    const stale = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB, true);
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
    return { raw: stale ?? [], rateLimit: rl, searchRateLimit: undefined };
  }
}

async function fetchLinearReviews(bypass: boolean, errors: string[]) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return { raw: [] as RawLinearIssue[] };

  if (!bypass) {
    const cached = getCached<RawLinearIssue[]>(CACHE_KEY_LINEAR_REVIEWS);
    if (cached) {
      logApiCall("linear", "reviews", "cached", 0);
      return { raw: cached };
    }
  }

  try {
    const start = Date.now();
    const issues = await dedupe("linear:reviews", () => fetchRawSubscribedIssues(apiKey));
    logApiCall("linear", "reviews", "ok", Date.now() - start);
    setCache(CACHE_KEY_LINEAR_REVIEWS, issues, CACHE_TTL_LINEAR_REVIEWS);
    return { raw: issues };
  } catch (e: any) {
    errors.push(`linear-reviews: ${e.message}`);
    const stale = getCached<RawLinearIssue[]>(CACHE_KEY_LINEAR_REVIEWS, true);
    return { raw: stale ?? [] };
  }
}

async function fetchGitHubReviews(bypass: boolean, errors: string[]) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { raw: [] as RawGitHubPR[], viewerLogin: "" };

  if (!bypass) {
    const cached = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS);
    if (cached) {
      logApiCall("github", "reviews", "cached", 0);
      const login = getCached<string>("github:viewerLogin") ?? "";
      return { raw: cached, viewerLogin: login };
    }
  }

  try {
    const previous = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS, true) ?? undefined;
    const start = Date.now();
    const { prs, viewerLogin } = await dedupe("github:reviews", () => fetchRawReviewRequestedPRs(token, previous));
    logApiCall("github", "reviews", "ok", Date.now() - start);
    setCache(CACHE_KEY_GITHUB_REVIEWS, prs, CACHE_TTL_GITHUB_REVIEWS);
    if (viewerLogin) setCache("github:viewerLogin", viewerLogin, 24 * 60 * 60 * 1000);
    return { raw: prs, viewerLogin };
  } catch (e: any) {
    errors.push(`github-reviews: ${e.message}`);
    const stale = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS, true);
    const login = getCached<string>("github:viewerLogin") ?? "";
    return { raw: stale ?? [], viewerLogin: login };
  }
}

async function fetchCursor(bypass: boolean, errors: string[]) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return { raw: [] as RawCursorAgent[] };

  if (!bypass) {
    const cached = getCached<RawCursorAgent[]>(CACHE_KEY_CURSOR);
    if (cached) {
      logApiCall("cursor", "agents", "cached", 0);
      return { raw: cached };
    }
  }

  try {
    const start = Date.now();
    const agents = await dedupe("cursor:agents", () => fetchRawAgents(apiKey));
    logApiCall("cursor", "agents", "ok", Date.now() - start);
    setCache(CACHE_KEY_CURSOR, agents, CACHE_TTL_CURSOR);
    return { raw: agents };
  } catch (e: any) {
    errors.push(`cursor: ${e.message}`);
    const stale = getCached<RawCursorAgent[]>(CACHE_KEY_CURSOR, true);
    return { raw: stale ?? [] };
  }
}
