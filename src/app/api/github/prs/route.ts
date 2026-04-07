import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { fetchAuthoredPRs } from "@/lib/github";
import { getCached, setCache, logApiCall, dedupe } from "@/lib/cache";
import type { ServiceResponse, GitHubPR } from "@/types";

const CACHE_KEY = "github:prs";
const CACHE_KEY_RATE = "github:rateLimit";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const CACHE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=300",
};

export async function GET(request: Request) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json<ServiceResponse<GitHubPR>>(
      { connected: false },
      { headers: CACHE_HEADERS }
    );
  }

  const bypass = new URL(request.url).searchParams.get("fresh") === "1";

  try {
    if (!bypass) {
      const cached = getCached<GitHubPR[]>(CACHE_KEY);
      if (cached) {
        logApiCall("github", "prs", "cached", 0);
        const rl = getCached<ServiceResponse<GitHubPR>["rateLimit"]>(CACHE_KEY_RATE);
        return NextResponse.json<ServiceResponse<GitHubPR>>(
          { connected: true, data: cached, rateLimit: rl ?? undefined },
          { headers: CACHE_HEADERS }
        );
      }
    }

    const start = Date.now();
    const { prs, rateLimit } = await dedupe("github:prs", () => fetchAuthoredPRs(token));
    logApiCall("github", "prs", "ok", Date.now() - start, { cost: rateLimit?.cost });
    setCache(CACHE_KEY, prs, CACHE_TTL);
    if (rateLimit) setCache(CACHE_KEY_RATE, rateLimit, CACHE_TTL);
    return NextResponse.json<ServiceResponse<GitHubPR>>(
      { connected: true, data: prs, rateLimit },
      { headers: CACHE_HEADERS }
    );
  } catch (e: any) {
    const stale = getCached<GitHubPR[]>(CACHE_KEY, true);
    let rl = getCached<ServiceResponse<GitHubPR>["rateLimit"]>(CACHE_KEY_RATE, true);

    // Try to get rate limit info even on error
    if (!rl) {
      try {
        const octokit = new Octokit({ auth: token });
        const resp = await octokit.rest.rateLimit.get();
        const graphql = resp.data.resources.graphql;
        if (graphql) {
          rl = {
            remaining: graphql.remaining,
            limit: graphql.limit,
            resetAt: new Date(graphql.reset * 1000).toISOString(),
          };
          setCache(CACHE_KEY_RATE, rl, 5 * 60 * 1000);
        }
      } catch {
        // rate limit endpoint itself may be limited
      }
    }

    logApiCall("github", "prs", "error", 0, { error: e.message });
    return NextResponse.json<ServiceResponse<GitHubPR>>(
      {
        connected: true,
        data: stale ?? undefined,
        error: e.message,
        rateLimit: rl ?? undefined,
      },
      { headers: CACHE_HEADERS }
    );
  }
}
