import { NextResponse } from "next/server";
import { fetchAssignedIssues } from "@/lib/linear";
import { getCached, setCache } from "@/lib/cache";
import type { ServiceResponse, LinearIssue } from "@/types";

const CACHE_KEY = "linear:issues";
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
        return NextResponse.json<ServiceResponse<LinearIssue>>(
          { connected: true, data: cached },
          { headers: CACHE_HEADERS }
        );
      }
    }

    const issues = await fetchAssignedIssues(apiKey);
    setCache(CACHE_KEY, issues, CACHE_TTL);
    return NextResponse.json<ServiceResponse<LinearIssue>>(
      { connected: true, data: issues },
      { headers: CACHE_HEADERS }
    );
  } catch (e: any) {
    const stale = getCached<LinearIssue[]>(CACHE_KEY);
    if (stale) {
      return NextResponse.json<ServiceResponse<LinearIssue>>(
        { connected: true, data: stale },
        { headers: CACHE_HEADERS }
      );
    }
    return NextResponse.json<ServiceResponse<LinearIssue>>(
      { connected: true, error: e.message },
    );
  }
}
