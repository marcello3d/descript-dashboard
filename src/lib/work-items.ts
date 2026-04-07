import type { LinearIssue, GitHubPR, CursorAgent, WorkItem } from "@/types";

const IDENTIFIER_RE = /[A-Z]+-\d+/gi;

export function buildWorkItems(
  issues: LinearIssue[],
  prs: GitHubPR[],
  agents: CursorAgent[]
): WorkItem[] {
  const items = new Map<string, WorkItem>();

  // Start with Linear issues
  for (const issue of issues) {
    items.set(issue.identifier.toLowerCase(), {
      id: issue.identifier,
      title: issue.title,
      linear: issue,
      agents: [],
    });
  }

  // Match PRs to issues by: Linear attachments, identifier in title/url, or agent prUrl
  for (const pr of prs) {
    let matched = false;

    // 1. Match by Linear attachment (issue has this PR URL linked)
    for (const [, item] of items) {
      if (item.linear?.prUrls.includes(pr.url)) {
        item.pr = pr;
        matched = true;
        break;
      }
    }

    // 2. Match by identifier in PR title/url/branch
    if (!matched) {
      const prText = `${pr.title} ${pr.url} ${pr.branch}`.toLowerCase();
      for (const [key, item] of items) {
        if (prText.includes(key)) {
          item.pr = pr;
          matched = true;
          break;
        }
      }
    }

    // 3. Match via agents that link this PR to an issue
    if (!matched) {
      for (const agent of agents) {
        if (agent.prUrl === pr.url) {
          const agentText = `${agent.branch} ${agent.name}`.toLowerCase();
          for (const [key, item] of items) {
            if (item.linear && agentText.includes(key)) {
              item.pr = pr;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
    }

    if (!matched) {
      const id = `pr-${pr.id}`;
      items.set(id, { id, title: pr.title, pr, agents: [] });
    }
  }

  // Match agents
  for (const agent of agents) {
    let matched = false;
    // Match by PR URL
    if (agent.prUrl) {
      for (const [, item] of items) {
        if (item.pr?.url === agent.prUrl) {
          item.agents.push(agent);
          matched = true;
          break;
        }
      }
    }
    // Match by issue identifier in branch/name
    if (!matched) {
      const agentText = `${agent.branch} ${agent.name}`.toLowerCase();
      for (const [key, item] of items) {
        if (item.linear && agentText.includes(key)) {
          item.agents.push(agent);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      const id = `agent-${agent.id}`;
      items.set(id, { id, title: agent.name || agent.id, agents: [agent] });
    }
  }

  return Array.from(items.values()).sort((a, b) => {
    return getLastUpdated(b).localeCompare(getLastUpdated(a));
  });
}

export function getLastUpdated(item: WorkItem): string {
  const dates = [
    item.linear?.updatedAt,
    item.pr?.updatedAt,
    ...item.agents.map((a) => a.createdAt),
  ].filter(Boolean) as string[];
  if (dates.length === 0) return "";
  return dates.sort().pop()!;
}

export function getLastUpdatedSource(item: WorkItem): { date: string; source: string } | null {
  const entries: { date: string; source: string }[] = [];
  if (item.linear?.updatedAt) entries.push({ date: item.linear.updatedAt, source: "Linear" });
  if (item.pr?.updatedAt) entries.push({ date: item.pr.updatedAt, source: "GitHub" });
  for (const a of item.agents) {
    if (a.createdAt) entries.push({ date: a.createdAt, source: "Cursor" });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries.pop()!;
}

/**
 * Find Linear identifiers referenced in PRs/agents that aren't in the known issues list.
 */
export function findMissingLinearIds(
  items: WorkItem[],
  knownIdentifiers: Set<string>
): string[] {
  const missing = new Set<string>();
  for (const item of items) {
    if (item.linear) continue;
    const text = `${item.pr?.branch ?? ""} ${item.pr?.title ?? ""} ${item.agents.map(a => `${a.branch} ${a.name}`).join(" ")}`;
    for (const match of text.matchAll(IDENTIFIER_RE)) {
      const id = match[0].toUpperCase();
      if (!knownIdentifiers.has(id.toLowerCase())) missing.add(id);
    }
  }
  return [...missing];
}
