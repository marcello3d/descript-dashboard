import { NextResponse } from "next/server";
import { fetchBGAJobs } from "@/lib/cursor";
import { getCached, setCache, logApiCall, dedupe } from "@/lib/cache";
import type { ServiceResponse, CursorAgent } from "@/types";

const CACHE_KEY = "cursor:agents";
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

const CACHE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=300",
};

export async function GET(request: Request) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json<ServiceResponse<CursorAgent>>(
      { connected: false },
      { headers: CACHE_HEADERS }
    );
  }

  const bypass = new URL(request.url).searchParams.get("fresh") === "1";

  try {
    if (!bypass) {
      const cached = getCached<CursorAgent[]>(CACHE_KEY);
      if (cached) {
        logApiCall("cursor", "agents", "cached", 0);
        return NextResponse.json<ServiceResponse<CursorAgent>>(
          { connected: true, data: cached },
          { headers: CACHE_HEADERS }
        );
      }
    }

    const start = Date.now();
    const agents = await dedupe("cursor:agents", () => fetchBGAJobs(apiKey));
    logApiCall("cursor", "agents", "ok", Date.now() - start);
    setCache(CACHE_KEY, agents, CACHE_TTL);
    return NextResponse.json<ServiceResponse<CursorAgent>>(
      { connected: true, data: agents },
      { headers: CACHE_HEADERS }
    );
  } catch (e: any) {
    const stale = getCached<CursorAgent[]>(CACHE_KEY, true);
    if (stale) {
      return NextResponse.json<ServiceResponse<CursorAgent>>(
        { connected: true, data: stale },
        { headers: CACHE_HEADERS }
      );
    }
    logApiCall("cursor", "agents", "error", 0, { error: e.message });
    return NextResponse.json<ServiceResponse<CursorAgent>>(
      { connected: true, error: e.message },
    );
  }
}
