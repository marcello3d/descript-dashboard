import { updateIssueStatus } from "@/lib/linear";
import { invalidateCache } from "@/lib/cache";
import { errorMessage } from "@/lib/errors";
import { getEnv } from "@/lib/env";

export async function POST(request: Request) {
  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) {
    return Response.json({ error: "LINEAR_API_KEY not configured" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.issueId || !body?.stateId) {
    return Response.json(
      { error: "Missing required fields: issueId, stateId" },
      { status: 400 }
    );
  }

  try {
    const result = await updateIssueStatus(apiKey, body.issueId, body.stateId);
    // Invalidate Linear caches so next work-items fetch reflects the change
    invalidateCache("linear:raw:issues");
    invalidateCache("linear:raw:reviews");
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 502 });
  }
}
