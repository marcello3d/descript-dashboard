import { Octokit } from "@octokit/rest";
import { getEnv } from "@/lib/env";
import { fetchRawAuthoredPRs, fetchRawReviewRequestedPRs, fetchRawPrsByUrls, transformPRs, transformReviewPRs, type RawGitHubPR } from "@/lib/github";
import { fetchRawAssignedIssues, fetchRawSubscribedIssues, fetchRawIssuesByIdentifiers, transformIssues, type RawLinearIssue } from "@/lib/linear";
import { fetchRawAgents, fetchRawAgentsByIds, transformAgents, type RawCursorAgent } from "@/lib/cursor";
import { getCached, setCache, logApiCall, dedupe } from "@/lib/cache";
import { errorMessage } from "@/lib/errors";
import { buildWorkItems, buildReviewItems, findMissingCursorAgentIds, findMissingLinearIds, findMissingPrUrls } from "@/lib/work-items";
import {
  upsertWorkItems,
  upsertReviewItems,
  needsSync, setSyncStatus, getSyncStatus,
} from "@/lib/db";

interface RateLimit {
  cost?: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface SyncResult {
  viewerLogin: string;
  rateLimits: { github?: RateLimit; githubSearch?: RateLimit; linear?: RateLimit };
  errors: string[];
}

export type SyncCallback = (progress: { step: number; totalSteps: number }) => void;

const TTL_LINEAR = 5 * 60 * 1000;
// notify-check uses GitHub /notifications with If-Modified-Since as a cheap signal,
// so the underlying sync only runs when something actually changed. That lets these
// TTLs match the client's 5-min refresh interval — page reloads within the window
// hit the cache instead of GitHub, avoiding secondary rate limits.
const TTL_GITHUB = 5 * 60 * 1000;
const TTL_CURSOR = 2 * 60 * 1000;
const TTL_GITHUB_REVIEWS = 5 * 60 * 1000;
const TTL_LINEAR_REVIEWS = 5 * 60 * 1000;
// Second-pass lookups resolve items merely referenced by the primary data
// (PRs linked from Linear, issues named in review PRs, agents in attachments).
// They're secondary context that changes rarely, so cache them well past the
// 5-min primary TTL — otherwise these sequential fetches re-run every refresh
// and stack seconds onto the tail of every sync.
const TTL_LOOKUP = 30 * 60 * 1000;

export async function sync(opts: { force?: boolean; onProgress?: SyncCallback }): Promise<SyncResult> {
  const { force = false, onProgress } = opts;

  let rawLinear = getCached<RawLinearIssue[]>("linear:raw:issues", true) ?? [];
  let rawGithub = getCached<RawGitHubPR[]>("github:raw:prs", true) ?? [];
  let rawCursor = getCached<RawCursorAgent[]>("cursor:raw:agents", true) ?? [];
  let rawReviewPrs = getCached<RawGitHubPR[]>("github:raw:reviewPrs", true) ?? [];
  let rawReviewIssues = getCached<RawLinearIssue[]>("linear:raw:reviewIssues", true) ?? [];
  let viewerLogin = "";
  const rateLimits: SyncResult["rateLimits"] = {};
  const errors: string[] = [];

  // Restore viewerLogin from sync_status meta
  const ghReviewStatus = getSyncStatus("github_reviews");
  if (ghReviewStatus?.meta && typeof ghReviewStatus.meta === "object" && "viewerLogin" in ghReviewStatus.meta) {
    viewerLogin = ghReviewStatus.meta.viewerLogin as string;
  }

  // Restore rate limits from sync_status
  for (const [service, key] of [["github", "github"], ["linear", "linear"]] as const) {
    const status = getSyncStatus(service);
    if (status?.rateLimitData) rateLimits[key] = status.rateLimitData;
  }

  // Progress is counted in work units: one per active service fetch, one per
  // lookup phase, and one per open PR we enrich for merge readiness. The PR
  // count isn't known until the authored-PR search returns, so the denominator
  // grows mid-sync — that's the jump to ~80+ the user sees, and it lets the bar
  // advance through the long GitHub fetch instead of stalling on a single step.
  const LOOKUP_PHASES = 4;
  let unitsDone = 0;
  let unitsTotal = 0;
  const emitProgress = () => onProgress?.({ step: unitsDone, totalSteps: Math.max(unitsTotal, 1) });

  let enrichTotal = 0;
  let enrichDone = 0;
  const onReadinessProgress = (done: number, total: number) => {
    if (total !== enrichTotal) { unitsTotal += total - enrichTotal; enrichTotal = total; }
    if (done > enrichDone) { unitsDone += done - enrichDone; enrichDone = done; }
    emitProgress();
  };

  // Phase 1: Fetch from APIs in parallel (only services that need sync)
  const fetches: Promise<void>[] = [];

  if (force || needsSync("linear")) {
    fetches.push(fetchLinear(force, errors).then(r => {
      rawLinear = r.raw;
      if (r.rateLimit) rateLimits.linear = r.rateLimit;
    }));
  }

  const willFetchGithub = force || needsSync("github");
  if (willFetchGithub) {
    fetches.push(fetchGitHub(force, errors, onReadinessProgress).then(r => {
      rawGithub = r.raw;
      if (r.rateLimit) rateLimits.github = r.rateLimit;
      if (r.searchRateLimit) rateLimits.githubSearch = r.searchRateLimit;
    }));
  }

  if (force || needsSync("cursor")) {
    fetches.push(fetchCursor(errors).then(r => {
      rawCursor = r.raw;
    }));
  }

  let fetchedFreshReviews = false;
  if (force || needsSync("github_reviews")) {
    fetchedFreshReviews = true;
    fetches.push(fetchGitHubReviews(force, errors).then(r => {
      rawReviewPrs = r.raw;
      if (r.viewerLogin) viewerLogin = r.viewerLogin;
    }));
  }

  if (force || needsSync("linear_reviews")) {
    fetches.push(fetchLinearReviews(errors).then(r => {
      rawReviewIssues = r.raw;
    }));
  }

  if (fetches.length === 0) {
    // Nothing needs sync -- just read from DB
    unitsTotal = 1;
    unitsDone = 1;
    emitProgress();
    return { viewerLogin, rateLimits, errors };
  }

  unitsTotal = fetches.length + LOOKUP_PHASES;
  // Pre-seed the readiness units from the last-cached open PR count so the
  // denominator starts near its final value instead of lurching up when the
  // real count arrives. onReadinessProgress corrects any difference.
  if (willFetchGithub) {
    enrichTotal = rawGithub.filter(pr => pr.state === "open" && !pr.merged).length;
    unitsTotal += enrichTotal;
  }
  emitProgress();

  // Emit progress as each fetch completes
  const pending = fetches.map((p, i) => p.then(() => i));
  const done = new Set<number>();
  while (done.size < fetches.length) {
    const idx = await Promise.race(pending.filter((_, i) => !done.has(i)));
    done.add(idx);
    unitsDone += 1;
    emitProgress();
  }

  // Phase 2: Transform + merge
  const issues = transformIssues(rawLinear);
  const prs = transformPRs(rawGithub);
  const agents = transformAgents(rawCursor);
  const reviewPrsTransformed = transformReviewPRs(rawReviewPrs);
  const reviewIssuesTransformed = transformIssues(rawReviewIssues);

  const bumpProgress = () => { unitsDone += 1; emitProgress(); };

  // Phase 2a: Missing Linear issues. Runs first because the PR and agent
  // lookups below key off the issues it pulls in.
  const knownIds = new Set(issues.map(i => i.identifier.toLowerCase()));
  const missingIds = findMissingLinearIds(buildWorkItems(issues, prs, agents), knownIds);

  if (missingIds.length > 0 && getEnv("LINEAR_API_KEY")) {
    try {
      const cacheKey = `linear:raw:lookup:${missingIds.sort().join(",")}`;
      const cachedLookup = getCached<RawLinearIssue[]>(cacheKey);
      let extraRaw: RawLinearIssue[];
      if (cachedLookup) {
        logApiCall("linear", "lookup", "cached", 0);
        extraRaw = cachedLookup;
      } else {
        const start = Date.now();
        extraRaw = await dedupe(cacheKey, () =>
          fetchRawIssuesByIdentifiers(getEnv("LINEAR_API_KEY")!, missingIds)
        );
        logApiCall("linear", "lookup", "ok", Date.now() - start);
        setCache(cacheKey, extraRaw, TTL_LOOKUP);
      }
      if (extraRaw.length > 0) {
        rawLinear = [...rawLinear, ...extraRaw];
      }
    } catch (e) {
      errors.push(`linear-lookup: ${errorMessage(e)}`);
    }
  }
  bumpProgress();

  // Phases 2b/2c/2d don't depend on each other — run them concurrently so their
  // lookups share one round-trip wave instead of three serial ones.
  await Promise.all([
    // Phase 2b: Missing GitHub PRs referenced by Linear issues
    (async () => {
      const currentPrs = transformPRs(rawGithub);
      const currentIssues = transformIssues(rawLinear);
      const knownPrUrls = new Set(currentPrs.map(pr => pr.url));
      const missingPrUrls = findMissingPrUrls(buildWorkItems(currentIssues, currentPrs, agents), knownPrUrls);

      if (missingPrUrls.length > 0 && getEnv("GITHUB_TOKEN")) {
        try {
          const cacheKey = `github:raw:pr-lookup:${missingPrUrls.sort().join(",")}`;
          const cachedLookup = getCached<RawGitHubPR[]>(cacheKey);
          let extraRaw: RawGitHubPR[];
          if (cachedLookup) {
            logApiCall("github", "pr-lookup", "cached", 0);
            extraRaw = cachedLookup;
          } else {
            const start = Date.now();
            extraRaw = await dedupe(cacheKey, () =>
              fetchRawPrsByUrls(getEnv("GITHUB_TOKEN")!, missingPrUrls)
            );
            logApiCall("github", "pr-lookup", "ok", Date.now() - start);
            setCache(cacheKey, extraRaw, TTL_LOOKUP);
          }
          if (extraRaw.length > 0) {
            rawGithub = [...rawGithub, ...extraRaw];
          }
        } catch (e) {
          errors.push(`github-pr-lookup: ${errorMessage(e)}`);
        }
      }
    })().then(bumpProgress),

    // Phase 2c: Missing Cursor agents referenced by Linear attachments
    (async () => {
      const currentIssuesForAgents = transformIssues(rawLinear);
      const currentPrsForAgents = transformPRs(rawGithub);
      const currentAgents = transformAgents(rawCursor);
      const knownAgentIds = new Set(currentAgents.map(a => a.id));
      const workItemsForAgents = buildWorkItems(currentIssuesForAgents, currentPrsForAgents, currentAgents);
      const missingAgentIds = findMissingCursorAgentIds(workItemsForAgents, knownAgentIds);

      if (missingAgentIds.length > 0 && getEnv("CURSOR_API_KEY")) {
        try {
          const cacheKey = `cursor:raw:agent-lookup:${missingAgentIds.sort().join(",")}`;
          const cachedLookup = getCached<RawCursorAgent[]>(cacheKey);
          let extraRaw: RawCursorAgent[];
          if (cachedLookup) {
            logApiCall("cursor", "agent-lookup", "cached", 0);
            extraRaw = cachedLookup;
          } else {
            const start = Date.now();
            extraRaw = await dedupe(cacheKey, () =>
              fetchRawAgentsByIds(getEnv("CURSOR_API_KEY")!, missingAgentIds)
            );
            logApiCall("cursor", "agent-lookup", "ok", Date.now() - start);
            setCache(cacheKey, extraRaw, TTL_LOOKUP);
          }
          if (extraRaw.length > 0) {
            rawCursor = [...rawCursor, ...extraRaw];
          }
        } catch (e) {
          errors.push(`cursor-agent-lookup: ${errorMessage(e)}`);
        }
      }
    })().then(bumpProgress),

    // Phase 2d: Review issue enrichment (independent of the PR/agent lookups)
    (async () => {
      if (reviewPrsTransformed.length > 0 && getEnv("LINEAR_API_KEY")) {
        const idRe = /[A-Z]+-\d+/gi;
        const reviewIds = new Set<string>();
        for (const pr of reviewPrsTransformed) {
          const text = `${pr.title} ${pr.branch}`;
          for (const m of text.matchAll(idRe)) reviewIds.add(m[0].toUpperCase());
        }
        const knownReviewIds = new Set(reviewIssuesTransformed.map(i => i.identifier.toUpperCase()));
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
                fetchRawIssuesByIdentifiers(getEnv("LINEAR_API_KEY")!, missingReviewIds)
              );
              logApiCall("linear", "review-lookup", "ok", Date.now() - start);
              setCache(cacheKey, extraRaw, TTL_LOOKUP);
            }
            if (extraRaw.length > 0) {
              rawReviewIssues = [...rawReviewIssues, ...extraRaw];
            }
          } catch (e) {
            errors.push(`linear-review-lookup: ${errorMessage(e)}`);
          }
        }
      }
    })().then(bumpProgress),
  ]);

  // Phase 3: Final build + persist
  const finalIssues = transformIssues(rawLinear);
  const finalPrs = transformPRs(rawGithub);
  const finalAgents = transformAgents(rawCursor);
  const finalWorkItems = buildWorkItems(finalIssues, finalPrs, finalAgents);

  const allReviewIssues = transformIssues(rawReviewIssues);
  const allReviewPrs = transformReviewPRs(rawReviewPrs);
  const reviewItems = buildReviewItems(allReviewPrs, allReviewIssues, viewerLogin);

  if (finalWorkItems.length > 0) upsertWorkItems(finalWorkItems);
  if (fetchedFreshReviews) upsertReviewItems(reviewItems);

  // Mark synced services
  if (rawLinear.length > 0) setSyncStatus("linear", TTL_LINEAR, { rateLimitData: rateLimits.linear });
  if (rawGithub.length > 0) setSyncStatus("github", TTL_GITHUB, { rateLimitData: rateLimits.github });
  if (rawCursor.length > 0) setSyncStatus("cursor", TTL_CURSOR);
  if (rawReviewPrs.length > 0) setSyncStatus("github_reviews", TTL_GITHUB_REVIEWS, { meta: { viewerLogin } });
  if (rawReviewIssues.length > 0) setSyncStatus("linear_reviews", TTL_LINEAR_REVIEWS);

  unitsDone = unitsTotal;
  emitProgress();

  return { viewerLogin, rateLimits, errors };
}

// --- Fetch helpers (moved from route.ts) ---

async function fetchLinear(force: boolean, errors: string[]) {
  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) return { raw: [] as RawLinearIssue[], rateLimit: undefined };

  try {
    const start = Date.now();
    const { issues, rateLimit } = await dedupe("linear:issues", () => fetchRawAssignedIssues(apiKey));
    logApiCall("linear", "issues", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache("linear:raw:issues", issues, TTL_LINEAR);
    return { raw: issues, rateLimit };
  } catch (e) {
    errors.push(`linear: ${errorMessage(e)}`);
    return { raw: [] as RawLinearIssue[], rateLimit: undefined };
  }
}

async function fetchGitHub(force: boolean, errors: string[], onReadinessProgress?: (done: number, total: number) => void) {
  const token = getEnv("GITHUB_TOKEN");
  if (!token) return { raw: [] as RawGitHubPR[], rateLimit: undefined, searchRateLimit: undefined };

  try {
    const start = Date.now();
    // Hand the last-cached PRs to the fetch so it can skip full detail requests
    // for PRs whose updatedAt is unchanged (github.ts Phase 2 diff). Without
    // this every sync re-fetched details + reviews for every PR. Merge readiness
    // still re-runs on all open PRs, so check status stays fresh.
    const previous = getCached<RawGitHubPR[]>("github:raw:prs", true) ?? undefined;
    const { prs, rateLimit, searchRateLimit } = await dedupe("github:prs", () => fetchRawAuthoredPRs(token, previous, onReadinessProgress));
    logApiCall("github", "prs", "ok", Date.now() - start, { cost: rateLimit?.cost });

    // Bug-bot thread info is now derived inside enrichMergeReadiness from the
    // reviewThreads the readiness query already fetches — no separate pass.
    setCache("github:raw:prs", prs, TTL_GITHUB);
    return { raw: prs, rateLimit, searchRateLimit };
  } catch (e) {
    errors.push(`github: ${errorMessage(e)}`);
    let rl: RateLimit | undefined;
    try {
      const octokit = new Octokit({ auth: token });
      const resp = await octokit.rest.rateLimit.get();
      const core = resp.data.resources.core;
      rl = { remaining: core.remaining, limit: core.limit, resetAt: new Date(core.reset * 1000).toISOString() };
    } catch { /* ignore */ }
    return { raw: [] as RawGitHubPR[], rateLimit: rl, searchRateLimit: undefined };
  }
}

async function fetchCursor(errors: string[]) {
  const apiKey = getEnv("CURSOR_API_KEY");
  if (!apiKey) return { raw: [] as RawCursorAgent[] };

  try {
    const start = Date.now();
    const agents = await dedupe("cursor:agents", () => fetchRawAgents(apiKey));
    logApiCall("cursor", "agents", "ok", Date.now() - start);
    setCache("cursor:raw:agents", agents, TTL_CURSOR);
    return { raw: agents };
  } catch (e) {
    errors.push(`cursor: ${errorMessage(e)}`);
    return { raw: [] as RawCursorAgent[] };
  }
}

async function fetchGitHubReviews(force: boolean, errors: string[]) {
  const token = getEnv("GITHUB_TOKEN");
  if (!token) return { raw: [] as RawGitHubPR[], viewerLogin: "" };

  try {
    const start = Date.now();
    // Same diff as authored PRs: reuse last-cached review PRs so unchanged ones
    // skip the per-PR detail fetch. This is the slowest phase-1 fetch otherwise.
    const previous = getCached<RawGitHubPR[]>("github:raw:reviewPrs", true) ?? undefined;
    const { prs, viewerLogin } = await dedupe("github:reviews", () => fetchRawReviewRequestedPRs(token, previous));
    logApiCall("github", "reviews", "ok", Date.now() - start);
    setCache("github:raw:reviewPrs", prs, TTL_GITHUB_REVIEWS);
    return { raw: prs, viewerLogin };
  } catch (e) {
    errors.push(`github-reviews: ${errorMessage(e)}`);
    return { raw: [] as RawGitHubPR[], viewerLogin: "" };
  }
}

async function fetchLinearReviews(errors: string[]) {
  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) return { raw: [] as RawLinearIssue[] };

  try {
    const start = Date.now();
    const issues = await dedupe("linear:reviews", () => fetchRawSubscribedIssues(apiKey));
    logApiCall("linear", "reviews", "ok", Date.now() - start);
    setCache("linear:raw:reviewIssues", issues, TTL_LINEAR_REVIEWS);
    return { raw: issues };
  } catch (e) {
    errors.push(`linear-reviews: ${errorMessage(e)}`);
    return { raw: [] as RawLinearIssue[] };
  }
}
