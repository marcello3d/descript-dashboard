import { NextResponse } from "next/server";
import { fetchAssignedIssues } from "@/lib/linear";
import { getCached, setCache, logApiCall, dedupe } from "@/lib/cache";
import type { ServiceResponse, LinearIssue } from "@/types";

const CACHE_KEY = "linear:issues";
const CACHE_KEY_RATE = "linear:rateLimit";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const CACHE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=300",
};

export async function GET(request: Request) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return NextResponse.json<ServiceResponse<LinearIssue>>(
      { connected: false },
      { headers: CACHE_HEADERS }
    );
  }

  const bypass = new URL(request.url).searchParams.get("fresh") === "1";

  try {
    if (!bypass) {
      const cached = getCached<LinearIssue[]>(CACHE_KEY);
      if (cached) {
        logApiCall("linear", "issues", "cached", 0);
        const rl = getCached<ServiceResponse<LinearIssue>["rateLimit"]>(CACHE_KEY_RATE);
        return NextResponse.json<ServiceResponse<LinearIssue>>(
          { connected: true, data: cached, rateLimit: rl ?? undefined },
          { headers: CACHE_HEADERS }
        );
      }
    }

    const start = Date.now();
    const { issues, rateLimit } = await dedupe("linear:issues", () => fetchAssignedIssues(apiKey));
    logApiCall("linear", "issues", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache(CACHE_KEY, issues, CACHE_TTL);
    if (rateLimit) setCache(CACHE_KEY_RATE, rateLimit, CACHE_TTL);
    return NextResponse.json<ServiceResponse<LinearIssue>>(
      { connected: true, data: issues, rateLimit },
      { headers: CACHE_HEADERS }
    );
  } catch (e: any) {
    const stale = getCached<LinearIssue[]>(CACHE_KEY, true);
    if (stale) {
      return NextResponse.json<ServiceResponse<LinearIssue>>(
        { connected: true, data: stale },
        { headers: CACHE_HEADERS }
      );
    }
    logApiCall("linear", "issues", "error", 0, { error: e.message });
    return NextResponse.json<ServiceResponse<LinearIssue>>(
      { connected: true, error: e.message },
    );
  }
}
