import type { CursorAgent } from "@/types";

const CURSOR_API_BASE =
  process.env.CURSOR_API_BASE_URL ?? "https://api.cursor.com";

export async function fetchBGAJobs(apiKey: string): Promise<CursorAgent[]> {
  const res = await fetch(`${CURSOR_API_BASE}/v0/agents`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Cursor API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const agents = data.agents ?? [];

  return agents.map((agent: any) => ({
    id: agent.id,
    name: agent.name ?? "",
    status: agent.status ?? "unknown",
    repo: agent.source?.repository?.replace("github.com/", "") ?? "",
    branch: agent.target?.branchName ?? "",
    url: agent.target?.url ?? `https://cursor.com/agents/${agent.id}`,
    prUrl: agent.target?.prUrl ?? null,
    createdAt: agent.createdAt ?? "",
    linesAdded: agent.linesAdded ?? 0,
    linesRemoved: agent.linesRemoved ?? 0,
    filesChanged: agent.filesChanged ?? 0,
  }));
}
