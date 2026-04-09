import type { CursorAgent } from "@/types";

const CURSOR_API_BASE =
  process.env.CURSOR_API_BASE_URL ?? "https://api.cursor.com";

// Raw API response shape from Cursor
export interface RawCursorAgent {
  id: string;
  name?: string;
  status?: string;
  source?: { repository?: string };
  target?: { branchName?: string; url?: string; prUrl?: string | null };
  createdAt?: string;
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
}

export async function fetchRawAgents(apiKey: string): Promise<RawCursorAgent[]> {
  const res = await fetch(`${CURSOR_API_BASE}/v0/agents`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Cursor API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.agents ?? [];
}

export function transformAgent(agent: RawCursorAgent): CursorAgent {
  return {
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
  };
}

export function transformAgents(raw: RawCursorAgent[]): CursorAgent[] {
  return raw.map(transformAgent);
}

export async function createAgent(
  apiKey: string,
  repository: string,
  ref: string,
  prompt: string
): Promise<RawCursorAgent> {
  const res = await fetch(`${CURSOR_API_BASE}/v0/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: { text: prompt },
      source: { repository: `https://github.com/${repository}`, ref },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cursor API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }

  return res.json();
}
