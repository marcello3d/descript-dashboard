import { fetchWorkflowStatesForIssue } from "@/lib/linear";
import { errorMessage } from "@/lib/errors";
import { getEnv } from "@/lib/env";

export async function GET(request: Request) {
  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) {
    return Response.json({ error: "LINEAR_API_KEY not configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const issueId = searchParams.get("issueId");
  if (!issueId) {
    return Response.json({ error: "Missing required param: issueId" }, { status: 400 });
  }

  try {
    const states = await fetchWorkflowStatesForIssue(apiKey, issueId);
    return Response.json({ states });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 502 });
  }
}
