import { createAgent, transformAgent } from "@/lib/cursor";
import { resetSyncStatus } from "@/lib/db";
import { errorMessage } from "@/lib/errors";
import { getEnv } from "@/lib/env";

export async function POST(request: Request) {
  const apiKey = getEnv("CURSOR_API_KEY");
  if (!apiKey) {
    return Response.json({ error: "CURSOR_API_KEY not configured" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.repository || !body?.ref || !body?.prompt) {
    return Response.json(
      { error: "Missing required fields: repository, ref, prompt" },
      { status: 400 }
    );
  }

  try {
    const raw = await createAgent(apiKey, body.repository, body.ref, body.prompt);
    resetSyncStatus("cursor");
    return Response.json({ agent: transformAgent(raw) });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 502 });
  }
}
