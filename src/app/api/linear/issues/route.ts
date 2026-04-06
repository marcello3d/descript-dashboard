import { NextResponse } from "next/server";
import { fetchAssignedIssues } from "@/lib/linear";
import type { ServiceResponse, LinearIssue } from "@/types";

export async function GET() {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return NextResponse.json<ServiceResponse<LinearIssue>>({
      connected: false,
    });
  }

  try {
    const issues = await fetchAssignedIssues(apiKey);
    return NextResponse.json<ServiceResponse<LinearIssue>>({
      connected: true,
      data: issues,
    });
  } catch (e: any) {
    return NextResponse.json<ServiceResponse<LinearIssue>>({
      connected: true,
      error: e.message,
    });
  }
}
