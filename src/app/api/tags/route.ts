import { addWorkItemTag, removeWorkItemTag } from "@/lib/db";

export async function POST(request: Request) {
  const { workItemId, tag } = await request.json();
  if (!workItemId || !tag) {
    return Response.json({ error: "workItemId and tag required" }, { status: 400 });
  }
  const tags = addWorkItemTag(workItemId, tag);
  return Response.json({ tags });
}

export async function DELETE(request: Request) {
  const { workItemId, tag } = await request.json();
  if (!workItemId || !tag) {
    return Response.json({ error: "workItemId and tag required" }, { status: 400 });
  }
  const tags = removeWorkItemTag(workItemId, tag);
  return Response.json({ tags });
}
