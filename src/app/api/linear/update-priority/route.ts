import { updateIssuePriority } from "@/lib/linear";
import { invalidateCache } from "@/lib/cache";
import { errorMessage } from "@/lib/errors";
import { getEnv } from "@/lib/env";

export async function POST(request: Request) {
  const apiKey = getEnv("LINEAR_API_KEY");
  if (!apiKey) {
    return Response.json({ error: "LINEAR_API_KEY not configured" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  // priority 0 is valid ("No priority"), so check type rather than truthiness
  if (!body?.issueId || !Number.isInteger(body.priority) || body.priority < 0 || body.priority > 4) {
    return Response.json(
      { error: "Missing required fields: issueId, priority (0-4)" },
      { status: 400 }
    );
  }

  try {
    const result = await updateIssuePriority(apiKey, body.issueId, body.priority);
    // Invalidate Linear caches so next work-items fetch reflects the change
    invalidateCache("linear:raw:issues");
    invalidateCache("linear:raw:reviews");
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 502 });
  }
}
