import { NextResponse } from "next/server";
import { getApiCallStats, getRecentApiCalls } from "@/lib/cache";

export async function GET(request: Request) {
  const sinceParam = new URL(request.url).searchParams.get("since");
  const sinceMs = sinceParam ? parseInt(sinceParam) : undefined;

  return NextResponse.json({
    stats: getApiCallStats(sinceMs),
    recent: getRecentApiCalls(100),
  });
}
