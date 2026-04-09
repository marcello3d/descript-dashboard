import { createAgent, transformAgent } from "@/lib/cursor";
import { invalidateCache } from "@/lib/cache";

export async function POST(request: Request) {
  const apiKey = process.env.CURSOR_API_KEY;
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
    // Invalidate cursor cache so the next work-items fetch picks up the new agent
    invalidateCache("cursor:raw:agents");
    return Response.json({ agent: transformAgent(raw) });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
