import { NextResponse } from "next/server";
import { fetchAuthoredPRs } from "@/lib/github";
import type { ServiceResponse, GitHubPR } from "@/types";

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json<ServiceResponse<GitHubPR>>({ connected: false });
  }

  try {
    const prs = await fetchAuthoredPRs(token);
    return NextResponse.json<ServiceResponse<GitHubPR>>({
      connected: true,
      data: prs,
    });
  } catch (e: any) {
    return NextResponse.json<ServiceResponse<GitHubPR>>({
      connected: true,
      error: e.message,
    });
  }
}
