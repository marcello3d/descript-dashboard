import {
  fetchRawCompletedIssues,
  transformIssues,
  type RawLinearResult,
} from "@/lib/linear";
import {
  fetchRawPrsByUrls,
  transformPRs,
  type RawGitHubPR,
} from "@/lib/github";
import { transformAgents, type RawCursorAgent } from "@/lib/cursor";
import { buildWorkItems } from "@/lib/work-items";
import { workItemAnchor } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getCached, setCache, dedupe, logApiCall } from "@/lib/cache";

const CACHE_KEY = "linear_completed_issues";
const TTL_MS = 5 * 60 * 1000;
const ENRICHED_PR_CACHE_KEY = "github:raw:completedPrs";
const ENRICHED_PR_TTL = 30 * 60 * 1000;

export async function GET(request: Request) {
  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) {
    return Response.json({ error: "LINEAR_API_KEY not configured" }, { status: 500 });
  }

  const bypass = new URL(request.url).searchParams.get("fresh") === "1";

  try {
    let cached = bypass ? null : getCached<RawLinearResult>(CACHE_KEY);
    if (!cached) {
      cached = await dedupe(CACHE_KEY, async () => {
        const start = Date.now();
        try {
          const result = await fetchRawCompletedIssues(apiKey);
          logApiCall("linear", "completed_issues", "ok", Date.now() - start, { cost: result.rateLimit?.cost });
          setCache(CACHE_KEY, result, TTL_MS);
          return result;
        } catch (e: any) {
          logApiCall("linear", "completed_issues", "error", Date.now() - start, { error: e.message });
          throw e;
        }
      });
    } else {
      logApiCall("linear", "completed_issues", "cached", 0);
    }

    const issues = transformIssues(cached.issues);

    // Gather PRs from caches and fill in missing ones via the GitHub API.
    const referencedUrls = new Set<string>();
    for (const i of issues) for (const u of i.prUrls) referencedUrls.add(u);

    const cachedAuthored = getCached<RawGitHubPR[]>("github:raw:prs", true) ?? [];
    const cachedReview = getCached<RawGitHubPR[]>("github:raw:reviewPrs", true) ?? [];
    const cachedCompleted = getCached<RawGitHubPR[]>(ENRICHED_PR_CACHE_KEY, true) ?? [];
    const allKnown = new Map<string, RawGitHubPR>();
    for (const pr of [...cachedAuthored, ...cachedReview, ...cachedCompleted]) {
      allKnown.set(pr.url, pr);
    }

    const missingUrls = [...referencedUrls].filter((u) => !allKnown.has(u));
    let fetchedExtra: RawGitHubPR[] = [];
    if (missingUrls.length > 0) {
      const ghToken = getEnv("GITHUB_TOKEN");
      if (ghToken) {
        const start = Date.now();
        try {
          fetchedExtra = await fetchRawPrsByUrls(ghToken, missingUrls);
          logApiCall("github", `completed_prs(${fetchedExtra.length})`, "ok", Date.now() - start);
          for (const pr of fetchedExtra) allKnown.set(pr.url, pr);
          // Persist alongside the existing completed-PR cache so subsequent
          // loads don't refetch.
          const merged = [...cachedCompleted];
          const mergedIds = new Set(merged.map((p) => p.id));
          for (const pr of fetchedExtra) {
            if (!mergedIds.has(pr.id)) merged.push(pr);
          }
          setCache(ENRICHED_PR_CACHE_KEY, merged, ENRICHED_PR_TTL);
        } catch (e: any) {
          logApiCall("github", "completed_prs", "error", Date.now() - start, { error: e.message });
        }
      }
    }

    // Only PRs referenced by these completed issues — avoid leaking unrelated cached PRs.
    const relevantPrs: RawGitHubPR[] = [];
    for (const url of referencedUrls) {
      const pr = allKnown.get(url);
      if (pr) relevantPrs.push(pr);
    }

    const cachedAgents = getCached<RawCursorAgent[]>("cursor:raw:agents", true) ?? [];

    const items = buildWorkItems(
      issues,
      transformPRs(relevantPrs),
      transformAgents(cachedAgents)
    );

    // Drop orphan items (PRs/agents that don't belong to any completed Linear issue).
    const completedItems = items.filter((it) => it.linear);
    for (const it of completedItems) {
      it.id = workItemAnchor(it);
    }

    return Response.json({ items: completedItems });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
