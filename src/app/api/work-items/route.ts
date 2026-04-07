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

export async function GET(request: Request) {
  const bypass = new URL(request.url).searchParams.get("fresh") === "1";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Mutable state that accumulates as services respond
      let rawLinear: RawLinearIssue[] = [];
      let rawGithub: RawGitHubPR[] = [];
      let rawCursor: RawCursorAgent[] = [];
      let rawReviewPrs: RawGitHubPR[] = [];
      let rawReviewIssues: RawLinearIssue[] = [];
      let viewerLogin = getCached<string>("github:viewerLogin") ?? "";
      const rateLimits: { github?: RateLimit; githubSearch?: RateLimit; linear?: RateLimit } = {};
      const errors: string[] = [];

      // Progress tracking: phase 0 (cache) + 5 fetches + up to 3 lookups + final
      const TOTAL_STEPS = 10;
      let currentStep = 0;

      function buildAndEmit(done: boolean) {
        const issues = transformIssues(rawLinear);
        const prs = transformPRs(rawGithub);
        const agents = transformAgents(rawCursor);
        const items = buildWorkItems(issues, prs, agents);
        const reviewPrs = transformReviewPRs(rawReviewPrs);
        const reviewIssues = transformIssues(rawReviewIssues);
        const line = JSON.stringify({
          viewerLogin,
          items,
          reviewPrs,
          reviewIssues,
          rateLimits,
          errors: [...errors],
          stats: getApiCallStats(),
          recent: getRecentApiCalls(100),
          progress: { step: currentStep, totalSteps: TOTAL_STEPS },
          done,
        });
        controller.enqueue(encoder.encode(line + "\n"));
      }

      // Phase 0: Emit cached snapshot immediately (ignoring expiry) — step 0
      rawLinear = getCached<RawLinearIssue[]>(CACHE_KEY_LINEAR, true) ?? [];
      rawGithub = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB, true) ?? [];
      rawCursor = getCached<RawCursorAgent[]>(CACHE_KEY_CURSOR, true) ?? [];
      rawReviewPrs = getCached<RawGitHubPR[]>(CACHE_KEY_GITHUB_REVIEWS, true) ?? [];
      rawReviewIssues = getCached<RawLinearIssue[]>(CACHE_KEY_LINEAR_REVIEWS, true) ?? [];
      const rl = getCached<RateLimit>(CACHE_KEY_LINEAR_RATE, true);
      if (rl) rateLimits.linear = rl;
      const ghrl = getCached<RateLimit>(CACHE_KEY_GITHUB_RATE, true);
      if (ghrl) rateLimits.github = ghrl;
      currentStep = 1;
      buildAndEmit(false);

      // Phase 1: Fire all fetches, emit as each completes
      let emitNeeded = false;

      const fetches = [
        fetchLinear(bypass, errors).then(r => {
          rawLinear = r.raw;
          if (r.rateLimit) rateLimits.linear = r.rateLimit;
          emitNeeded = true;
        }),
        fetchGitHub(bypass, errors).then(r => {
          rawGithub = r.raw;
          if (r.rateLimit) rateLimits.github = r.rateLimit;
          if (r.searchRateLimit) rateLimits.githubSearch = r.searchRateLimit;
          emitNeeded = true;
        }),
        fetchCursor(bypass, errors).then(r => {
          rawCursor = r.raw;
          emitNeeded = true;
        }),
        fetchGitHubReviews(bypass, errors).then(r => {
          rawReviewPrs = r.raw;
          if (r.viewerLogin) viewerLogin = r.viewerLogin;
          emitNeeded = true;
        }),
        fetchLinearReviews(bypass, errors).then(r => {
          rawReviewIssues = r.raw;
          emitNeeded = true;
        }),
      ];

      // Emit after each fetch completes
      const pending = fetches.map((p, i) => p.then(() => i));
      const done = new Set<number>();
      while (done.size < fetches.length) {
        const idx = await Promise.race(
          pending.filter((_, i) => !done.has(i))
        );
        done.add(idx);
        currentStep = 1 + done.size; // steps 2-6
        if (emitNeeded) {
          emitNeeded = false;
          buildAndEmit(false);
        }
      }

      // Phase 2: Lookup phases (sequential, emit after each) — steps 7-9
      currentStep = 7;
      const issues = transformIssues(rawLinear);
      const prs = transformPRs(rawGithub);
      const agents = transformAgents(rawCursor);

      // Phase 2a: Missing Linear issues
      const knownIds = new Set(issues.map(i => i.identifier.toLowerCase()));
      const missingIds = findMissingLinearIds(buildWorkItems(issues, prs, agents), knownIds);

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
            rawLinear = [...rawLinear, ...extraRaw];
            buildAndEmit(false);
          }
        } catch (e: any) {
          errors.push(`linear-lookup: ${e.message}`);
        }
      }

      // Phase 2b: Missing GitHub PRs
      currentStep = 8;
      const currentPrs = transformPRs(rawGithub);
      const currentIssues = transformIssues(rawLinear);
      const knownPrUrls = new Set(currentPrs.map(pr => pr.url));
      const missingPrUrls = findMissingPrUrls(buildWorkItems(currentIssues, currentPrs, agents), knownPrUrls);

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
            rawGithub = [...rawGithub, ...extraRaw];
            buildAndEmit(false);
          }
        } catch (e: any) {
          errors.push(`github-pr-lookup: ${e.message}`);
        }
      }

      // Phase 2c: Review issue enrichment
      currentStep = 9;
      const reviewPrs = transformReviewPRs(rawReviewPrs);
      if (reviewPrs.length > 0 && process.env.LINEAR_API_KEY) {
        const idRe = /[A-Z]+-\d+/gi;
        const reviewIds = new Set<string>();
        for (const pr of reviewPrs) {
          const text = `${pr.title} ${pr.branch}`;
          for (const m of text.matchAll(idRe)) reviewIds.add(m[0].toUpperCase());
        }
        const reviewIssues = transformIssues(rawReviewIssues);
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
            if (extraRaw.length > 0) {
              rawReviewIssues = [...rawReviewIssues, ...extraRaw];
            }
          } catch (e: any) {
            errors.push(`linear-review-lookup: ${e.message}`);
          }
        }
      }

      // Final emit — step 10
      currentStep = TOTAL_STEPS;
      buildAndEmit(true);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
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
