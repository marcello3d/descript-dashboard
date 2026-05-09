import { getEnv } from "@/lib/env";
import {
  fetchRawCompletedIssues,
  transformIssues,
  type RawLinearIssue,
  type RawLinearResult,
} from "@/lib/linear";
import {
  fetchRawPrsByUrls,
  transformPRs,
  type RawGitHubPR,
} from "@/lib/github";
import { transformAgents, type RawCursorAgent } from "@/lib/cursor";
import { buildWorkItems } from "@/lib/work-items";
import {
  upsertCompletedWorkItems,
  workItemAnchor,
  needsSync,
  setSyncStatus,
} from "@/lib/db";
import { getCached, setCache, dedupe, logApiCall } from "@/lib/cache";
import { errorMessage } from "@/lib/errors";

const LINEAR_CACHE_KEY = "linear:raw:completedIssues";
const PR_CACHE_KEY = "github:raw:completedPrs";
const TTL_LINEAR_COMPLETED = 5 * 60 * 1000;
const TTL_GITHUB_COMPLETED = 30 * 60 * 1000;
const TOTAL_STEPS = 3;

export type CompletedSyncCallback = (progress: { step: number; totalSteps: number }) => void;

export interface CompletedSyncResult {
  errors: string[];
}

export async function syncCompleted(opts: {
  force?: boolean;
  onProgress?: CompletedSyncCallback;
}): Promise<CompletedSyncResult> {
  const { force = false, onProgress } = opts;
  const errors: string[] = [];

  if (!force && !needsSync("completed")) {
    onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS });
    return { errors };
  }

  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) {
    errors.push("linear-completed: LINEAR_API_KEY not configured");
    onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS });
    return { errors };
  }

  onProgress?.({ step: 1, totalSteps: TOTAL_STEPS });

  // Step 1: fetch Linear completed issues
  const cached = force ? null : getCached<RawLinearResult>(LINEAR_CACHE_KEY);
  let rawIssues: RawLinearIssue[] = cached?.issues ?? [];
  if (!cached) {
    try {
      const start = Date.now();
      const result = await dedupe(LINEAR_CACHE_KEY, () => fetchRawCompletedIssues(apiKey));
      logApiCall("linear", "completed_issues", "ok", Date.now() - start, { cost: result.rateLimit?.cost });
      setCache(LINEAR_CACHE_KEY, result, TTL_LINEAR_COMPLETED);
      rawIssues = result.issues;
    } catch (e) {
      const msg = errorMessage(e);
      logApiCall("linear", "completed_issues", "error", 0, { error: msg });
      errors.push(`linear-completed: ${msg}`);
      onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS });
      return { errors };
    }
  } else {
    logApiCall("linear", "completed_issues", "cached", 0);
  }

  onProgress?.({ step: 2, totalSteps: TOTAL_STEPS });

  // Step 2: backfill any missing PR metadata via GitHub.
  // Reuse PRs already fetched by the main sync, plus any we've previously
  // fetched for completed items, before going to the network.
  const issues = transformIssues(rawIssues);
  const referencedUrls = new Set<string>();
  for (const i of issues) for (const u of i.prUrls) referencedUrls.add(u);

  const cachedAuthored = getCached<RawGitHubPR[]>("github:raw:prs", true) ?? [];
  const cachedReview = getCached<RawGitHubPR[]>("github:raw:reviewPrs", true) ?? [];
  const cachedCompleted = getCached<RawGitHubPR[]>(PR_CACHE_KEY, true) ?? [];
  const allKnown = new Map<string, RawGitHubPR>();
  for (const pr of [...cachedAuthored, ...cachedReview, ...cachedCompleted]) {
    allKnown.set(pr.url, pr);
  }

  const missingUrls = [...referencedUrls].filter(u => !allKnown.has(u));
  if (missingUrls.length > 0) {
    const ghToken = getEnv("GITHUB_TOKEN");
    if (ghToken) {
      try {
        const start = Date.now();
        const fetched = await fetchRawPrsByUrls(ghToken, missingUrls);
        logApiCall("github", `completed_prs(${fetched.length})`, "ok", Date.now() - start);
        for (const pr of fetched) allKnown.set(pr.url, pr);
        // Persist alongside existing completed-PR cache so future loads skip these.
        const merged = [...cachedCompleted];
        const mergedIds = new Set(merged.map(p => p.id));
        for (const pr of fetched) {
          if (!mergedIds.has(pr.id)) merged.push(pr);
        }
        setCache(PR_CACHE_KEY, merged, TTL_GITHUB_COMPLETED);
      } catch (e) {
        const msg = errorMessage(e);
        logApiCall("github", "completed_prs", "error", 0, { error: msg });
        errors.push(`github-completed: ${msg}`);
      }
    }
  }

  // Only PRs referenced by these completed issues — avoid leaking unrelated cached PRs.
  const relevantPrs: RawGitHubPR[] = [];
  for (const url of referencedUrls) {
    const pr = allKnown.get(url);
    if (pr) relevantPrs.push(pr);
  }

  // Cursor agents: reuse whatever the main sync has already cached.
  const cachedAgents = getCached<RawCursorAgent[]>("cursor:raw:agents", true) ?? [];

  // Step 3: build + persist
  const items = buildWorkItems(
    issues,
    transformPRs(relevantPrs),
    transformAgents(cachedAgents),
  );
  // Drop orphan items (PRs/agents that don't belong to any completed Linear issue).
  const completedItems = items.filter(it => it.linear);
  for (const it of completedItems) {
    it.id = workItemAnchor(it);
  }
  upsertCompletedWorkItems(completedItems);
  setSyncStatus("completed", TTL_LINEAR_COMPLETED);

  onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS });
  return { errors };
}
