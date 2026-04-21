import { resetAll } from "@/lib/db";

export async function DELETE() {
  resetAll();
  return Response.json({ ok: true });
}
