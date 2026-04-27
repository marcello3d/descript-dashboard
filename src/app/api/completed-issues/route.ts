import { fetchRawCompletedIssues, transformIssues, type RawLinearResult } from "@/lib/linear";
import { getEnv } from "@/lib/env";
import { getCached, setCache, dedupe, logApiCall } from "@/lib/cache";

const CACHE_KEY = "linear_completed_issues";
const TTL_MS = 5 * 60 * 1000;

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
    return Response.json({ issues: transformIssues(cached.issues) });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
