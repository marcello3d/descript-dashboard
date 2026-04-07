"use client";

import { useEffect, useMemo, useState } from "react";
import { useServiceData } from "@/lib/hooks";
import { SiLinear, SiGithub } from "react-icons/si";
import type { LinearIssue, GitHubPR, CursorAgent, WorkItem } from "@/types";
import LinearStatus, { StatusIcon } from "@/components/LinearStatus";

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

const priorityConfig: Record<number, { label: string; color: string }> = {
  1: { label: "P0", color: "text-red-600" },
  2: { label: "P1", color: "text-orange-500" },
  3: { label: "P2", color: "text-gray-400" },
  4: { label: "P3", color: "text-gray-300" },
};

function PriorityBadge({ priority }: { priority: number }) {
  const config = priorityConfig[priority];
  if (!config) return null;
  return (
    <span className={`text-[10px] font-mono font-medium ${config.color}`}>
      {config.label}
    </span>
  );
}

function ChecksIcon({ state }: { state: string | null }) {
  if (!state) return null;
  switch (state) {
    case "SUCCESS":
      return <span className="text-green-500" title="Checks passing">&#10003;</span>;
    case "FAILURE":
    case "ERROR":
      return <span className="text-red-500" title="Checks failing">&#10005;</span>;
    case "PENDING":
    case "EXPECTED":
      return <span className="text-yellow-500" title="Checks pending">&#9679;</span>;
    default:
      return null;
  }
}

function ReviewBadge({ decision, draft, merged, checksState }: { decision: string | null; draft: boolean; merged: boolean; checksState: string | null }) {
  let label: React.ReactNode;
  if (merged) label = <span className="text-xs text-purple-600">merged</span>;
  else if (draft) label = <span className="text-xs text-gray-400">draft</span>;
  else switch (decision) {
    case "APPROVED":
      label = <span className="text-xs text-green-600">approved</span>; break;
    case "CHANGES_REQUESTED":
      label = <span className="text-xs text-red-500">changes</span>; break;
    case "REVIEW_REQUIRED":
      label = <span className="text-xs text-yellow-600">needs review</span>; break;
    default:
      label = <span className="text-xs text-gray-400">open</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      {!merged && <span className="text-[10px]"><ChecksIcon state={checksState} /></span>}
    </span>
  );
}

function UnifiedStatus({ item }: { item: WorkItem }) {
  const linearIcon = item.linear
    ? <StatusIcon status={item.linear.status} />
    : <StatusIcon status="In Progress" />;

  // PR exists → show Linear icon + GitHub-derived status
  if (item.pr) {
    let label: React.ReactNode;
    if (item.pr.merged) label = <span className="text-xs text-purple-600">PR merged</span>;
    else if (item.pr.reviewDecision === "CHANGES_REQUESTED")
      label = <span className="text-xs text-red-500">PR changes requested</span>;
    else if (item.pr.reviewDecision === "APPROVED")
      label = <span className="text-xs text-green-600">PR approved</span>;
    else if (item.pr.draft) label = <span className="text-xs text-gray-400">PR draft</span>;
    else if (item.pr.reviewDecision === "REVIEW_REQUIRED")
      label = <span className="text-xs text-yellow-600">PR in review</span>;
    else label = <span className="text-xs text-gray-400">PR open</span>;
    return <span className="inline-flex items-center gap-1 leading-none">{linearIcon}{label}</span>;
  }

  // No PR, has Linear → show icon + Linear status text
  if (item.linear) {
    return (
      <span className="inline-flex items-center gap-1 leading-none">
        {linearIcon}
        <span className="text-xs text-gray-500">{item.linear.status}</span>
      </span>
    );
  }

  // Only Cursor agent (no linear/PR) → show backlog icon + "No PR"
  if (item.agents.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 leading-none">
        <StatusIcon status="Backlog" />
        <span className="text-xs text-gray-400">No PR</span>
      </span>
    );
  }

  return linearIcon;
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="text-[11px] font-mono">
      {additions > 0 && <span className="text-green-600">+{additions}</span>}
      {additions > 0 && deletions > 0 && <span className="text-gray-300"> </span>}
      {deletions > 0 && <span className="text-red-500">-{deletions}</span>}
    </span>
  );
}

function AgentInfo({ agent }: { agent: CursorAgent }) {
  const s = agent.status.toLowerCase();
  const color =
    s === "running" || s === "in_progress"
      ? "text-green-600"
      : s === "failed" || s === "error"
      ? "text-red-500"
      : "text-gray-400";

  const showStatus = s !== "finished";

  return (
    <span className="text-xs inline-flex items-center gap-1">
      {showStatus && <span className={color}>{s}</span>}
    </span>
  );
}

function ServiceHeader({
  label,
  connected,
  error,
}: {
  label: string;
  connected: boolean | null;
  error?: string | null;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-400">
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          error
            ? "bg-red-500"
            : connected === null
            ? "bg-gray-300"
            : connected
            ? "bg-green-500"
            : "bg-red-400"
        }`}
      />
      {label}
      {error && <span className="text-red-500" title={error}>!</span>}
    </span>
  );
}

function WorkItemTable({
  groups,
  linear,
  github,
  cursor,
  dimmed,
}: {
  groups: { label: string; items: WorkItem[] }[];
  linear: { connected: boolean | null; error?: string | null };
  github: { connected: boolean | null; error?: string | null };
  cursor: { connected: boolean | null; error?: string | null };
  dimmed?: boolean;
}) {
  const colCount = 8;
  return (
    <table className={`w-full ${dimmed ? "opacity-60" : ""}`}>
      <thead>
        <tr className="border-b border-gray-200">
          <th className="text-right py-2 px-2 w-[70px]">
            <span className="text-xs font-medium text-gray-500">Updated</span>
          </th>
          <th className="text-left py-2 px-2">
            <span className="text-xs font-medium text-gray-500">Item</span>
          </th>
          <th className="text-center py-2 px-2 w-[24px]"></th>
          <th className="text-left py-2 px-2 w-px whitespace-nowrap">
            <ServiceHeader label="Linear" connected={linear.connected} error={linear.error} />
          </th>
          <th className="text-left py-2 px-2 w-px whitespace-nowrap">
            <ServiceHeader label="GitHub" connected={github.connected} error={github.error} />
          </th>
          <th className="text-left py-2 px-2 w-px whitespace-nowrap">
            <ServiceHeader label="Cursor" connected={cursor.connected} error={cursor.error} />
          </th>
          <th className="text-left py-2 px-2 w-[120px]">
            <span className="text-xs font-medium text-gray-500">Status</span>
          </th>
          <th className="text-right py-2 px-2 w-px whitespace-nowrap">
            <span className="text-xs font-medium text-gray-500">Changes</span>
          </th>
        </tr>
      </thead>
      {groups.map(({ label, items }) => (
      <tbody key={label}>
        {groups.length > 1 && (
          <tr>
            <td colSpan={colCount} className="pt-4 pb-1 px-2">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label} <span className="font-normal">({items.length})</span></span>
            </td>
          </tr>
        )}
        {items.map((item) => {
          const lastUpdated = getLastUpdated(item);
          return (
            <tr
              key={item.id}
              className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors"
            >
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
              <td className="py-1.5 px-2">
                <a
                  href={item.linear?.url ?? item.pr?.url ?? item.agents[0]?.url ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-900 hover:text-blue-600 transition-colors line-clamp-1"
                >
                  {item.title}
                </a>
              </td>
              <td className="py-1.5 px-0 text-center w-[24px]">
                {item.linear && item.linear.priority > 0 && (
                  <PriorityBadge priority={item.linear.priority} />
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.linear ? (
                  <a
                    href={item.linear.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-indigo-50 transition-colors"
                  >
                    <SiLinear className="w-3.5 h-3.5 text-[#5E6AD2] flex-shrink-0" />
                    <span className="text-xs text-gray-400 font-mono">
                      {item.linear.identifier}
                    </span>
                  </a>
                ) : (
                  <div className="flex px-2">
                    <SiLinear className="w-3.5 h-3.5 text-gray-200" />
                  </div>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.pr ? (
                  <a
                    href={item.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-gray-100 transition-colors"
                  >
                    <SiGithub className="w-3.5 h-3.5 text-gray-700 flex-shrink-0" />
                    <span className="text-xs text-gray-400 font-mono">#{item.pr.url.split("/").pop()}</span>
                  </a>
                ) : item.linear?.prUrls?.[0] ? (
                  <a
                    href={item.linear.prUrls[0]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-gray-100 transition-colors"
                  >
                    <SiGithub className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <span className="text-xs text-gray-400 font-mono">#{item.linear.prUrls[0].split("/").pop()}</span>
                  </a>
                ) : (
                  <div className="flex px-2">
                    <SiGithub className="w-3.5 h-3.5 text-gray-200" />
                  </div>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.agents.length > 0 ? (
                  <a
                    href={item.agents[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-blue-50 transition-colors"
                  >
                    <CursorIcon className="w-3.5 h-3.5 text-gray-700 flex-shrink-0" />
                    <span className="text-xs text-gray-400">Cursor</span>
                    <AgentInfo agent={item.agents[0]} />
                  </a>
                ) : (
                  <div className="flex px-2">
                    <CursorIcon className="w-3.5 h-3.5 text-gray-200" />
                  </div>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                <div className="flex items-center py-1.5 px-2 -my-1">
                  <UnifiedStatus item={item} />
                </div>
              </td>
              {(() => {
                const files = item.pr?.changedFiles ?? item.agents[0]?.filesChanged ?? 0;
                const add = item.pr?.additions ?? item.agents[0]?.linesAdded ?? 0;
                const del = item.pr?.deletions ?? item.agents[0]?.linesRemoved ?? 0;
                const prUrl = item.pr?.url ?? item.linear?.prUrls?.[0] ?? null;
                const changesUrl = prUrl ? `${prUrl}/files` : null;
                const hasContent = files > 0 || add > 0 || del > 0;
                const inner = hasContent ? (
                  <span className="inline-flex items-center text-xs">
                    <span className="text-gray-400 text-right w-[40px] flex-shrink-0">{files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : ""}</span>
                    <span className="w-2 flex-shrink-0" />
                    {(add > 0 || del > 0) ? <DiffStats additions={add} deletions={del} /> : null}
                  </span>
                ) : null;
                return (
                  <td className="py-1.5 px-1 whitespace-nowrap">
                    {inner && changesUrl ? (
                      <a href={changesUrl} target="_blank" rel="noopener noreferrer" className="py-1.5 px-2 -my-1 rounded hover:bg-gray-100 transition-colors inline-flex">{inner}</a>
                    ) : inner}
                  </td>
                );
              })()}
            </tr>
          );
        })}
      </tbody>
      ))}
    </table>
  );
}

type FilterMode = "open" | "closed" | "all";
type SortMode = "date" | "priority";

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-gray-200 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`text-xs px-2.5 py-1 transition-colors ${
            value === opt.value
              ? "bg-gray-900 text-white"
              : "bg-white text-gray-500 hover:bg-gray-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

type ActionGroup = "ready" | "review" | "changes" | "draft" | "other";

function getActionGroup(item: WorkItem): ActionGroup {
  if (item.pr) {
    if (item.pr.merged) return "other";
    if (item.pr.reviewDecision === "APPROVED") return "ready";
    if (item.pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
    if (item.pr.draft) return "draft";
    return "review";
  }
  return "draft";
}

const ACTION_GROUP_LABELS: Record<ActionGroup, string> = {
  ready: "Ready to merge",
  review: "Waiting on review",
  changes: "Changes requested",
  draft: "In progress",
  other: "Other",
};

const ACTION_GROUP_ORDER: ActionGroup[] = ["ready", "changes", "review", "draft", "other"];

function groupByAction(items: WorkItem[]): { group: ActionGroup; label: string; items: WorkItem[] }[] {
  const map = new Map<ActionGroup, WorkItem[]>();
  for (const item of items) {
    const g = getActionGroup(item);
    const list = map.get(g) || [];
    list.push(item);
    map.set(g, list);
  }
  return ACTION_GROUP_ORDER
    .filter(g => map.has(g))
    .map(g => ({ group: g, label: ACTION_GROUP_LABELS[g], items: map.get(g)! }));
}

function sortItems(items: WorkItem[], sort: SortMode): WorkItem[] {
  return [...items].sort((a, b) => {
    if (sort === "priority") {
      // Priority: 1=urgent, 4=low, 0=none. Put 0 last.
      const ap = a.linear?.priority ?? 0;
      const bp = b.linear?.priority ?? 0;
      const aNorm = ap === 0 ? 99 : ap;
      const bNorm = bp === 0 ? 99 : bp;
      if (aNorm !== bNorm) return aNorm - bNorm;
    }
    return getLastUpdated(b).localeCompare(getLastUpdated(a));
  });
}

export default function Home() {
  const linear = useServiceData<LinearIssue>("/api/linear/issues");
  const github = useServiceData<GitHubPR>("/api/github/prs");
  const cursor = useServiceData<CursorAgent>("/api/cursor/agents");

  const [filter, setFilter] = useState<FilterMode>("open");
  const [sort, setSort] = useState<SortMode>("date");
  const [repoFilter, setRepoFilter] = useState<string>("descript");

  const allUnfilteredItems = useMemo(
    () => buildWorkItems(linear.data ?? [], github.data ?? [], cursor.data ?? []),
    [linear.data, github.data, cursor.data]
  );

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const item of allUnfilteredItems) {
      if (item.pr) set.add(item.pr.repo.split("/").pop()!);
      if (item.agents.length > 0) set.add(item.agents[0].repo.split("/").pop()!);
    }
    return Array.from(set).sort();
  }, [allUnfilteredItems]);

  const allItems = useMemo(() => {
    if (repoFilter === "all") return allUnfilteredItems;
    return allUnfilteredItems.filter(item => {
      const repo = item.pr?.repo ?? item.agents[0]?.repo ?? "";
      return repo.endsWith(`/${repoFilter}`) || repo === repoFilter || (!item.pr && item.agents.length === 0);
    });
  }, [allUnfilteredItems, repoFilter]);

  const { open, closed } = useMemo(() => {
    const open: WorkItem[] = [];
    const closed: WorkItem[] = [];
    for (const item of allItems) {
      const cursorOnly = !item.linear && !item.pr && item.agents.length > 0;
      const isClosed =
        item.pr?.merged ||
        item.linear?.status.toLowerCase() === "canceled" ||
        item.linear?.status.toLowerCase() === "cancelled" ||
        cursorOnly;
      if (isClosed) {
        closed.push(item);
      } else {
        open.push(item);
      }
    }
    return { open, closed };
  }, [allItems]);

  const displayGroups = useMemo(() => {
    const items =
      filter === "open" ? open : filter === "closed" ? closed : allItems;
    const sorted = sortItems(items, sort);
    if (filter === "open") {
      return groupByAction(sorted);
    }
    return [{ group: "other" as ActionGroup, label: "", items: sorted }];
  }, [filter, sort, open, closed, allItems]);

  const displayItems = displayGroups.flatMap(g => g.items);

  useEffect(() => {
    if (displayGroups.length === 0 || filter !== "open") {
      document.title = "Dashboard";
      return;
    }
    const parts = displayGroups
      .filter(g => g.group !== "draft" && g.group !== "other")
      .map(g => `${g.items.length} ${g.label.toLowerCase()}`);
    document.title = parts.length > 0 ? `(${parts.join(", ")}) Dashboard` : "Dashboard";
  }, [displayGroups, filter]);

  const anyLoading = linear.loading || github.loading || cursor.loading;
  const refreshAll = () => {
    linear.refresh();
    github.refresh();
    cursor.refresh();
  };

  return (
    <div className="max-w-5xl mx-auto p-4">
      <header className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-bold text-gray-900">
          Dashboard
          {filter === "open" && displayGroups.length > 0 && (
            <span className="text-sm font-normal text-gray-400 ml-2">
              {displayGroups.map(g => `${g.items.length} ${g.label.toLowerCase()}`).join(" · ")}
            </span>
          )}
        </h1>
        <div className="flex items-center gap-3">
          <ToggleGroup
            options={[
              { value: "open" as FilterMode, label: "Open" },
              { value: "closed" as FilterMode, label: "Closed" },
              { value: "all" as FilterMode, label: "All" },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <ToggleGroup
            options={[
              { value: "date" as SortMode, label: "Date" },
              { value: "priority" as SortMode, label: "Priority" },
            ]}
            value={sort}
            onChange={setSort}
          />
          {repos.length > 1 && (
            <select
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              className="text-xs border border-gray-200 rounded-md px-2 py-1 text-gray-600 bg-white"
            >
              <option value="all">All repos</option>
              {repos.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
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
          {github.rateLimit && (
            <span className={`text-[11px] tabular-nums ${github.rateLimit.remaining < 100 ? "text-yellow-600" : "text-gray-300"}`} title={`Resets ${new Date(github.rateLimit.resetAt).toLocaleTimeString()}`}>
              {github.rateLimit.remaining}/{github.rateLimit.limit}
            </span>
          )}
        </div>
      </header>

      {(linear.error || github.error || cursor.error) && (
        <div className="mb-3 space-y-1">
          {linear.error && <p className="text-xs text-red-500">Linear: {linear.error}</p>}
          {github.error && (
            <p className="text-xs text-red-500">
              GitHub: {github.error}
              {github.rateLimit && <> &middot; resets {new Date(github.rateLimit.resetAt).toLocaleTimeString()}</>}
            </p>
          )}
          {cursor.error && <p className="text-xs text-red-500">Cursor: {cursor.error}</p>}
        </div>
      )}

      <WorkItemTable
        groups={displayGroups}
        linear={linear}
        github={github}
        cursor={cursor}
        dimmed={filter === "closed"}
      />

      {displayItems.length === 0 && !anyLoading && (
        <p className="text-sm text-gray-400 text-center py-12">
          {filter === "closed"
            ? "No closed items"
            : "No active items. Check your API keys in .env.local"}
        </p>
      )}
    </div>
  );
}
