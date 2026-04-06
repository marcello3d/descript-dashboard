import { NextResponse } from "next/server";
import { fetchBGAJobs } from "@/lib/cursor";
import type { ServiceResponse, CursorAgent } from "@/types";

export async function GET() {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json<ServiceResponse<CursorAgent>>({
      connected: false,
    });
  }

  try {
    const agents = await fetchBGAJobs(apiKey);
    return NextResponse.json<ServiceResponse<CursorAgent>>({
      connected: true,
      data: agents,
    });
  } catch (e: any) {
    return NextResponse.json<ServiceResponse<CursorAgent>>({
      connected: true,
      error: e.message,
    });
  }
}
