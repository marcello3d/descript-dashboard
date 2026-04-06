"use client";

import { useMemo } from "react";
import { useServiceData } from "@/lib/hooks";
import { SiLinear, SiGithub } from "react-icons/si";
import type { LinearIssue, GitHubPR, CursorAgent, WorkItem } from "@/types";
import LinearStatus from "@/components/LinearStatus";

// Real Cursor logomark from their brand assets
function CursorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="400 395 167 190" fill="currentColor">
      <path d="M563.463 439.971L487.344 396.057C484.899 394.646 481.883 394.646 479.439 396.057L403.323 439.971C401.269 441.156 400 443.349 400 445.723V534.276C400 536.647 401.269 538.843 403.323 540.029L479.443 583.943C481.887 585.353 484.903 585.353 487.347 583.943L563.466 540.029C565.521 538.843 566.79 536.651 566.79 534.276V445.723C566.79 443.352 565.521 441.156 563.466 439.971H563.463ZM558.681 449.273L485.199 576.451C484.703 577.308 483.391 576.958 483.391 575.966V492.691C483.391 491.027 482.501 489.488 481.058 488.652L408.887 447.016C408.03 446.52 408.38 445.209 409.373 445.209H556.337C558.424 445.209 559.728 447.47 558.685 449.276H558.681V449.273Z" />
    </svg>
  );
}

function buildWorkItems(
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

  // Match PRs to issues by identifier in title/url, or by agent prUrl
  for (const pr of prs) {
    const prText = `${pr.title} ${pr.url}`.toLowerCase();
    let matched = false;
    for (const [key, item] of items) {
      if (prText.includes(key)) {
        item.pr = pr;
        matched = true;
        break;
      }
    }
    // Also try matching via agents that link this PR to an issue
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

function getLastUpdated(item: WorkItem): string {
  const dates = [
    item.linear?.updatedAt,
    item.pr?.updatedAt,
    ...item.agents.map((a) => a.createdAt),
  ].filter(Boolean) as string[];
  if (dates.length === 0) return "";
  return dates.sort().pop()!;
}

function timeAgo(dateStr: string): { text: string; color: string } {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let text: string;
  if (seconds < 60) text = "just now";
  else if (minutes < 60) text = `${minutes}m ago`;
  else if (hours < 24) text = `${hours}h ago`;
  else if (days < 30) text = `${days}d ago`;
  else text = `${Math.floor(days / 30)}mo ago`;

  if (hours < 24) return { text, color: "text-green-600" };
  if (days <= 3) return { text, color: "text-blue-500" };
  if (days <= 7) return { text, color: "text-yellow-600" };
  if (days <= 30) return { text, color: "text-orange-400" };
  return { text, color: "text-gray-300" };
}

function ReviewBadge({ decision, draft }: { decision: string | null; draft: boolean }) {
  if (draft) return <span className="text-xs text-gray-400">draft</span>;
  switch (decision) {
    case "APPROVED":
      return <span className="text-xs text-green-600">approved</span>;
    case "CHANGES_REQUESTED":
      return <span className="text-xs text-red-500">changes</span>;
    case "REVIEW_REQUIRED":
      return <span className="text-xs text-yellow-600">needs review</span>;
    default:
      return <span className="text-xs text-gray-400">open</span>;
  }
}

function AgentInfo({ agent }: { agent: CursorAgent }) {
  const s = agent.status.toLowerCase();
  const color =
    s === "running" || s === "in_progress"
      ? "text-green-600"
      : s === "finished"
      ? "text-blue-500"
      : s === "failed" || s === "error"
      ? "text-red-500"
      : "text-gray-400";

  const diff =
    agent.linesAdded || agent.linesRemoved
      ? ` +${agent.linesAdded} -${agent.linesRemoved}`
      : "";

  return (
    <span className="text-xs">
      <span className={color}>{s}</span>
      {diff && <span className="text-gray-400 ml-1 font-mono">{diff}</span>}
    </span>
  );
}

function ServiceHeader({
  label,
  connected,
}: {
  label: string;
  connected: boolean | null;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-400">
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected === null
            ? "bg-gray-300"
            : connected
            ? "bg-green-500"
            : "bg-red-400"
        }`}
      />
      {label}
    </span>
  );
}

export default function Home() {
  const linear = useServiceData<LinearIssue>("/api/linear/issues");
  const github = useServiceData<GitHubPR>("/api/github/prs");
  const cursor = useServiceData<CursorAgent>("/api/cursor/agents");

  const workItems = useMemo(
    () => buildWorkItems(linear.data ?? [], github.data ?? [], cursor.data ?? []),
    [linear.data, github.data, cursor.data]
  );

  const anyLoading = linear.loading || github.loading || cursor.loading;
  const refreshAll = () => {
    linear.refresh();
    github.refresh();
    cursor.refresh();
  };

  return (
    <div className="max-w-5xl mx-auto p-4">
      <header className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-bold text-gray-900">Dashboard</h1>
        <button
          onClick={refreshAll}
          disabled={anyLoading}
          className="text-gray-400 hover:text-gray-600 disabled:opacity-50 p-1"
          title="Refresh all"
        >
          <svg
            className={`w-4 h-4 ${anyLoading ? "animate-spin" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </header>

      {(linear.error || github.error || cursor.error) && (
        <div className="mb-3 space-y-1">
          {linear.error && <p className="text-xs text-red-500">Linear: {linear.error}</p>}
          {github.error && <p className="text-xs text-red-500">GitHub: {github.error}</p>}
          {cursor.error && <p className="text-xs text-red-500">Cursor: {cursor.error}</p>}
        </div>
      )}

      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-right py-2 px-2 w-[70px]">
              <span className="text-xs font-medium text-gray-500">Updated</span>
            </th>
            <th className="text-left py-2 px-2">
              <span className="text-xs font-medium text-gray-500">Item</span>
            </th>
            <th className="text-left py-2 px-2 w-[150px]">
              <ServiceHeader label="Linear" connected={linear.connected} />
            </th>
            <th className="text-left py-2 px-2 w-[140px]">
              <ServiceHeader label="GitHub" connected={github.connected} />
            </th>
            <th className="text-left py-2 px-2 w-[150px]">
              <ServiceHeader label="Cursor" connected={cursor.connected} />
            </th>
          </tr>
        </thead>
        <tbody>
          {workItems.map((item) => {
            const lastUpdated = getLastUpdated(item);
            return (
              <tr
                key={item.id}
                className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors"
              >
                {/* Updated column */}
                <td className="py-1.5 px-2 text-right">
                  {lastUpdated && (() => {
                    const { text, color } = timeAgo(lastUpdated);
                    return (
                      <span className={`text-xs ${color}`} title={new Date(lastUpdated).toLocaleString()}>
                        {text}
                      </span>
                    );
                  })()}
                </td>

                {/* Title */}
                <td className="py-1.5 px-2">
                  <span className="text-sm text-gray-900 line-clamp-1">
                    {item.title}
                  </span>
                </td>

                {/* Linear column */}
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {item.linear ? (
                    <a
                      href={item.linear.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="grid grid-cols-[auto_70px_1fr] items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-indigo-50 transition-colors"
                    >
                      <SiLinear className="w-3.5 h-3.5 text-[#5E6AD2] flex-shrink-0" />
                      <span className="text-xs text-gray-400 font-mono">
                        {item.linear.identifier}
                      </span>
                      <LinearStatus status={item.linear.status} />
                    </a>
                  ) : (
                    <div className="flex px-2">
                      <SiLinear className="w-3.5 h-3.5 text-gray-200" />
                    </div>
                  )}
                </td>

                {/* GitHub column */}
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {item.pr ? (
                    <a
                      href={item.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-gray-100 transition-colors"
                    >
                      <SiGithub className="w-3.5 h-3.5 text-gray-700 flex-shrink-0" />
                      <ReviewBadge decision={item.pr.reviewDecision} draft={item.pr.draft} />
                    </a>
                  ) : (
                    <div className="flex px-2">
                      <SiGithub className="w-3.5 h-3.5 text-gray-200" />
                    </div>
                  )}
                </td>

                {/* Cursor column */}
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {item.agents.length > 0 ? (
                    <a
                      href={item.agents[0].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-blue-50 transition-colors"
                    >
                      <CursorIcon className="w-3.5 h-3.5 text-gray-700 flex-shrink-0" />
                      <AgentInfo agent={item.agents[0]} />
                    </a>
                  ) : (
                    <div className="flex px-2">
                      <CursorIcon className="w-3.5 h-3.5 text-gray-200" />
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {workItems.length === 0 && !anyLoading && (
        <p className="text-sm text-gray-400 text-center py-12">
          No items to show. Check your API keys in .env.local
        </p>
      )}
    </div>
  );
}
