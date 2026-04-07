import { NextResponse } from "next/server";
import { fetchIssuesByIdentifiers } from "@/lib/linear";
import { getCached, setCache, logApiCall, dedupe } from "@/lib/cache";
import type { ServiceResponse, LinearIssue } from "@/types";

const CACHE_TTL = 5 * 60 * 1000;

export async function GET(request: Request) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return NextResponse.json<ServiceResponse<LinearIssue>>({ connected: false });
  }

  const ids = new URL(request.url).searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
  if (ids.length === 0) {
    return NextResponse.json<ServiceResponse<LinearIssue>>({ connected: true, data: [] });
  }

  const cacheKey = `linear:lookup:${ids.sort().join(",")}`;
  const cached = getCached<LinearIssue[]>(cacheKey);
  if (cached) {
    logApiCall("linear", "lookup", "cached", 0);
    return NextResponse.json<ServiceResponse<LinearIssue>>({ connected: true, data: cached });
  }

  try {
    const start = Date.now();
    const issues = await dedupe(cacheKey, () => fetchIssuesByIdentifiers(apiKey, ids));
    logApiCall("linear", "lookup", "ok", Date.now() - start);
    setCache(cacheKey, issues, CACHE_TTL);
    return NextResponse.json<ServiceResponse<LinearIssue>>({ connected: true, data: issues });
  } catch (e: any) {
    logApiCall("linear", "lookup", "error", 0, { error: e.message });
    return NextResponse.json<ServiceResponse<LinearIssue>>({ connected: true, error: e.message });
  }
}
