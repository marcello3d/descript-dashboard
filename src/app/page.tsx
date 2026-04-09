"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SiLinear, SiGithub } from "react-icons/si";
import type { CursorAgent, GitHubPR, LinearIssue, WorkItem } from "@/types";
import { getLastUpdated, getLastUpdatedSource } from "@/lib/work-items";
import LinearStatus, { StatusIcon } from "@/components/LinearStatus";

// GitHub PR status icons (Octicons)
function PrStatusIcon({ pr }: { pr?: { draft: boolean; merged: boolean; closed?: boolean } }) {
  if (!pr) return <SiGithub className="w-3.5 h-3.5 text-text-muted" />;
  if (pr.closed) return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 16 16" fill="#cf222e">
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
  if (pr.merged) return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 16 16" fill="#8250df">
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z" />
    </svg>
  );
  if (pr.draft) return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 16 16" fill="#656d76">
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" />
    </svg>
  );
  // Open PR
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 16 16" fill="#1a7f37">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

// GitHub PR review status icons (Octicons)
function ReviewIcon({ decision }: { decision: string | null }) {
  if (decision === "APPROVED") return (
    <span title="Approved">
      <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#1a7f37">
        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
      </svg>
    </span>
  );
  if (decision === "CHANGES_REQUESTED") return (
    <span title="Changes requested">
      <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#cf222e">
        <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z" />
      </svg>
    </span>
  );
  if (decision === "REVIEW_REQUIRED") return (
    <span title="Review required">
      <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9a6700">
        <path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
      </svg>
    </span>
  );
  return null;
}

// Real Cursor logomark from their brand assets
function CursorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="400 395 167 190" fill="currentColor">
      <path d="M563.463 439.971L487.344 396.057C484.899 394.646 481.883 394.646 479.439 396.057L403.323 439.971C401.269 441.156 400 443.349 400 445.723V534.276C400 536.647 401.269 538.843 403.323 540.029L479.443 583.943C481.887 585.353 484.903 585.353 487.347 583.943L563.466 540.029C565.521 538.843 566.79 536.651 566.79 534.276V445.723C566.79 443.352 565.521 441.156 563.466 439.971H563.463ZM558.681 449.273L485.199 576.451C484.703 577.308 483.391 576.958 483.391 575.966V492.691C483.391 491.027 482.501 489.488 481.058 488.652L408.887 447.016C408.03 446.52 408.38 445.209 409.373 445.209H556.337C558.424 445.209 559.728 447.47 558.685 449.276H558.681V449.273Z" />
    </svg>
  );
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

  if (hours < 24) return { text, color: "text-status-green" };
  if (days <= 3) return { text, color: "text-status-blue" };
  if (days <= 7) return { text, color: "text-status-yellow" };
  if (days <= 30) return { text, color: "text-status-orange" };
  return { text, color: "text-text-muted" };
}

const priorityConfig: Record<number, { label: string; color: string }> = {
  1: { label: "P0", color: "text-status-red" },
  2: { label: "P1", color: "text-status-orange" },
  3: { label: "P2", color: "text-text-tertiary" },
  4: { label: "P3", color: "text-text-muted" },
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
      return <span className="text-status-green" title="Checks passing">&#10003;</span>;
    case "FAILURE":
    case "ERROR":
      return <span className="text-status-red" title="Checks failing">&#10005;</span>;
    case "PENDING":
    case "EXPECTED":
      return <span className="text-status-yellow" title="Checks pending">&#9679;</span>;
    default:
      return null;
  }
}

function ReviewBadge({ decision, draft, merged, checksState }: { decision: string | null; draft: boolean; merged: boolean; checksState: string | null }) {
  let label: React.ReactNode;
  if (merged) label = <span className="text-xs text-status-purple">merged</span>;
  else if (draft) label = <span className="text-xs text-text-tertiary">draft</span>;
  else switch (decision) {
    case "APPROVED":
      label = <span className="text-xs text-status-green">approved</span>; break;
    case "CHANGES_REQUESTED":
      label = <span className="text-xs text-status-red">changes</span>; break;
    case "REVIEW_REQUIRED":
      label = <span className="text-xs text-status-yellow">needs review</span>; break;
    default:
      label = <span className="text-xs text-text-tertiary">open</span>;
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
    if (item.pr.merged) label = <span className="text-xs text-status-purple">PR merged</span>;
    else if (item.pr.reviewDecision === "CHANGES_REQUESTED")
      label = <span className="text-xs text-status-red">PR changes requested</span>;
    else if (item.pr.reviewDecision === "APPROVED")
      label = <span className="text-xs text-status-green">PR approved</span>;
    else if (item.pr.draft) label = <span className="text-xs text-text-tertiary">PR draft</span>;
    else if (item.pr.reviewDecision === "REVIEW_REQUIRED")
      label = <span className="text-xs text-status-yellow">PR in review</span>;
    else label = <span className="text-xs text-text-tertiary">PR open</span>;
    return <span className="inline-flex items-center gap-1 leading-none">{linearIcon}{label}</span>;
  }

  // No PR, has Linear → show icon + Linear status text
  if (item.linear) {
    return (
      <span className="inline-flex items-center gap-1 leading-none">
        {linearIcon}
        <span className="text-xs text-text-secondary">{item.linear.status}</span>
      </span>
    );
  }

  // Only Cursor agent (no linear/PR) → show backlog icon + "No PR"
  if (item.agents.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 leading-none">
        <StatusIcon status="Backlog" />
        <span className="text-xs text-text-tertiary">No PR</span>
      </span>
    );
  }

  return linearIcon;
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="text-[11px] font-mono">
      {additions > 0 && <span className="text-status-green">+{additions}</span>}
      {additions > 0 && deletions > 0 && <span className="text-text-muted"> </span>}
      {deletions > 0 && <span className="text-status-red">-{deletions}</span>}
    </span>
  );
}

function AgentInfo({ agent }: { agent: CursorAgent }) {
  const s = agent.status.toLowerCase();
  const color =
    s === "running" || s === "in_progress"
      ? "text-status-green"
      : s === "failed" || s === "error"
      ? "text-status-red"
      : "text-text-tertiary";

  const showStatus = s !== "finished" && s !== "unknown";

  return (
    <span className="text-xs inline-flex items-center gap-1">
      {showStatus && <span className={color}>{s}</span>}
    </span>
  );
}

function ServiceHeader({
  icon,
  label,
  error,
}: {
  icon: React.ReactNode;
  label: string;
  error?: string | null;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
      {icon}
      {label}
      {error && <span className="text-status-red" title={error}>!</span>}
    </span>
  );
}

type ReviewItem = {
  key: string;
  updatedAt: string;
  title: string;
  owner: string; // assignee or PR author
  linear?: LinearIssue;
  pr?: GitHubPR;
};

function buildReviewItems(prs: GitHubPR[], issues: LinearIssue[]): ReviewItem[] {
  const idRe = /[A-Z]+-\d+/gi;
  return prs.map(pr => {
    // Match by prUrl first, then by identifier in title/branch
    let linear = issues.find(i => i.prUrls.includes(pr.url));
    if (!linear) {
      const prText = `${pr.title} ${pr.branch}`.toLowerCase();
      linear = issues.find(i => prText.includes(i.identifier.toLowerCase()));
    }
    return {
      key: `pr-${pr.id}`,
      updatedAt: pr.updatedAt,
      title: pr.title,
      owner: pr.author !== pr.authorLogin ? `@${pr.authorLogin} (${pr.author})` : `@${pr.authorLogin}`,
      pr,
      linear,
    };
  });
}

function reviewSummary(prs: GitHubPR[], issues: LinearIssue[], viewerLogin: string): { personal: number; team: number; draft: number } {
  const built = buildReviewItems(prs, issues);
  let personal = 0, team = 0, draft = 0;
  for (const item of built) {
    if (item.pr?.draft) { draft++; }
    else if (viewerLogin && item.pr?.requestedReviewers?.includes(viewerLogin)) { personal++; }
    else { team++; }
  }
  return { personal, team, draft };
}

function ReviewQueue({ prs, issues, viewerLogin, favorites, onToggleFavorite }: { prs: GitHubPR[]; issues: LinearIssue[]; viewerLogin: string; favorites: Set<string>; onToggleFavorite: (id: string) => void }) {
  const groups = useMemo(() => {
    const built = buildReviewItems(prs, issues);
    const favs: ReviewItem[] = [];
    const directReady: ReviewItem[] = [];
    const directDraft: ReviewItem[] = [];
    const teamReady: ReviewItem[] = [];
    const teamDraft: ReviewItem[] = [];
    for (const item of built) {
      if (favorites.has(item.key)) {
        favs.push(item);
      } else if (viewerLogin && item.pr?.requestedReviewers?.includes(viewerLogin)) {
        (item.pr?.draft ? directDraft : directReady).push(item);
      } else {
        (item.pr?.draft ? teamDraft : teamReady).push(item);
      }
    }
    const groups: { label: string; items: ReviewItem[] }[] = [];
    if (favs.length > 0) groups.push({ label: "Favorites", items: favs });
    if (directReady.length > 0) groups.push({ label: "Individually requested", items: directReady });
    if (teamReady.length > 0) groups.push({ label: "Team requested", items: teamReady });
    if (directDraft.length > 0) groups.push({ label: "Individually requested — draft", items: directDraft });
    if (teamDraft.length > 0) groups.push({ label: "Team requested — draft", items: teamDraft });
    return groups;
  }, [prs, issues, viewerLogin, favorites]);
  const colCount = 7;
  if (groups.length === 0) return null;
  return (
    <div className="mb-4">
      <table className="w-full">
        <thead className="sticky top-[52px] z-10 bg-background/70 backdrop-blur-[2px]">
          <tr className="border-b border-border">
            <th className="w-[24px] px-0"></th>
            <th className="text-right py-2 px-2 w-[70px]">
              <span className="text-xs font-medium text-text-secondary">Updated</span>
            </th>
            <th className="text-left py-2 px-2">
              <span className="text-xs font-medium text-text-secondary">PR</span>
            </th>
            <th className="text-left py-2 px-2 whitespace-nowrap">
              <span className="text-xs font-medium text-text-secondary">Author</span>
            </th>
            <th className="py-2 px-1 w-[24px]"></th>
            <th className="text-left py-2 px-1 w-px whitespace-nowrap">
              <span className="flex items-center gap-1.5 px-2"><ServiceHeader icon={<SiLinear className="w-3.5 h-3.5 text-[#5E6AD2]" />} label="Linear" error={null} /></span>
            </th>
            <th className="text-left py-2 px-2 w-px whitespace-nowrap">
              <span className="text-xs font-medium text-text-secondary">Changes</span>
            </th>
          </tr>
        </thead>
        {groups.map(({ label, items }) => (
        <tbody key={label}>
          {groups.length > 1 && (
            <tr className="sticky top-[84px] z-[5] bg-surface-alt">
              <td colSpan={colCount} className="pt-4 pb-1 px-2">
                <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">{label} <span className="font-normal">({items.length})</span></span>
              </td>
            </tr>
          )}
          {items.map(item => (
            <tr key={item.key} className="border-b border-border-muted hover:bg-surface-hover transition-colors">
              <td className="py-1.5 px-0 text-center w-[24px]">
                <button
                  onClick={() => onToggleFavorite(item.key)}
                  className={`text-sm leading-none ${favorites.has(item.key) ? "text-yellow-400" : "text-text-muted hover:text-yellow-300"} transition-colors`}
                  title={favorites.has(item.key) ? "Unfavorite" : "Favorite"}
                >
                  {favorites.has(item.key) ? "★" : "☆"}
                </button>
              </td>
              <td className="py-1.5 px-2 text-right w-[70px]">
                {(() => {
                  const { text, color } = timeAgo(item.updatedAt);
                  return <span className={`text-xs ${color}`} title={new Date(item.updatedAt).toLocaleString()}>{text}</span>;
                })()}
              </td>
              <td className="py-1.5 px-2">
                <a href={item.pr?.url ?? "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-text-primary hover:underline">
                  <PrStatusIcon pr={item.pr} />
                  <span className="text-xs text-text-tertiary font-mono">#{item.pr?.url.split("/").pop()}</span>
                  {item.title}
                </a>
              </td>
              <td className="py-1.5 px-2 whitespace-nowrap">
                {item.pr?.authorLogin ? (
                  <a href={`https://github.com/${item.pr.authorLogin}`} target="_blank" rel="noopener noreferrer" className="text-xs text-text-tertiary hover:underline">{item.owner}</a>
                ) : (
                  <span className="text-xs text-text-tertiary">{item.owner}</span>
                )}
              </td>
              <td className="py-1.5 px-1 text-center">
                {item.linear && (
                  <PriorityBadge priority={item.linear.priority} />
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.linear ? (
                  <a href={item.linear.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors">
                    <StatusIcon status={item.linear.status} />
                    <span className="text-xs text-text-tertiary font-mono">{item.linear.identifier}</span>
                  </a>
                ) : (
                  <div className="flex px-2">
                    <SiLinear className="w-3.5 h-3.5 text-text-muted" />
                  </div>
                )}
              </td>
              <td className="py-1.5 px-2 whitespace-nowrap">
                {item.pr && (item.pr.additions > 0 || item.pr.deletions > 0) && (
                  <DiffStats additions={item.pr.additions} deletions={item.pr.deletions} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
        ))}
      </table>
    </div>
  );
}

function CreateAgentButton({ item, onCreated }: { item: WorkItem; onCreated: () => void }) {
  const [state, setState] = useState<"idle" | "prompting" | "creating" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function handleCreate() {
    const pr = item.pr!;
    const defaultPrompt = item.linear
      ? `Address the PR feedback and fix any issues on this PR: ${pr.url}\n\nLinear issue: ${item.linear.url}\n\nTitle: ${item.title}`
      : `Continue working on this PR: ${pr.url}\n\nTitle: ${item.title}`;
    const prompt = window.prompt("Cursor agent prompt:", defaultPrompt);
    if (!prompt) return;

    setState("creating");
    setError("");
    try {
      const res = await fetch("/api/cursor-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository: pr.repo,
          ref: pr.branch,
          prompt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create agent");
      setState("done");
      if (data.agent?.url) window.open(data.agent.url, "_blank");
      onCreated();
    } catch (e: any) {
      setState("error");
      setError(e.message);
    }
  }

  if (state === "creating") {
    return (
      <div className="flex items-center gap-1.5 px-2">
        <CursorIcon className="w-3.5 h-3.5 text-text-muted animate-pulse" />
        <span className="text-xs text-text-tertiary">Creating…</span>
      </div>
    );
  }
  if (state === "done") {
    return (
      <div className="flex items-center gap-1.5 px-2">
        <CursorIcon className="w-3.5 h-3.5 text-status-green" />
        <span className="text-xs text-status-green">Created</span>
      </div>
    );
  }
  if (state === "error") {
    return (
      <button
        onClick={handleCreate}
        className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors"
        title={error}
      >
        <CursorIcon className="w-3.5 h-3.5 text-status-red" />
        <span className="text-xs text-status-red">Failed</span>
      </button>
    );
  }

  return (
    <button
      onClick={handleCreate}
      className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors group"
      title="Create Cursor agent for this PR"
    >
      <CursorIcon className="w-3.5 h-3.5 text-text-muted group-hover:text-text-secondary transition-colors" />
      <span className="text-xs text-text-muted group-hover:text-text-tertiary transition-colors">+</span>
    </button>
  );
}

function WorkItemTable({
  groups,
  errors,
  dimmed,
  favorites,
  onToggleFavorite,
  onAgentCreated,
}: {
  groups: { label: string; items: WorkItem[] }[];
  errors: string[];
  dimmed?: boolean;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  onAgentCreated: () => void;
}) {
  const colCount = 8;
  return (
    <table className={`w-full ${dimmed ? "opacity-60" : ""}`}>
      <thead className="sticky top-[52px] z-10 bg-background/70 backdrop-blur-[2px]">
        <tr className="border-b border-border">
          <th className="w-[24px] px-0"></th>
          <th className="text-right py-2 px-2 w-[70px]">
            <span className="text-xs font-medium text-text-secondary">Updated</span>
          </th>
          <th className="text-left py-2 px-2">
            <span className="text-xs font-medium text-text-secondary">Item</span>
          </th>
          <th className="text-center py-2 px-2 w-[24px]"></th>
          <th className="text-left py-2 px-1 w-px whitespace-nowrap">
            <span className="flex items-center gap-1.5 px-2"><ServiceHeader icon={<SiLinear className="w-3.5 h-3.5 text-[#5E6AD2]" />} label="Linear" error={errors.find(e => e.startsWith("linear:"))?.slice(8) ?? null} /></span>
          </th>
          <th className="text-left py-2 px-1 w-px whitespace-nowrap">
            <span className="flex items-center gap-1.5 px-2"><ServiceHeader icon={<SiGithub className="w-3.5 h-3.5 text-text-secondary" />} label="GitHub" error={errors.find(e => e.startsWith("github:"))?.slice(8) ?? null} /></span>
          </th>
          <th className="text-left py-2 px-1 w-px whitespace-nowrap">
            <span className="flex items-center gap-1.5 px-2"><ServiceHeader icon={<CursorIcon className="w-3.5 h-3.5 text-text-secondary" />} label="Cursor" error={errors.find(e => e.startsWith("cursor:"))?.slice(8) ?? null} /></span>
          </th>
          <th className="text-left py-2 px-2 w-px whitespace-nowrap">
            <span className="text-xs font-medium text-text-secondary">Changes</span>
          </th>
        </tr>
      </thead>
      {groups.map(({ label, items }) => (
      <tbody key={label}>
        {groups.length > 1 && (
          <tr className="sticky top-[84px] z-[5] bg-surface-alt">
            <td colSpan={colCount} className="pt-4 pb-1 px-2">
              <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">{label} <span className="font-normal">({items.length})</span></span>
            </td>
          </tr>
        )}
        {items.map((item) => {
          const lastUpdated = getLastUpdated(item);
          return (
            <tr
              key={item.id}
              className="border-b border-border-muted hover:bg-surface-hover transition-colors"
            >
              <td className="py-1.5 px-0 text-center w-[24px]">
                <button
                  onClick={() => onToggleFavorite(item.id)}
                  className={`text-sm leading-none ${favorites.has(item.id) ? "text-yellow-400" : "text-text-muted hover:text-yellow-300"} transition-colors`}
                  title={favorites.has(item.id) ? "Unfavorite" : "Favorite"}
                >
                  {favorites.has(item.id) ? "★" : "☆"}
                </button>
              </td>
              <td className="py-1.5 px-2 text-right">
                {lastUpdated && (() => {
                  const { text, color } = timeAgo(lastUpdated);
                  const tooltipEntries: { date: string; label: string }[] = [];
                  if (item.linear?.updatedAt) tooltipEntries.push({ date: item.linear.updatedAt, label: "Linear" });
                  if (item.pr?.updatedAt) tooltipEntries.push({ date: item.pr.updatedAt, label: "GitHub" });
                  for (const a of item.agents) {
                    if (a.createdAt) tooltipEntries.push({ date: a.createdAt, label: "Cursor" });
                  }
                  tooltipEntries.sort((a, b) => b.date.localeCompare(a.date));
                  const tooltip = tooltipEntries
                    .map(e => `${e.label}: ${timeAgo(e.date).text} — ${new Date(e.date).toLocaleString()}`)
                    .join("\n");
                  return (
                    <span className={`text-xs ${color} cursor-default hover:underline hover:decoration-dotted`} title={tooltip}>
                      {text}
                    </span>
                  );
                })()}
              </td>
              <td className="py-1.5 px-2">
                {(() => {
                  const isVerify = item.linear?.status.toLowerCase() === "verify";
                  const cursorOnly = !item.linear && !item.pr && item.agents.length > 0;
                  const isClosed = (item.pr?.merged && !isVerify) ||
                    (item.pr?.closed && !item.linear) ||
                    item.linear?.status.toLowerCase() === "canceled" ||
                    item.linear?.status.toLowerCase() === "cancelled" ||
                    item.linear?.status.toLowerCase() === "done" ||
                    item.linear?.status.toLowerCase() === "completed" ||
                    cursorOnly;
                  return (
                    <a
                      href={item.linear?.url ?? item.pr?.url ?? item.agents[0]?.url ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`text-sm text-text-primary hover:underline transition-colors line-clamp-1 ${isClosed ? "line-through opacity-50" : ""}`}
                    >
                      {item.title}
                    </a>
                  );
                })()}
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
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors"
                    title={item.linear.status}
                  >
                    <StatusIcon status={item.linear.status} />
                    <span className="text-xs text-text-tertiary font-mono">
                      {item.linear.identifier}
                    </span>
                  </a>
                ) : item.pr ? (
                  <a
                    href={`https://linear.app/descript/new?title=${encodeURIComponent(item.pr.title)}&description=${encodeURIComponent(item.pr.url)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors text-text-muted hover:text-text-secondary"
                    title="Create Linear issue from PR"
                  >
                    <SiLinear className="w-3.5 h-3.5" />
                    <span className="text-xs">+</span>
                  </a>
                ) : (
                  <div className="flex px-2">
                    <SiLinear className="w-3.5 h-3.5 text-text-muted" />
                  </div>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.pr ? (
                  <a
                    href={item.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors"
                    title={item.pr.merged ? "Merged" : item.pr.closed ? "Closed" : item.pr.draft ? "Draft" : item.pr.reviewDecision === "APPROVED" ? "Approved" : item.pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : item.pr.reviewDecision === "REVIEW_REQUIRED" ? "Review required" : "Open"}
                  >
                    <PrStatusIcon pr={item.pr} />
                    <span className="text-xs text-text-tertiary font-mono">#{item.pr.url.split("/").pop()}</span>
                    <ReviewIcon decision={item.pr.reviewDecision} />
                  </a>
                ) : item.linear?.prUrls?.[0] ? (
                  <a
                    href={item.linear.prUrls[0]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors"
                  >
                    <PrStatusIcon />
                    <span className="text-xs text-text-tertiary font-mono">#{item.linear.prUrls[0].split("/").pop()}</span>
                  </a>
                ) : (
                  <div className="flex px-2">
                    <PrStatusIcon />
                  </div>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.agents.length > 0 ? (
                  <a
                    href={item.agents[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors"
                  >
                    <CursorIcon className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />
                    <span className="text-xs text-text-tertiary">Agent</span>
                    <AgentInfo agent={item.agents[0]} />
                  </a>
                ) : item.pr ? (
                  <CreateAgentButton item={item} onCreated={onAgentCreated} />
                ) : (
                  <div className="flex px-2">
                    <CursorIcon className="w-3.5 h-3.5 text-text-muted" />
                  </div>
                )}
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
                    <span className="text-text-tertiary text-right w-[40px] flex-shrink-0">{files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : ""}</span>
                    <span className="w-2 flex-shrink-0" />
                    {(add > 0 || del > 0) ? <DiffStats additions={add} deletions={del} /> : null}
                  </span>
                ) : null;
                return (
                  <td className="py-1.5 px-1 whitespace-nowrap">
                    {inner && changesUrl ? (
                      <a href={changesUrl} target="_blank" rel="noopener noreferrer" className="py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors inline-flex">{inner}</a>
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

type ViewMode = "stage" | "date" | "priority" | "review";

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`text-xs px-2.5 py-1 transition-colors ${
            value === opt.value ? "toggle-active" : "toggle-inactive"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

type ActionGroup = "ready" | "verify" | "review" | "changes" | "draft" | "other";

function getActionGroup(item: WorkItem): ActionGroup {
  if (item.linear?.status.toLowerCase() === "verify") return "verify";
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
  ready: "Approved",
  verify: "Verify",
  review: "Waiting",
  changes: "Changes requested",
  draft: "Draft",
  other: "Other",
};

const ACTION_GROUP_ORDER: ActionGroup[] = ["verify", "ready", "changes", "review", "draft", "other"];

function groupByAction(items: WorkItem[], favorites: Set<string>): { group: ActionGroup; label: string; items: WorkItem[] }[] {
  const favItems: WorkItem[] = [];
  const map = new Map<ActionGroup, WorkItem[]>();
  for (const item of items) {
    if (favorites.has(item.id)) {
      favItems.push(item);
      continue;
    }
    const g = getActionGroup(item);
    const list = map.get(g) || [];
    list.push(item);
    map.set(g, list);
  }
  const groups = ACTION_GROUP_ORDER
    .filter(g => map.has(g))
    .map(g => ({ group: g, label: ACTION_GROUP_LABELS[g], items: map.get(g)! }));
  if (favItems.length > 0) {
    groups.unshift({ group: "other" as ActionGroup, label: "Favorites", items: favItems });
  }
  return groups;
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
  0: "No priority",
};

function groupByPriority(items: WorkItem[], favorites: Set<string>): { group: ActionGroup; label: string; items: WorkItem[] }[] {
  const favItems: WorkItem[] = [];
  const map = new Map<number, WorkItem[]>();
  for (const item of items) {
    if (favorites.has(item.id)) { favItems.push(item); continue; }
    const p = item.linear?.priority ?? 0;
    const list = map.get(p) || [];
    list.push(item);
    map.set(p, list);
  }
  const groups = [1, 2, 3, 4, 0]
    .filter(p => map.has(p))
    .map(p => ({ group: "other" as ActionGroup, label: PRIORITY_LABELS[p], items: map.get(p)! }));
  if (favItems.length > 0) {
    groups.unshift({ group: "other" as ActionGroup, label: "Favorites", items: favItems });
  }
  return groups;
}

function sortByDate(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => getLastUpdated(b).localeCompare(getLastUpdated(a)));
}

interface ApiCallRecord {
  service: string;
  endpoint: string;
  status: string;
  duration_ms: number;
  cost: number | null;
  error: string | null;
  created_at: number;
  cache_hits: number;
}

interface ApiStatRow {
  service: string;
  total: number;
  ok: number;
  cached: number;
  errors: number;
  last_call: number;
}

type RateLimitInfo = { name: string; cost?: number; remaining: number; limit: number; resetAt: string };

function resetIn(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function RateLimitBar({ rl }: { rl: RateLimitInfo }) {
  const pct = Math.round((rl.remaining / rl.limit) * 100);
  return (
    <div>
      <div className="flex justify-between text-[11px] opacity-60 mb-0.5">
        <span>{rl.name} <span className="opacity-50">resets in {resetIn(rl.resetAt)}</span></span>
        <span className="tabular-nums">{rl.remaining}/{rl.limit} ({pct}%)</span>
      </div>
      <div className="h-1.5 bg-fill-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct > 20 ? "bg-status-green" : pct > 5 ? "bg-status-yellow" : "bg-status-red"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ApiStatsPopover({ rateLimits, stats, recent }: { rateLimits: RateLimitInfo[]; stats: ApiStatRow[]; recent: ApiCallRecord[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Show the minimum remaining % across all rate limits
  const minPct = Math.min(...rateLimits.map(rl => Math.round(100 * rl.remaining / rl.limit)));
  const color = minPct < 5 ? "text-status-red" : minPct < 20 ? "text-status-yellow" : "text-text-muted";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-[11px] tabular-nums hover:text-text-secondary transition-colors ${color}`}
        title={rateLimits.map(rl => `${rl.name}: ${rl.remaining}/${rl.limit}`).join("\n")}
      >
        API {minPct}%
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 bg-surface text-text-primary border border-border rounded-lg shadow-lg p-3 w-[360px] text-xs">
          <div className="font-medium mb-2">API Usage</div>

          {/* Rate limit bars */}
          <div className="mb-3 space-y-2">
            {rateLimits.map(rl => <RateLimitBar key={rl.name} rl={rl} />)}
          </div>

          {/* Stats summary */}
          {stats.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] font-medium opacity-50 mb-1">Calls (last hour)</div>
              <div className="grid grid-cols-5 gap-x-2 text-[11px]">
                <span className="opacity-40">Service</span>
                <span className="opacity-40 text-right">Total</span>
                <span className="opacity-40 text-right">API</span>
                <span className="opacity-40 text-right">Cached</span>
                <span className="opacity-40 text-right">Errors</span>
                {stats.map(s => (
                  <React.Fragment key={s.service}>
                    <span className="capitalize">{s.service}</span>
                    <span className="opacity-70 text-right tabular-nums">{s.total}</span>
                    <span className="opacity-70 text-right tabular-nums">{s.ok}</span>
                    <span className="opacity-70 text-right tabular-nums">{s.cached}</span>
                    <span className={`text-right tabular-nums ${s.errors > 0 ? "text-status-red" : "opacity-70"}`}>{s.errors}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}

          {/* Recent calls (actual API hits only) */}
          {recent.length > 0 && (
            <div>
              <div className="text-[11px] font-medium opacity-50 mb-1">Recent API calls</div>
              <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                {recent.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.status === "error" ? "bg-status-red" : "bg-status-green"}`} />
                    <span className="opacity-50 tabular-nums whitespace-nowrap flex-shrink-0">{new Date(r.created_at).toLocaleTimeString()}</span>
                    <span className="capitalize w-[44px] flex-shrink-0">{r.service}</span>
                    <span className="opacity-50 flex-1 truncate">{r.endpoint}</span>
                    {r.cost != null && <span className="text-status-orange tabular-nums whitespace-nowrap" title="Rate limit points consumed">cost {r.cost}</span>}
                    {r.duration_ms > 0 && <span className="opacity-40 tabular-nums whitespace-nowrap">{r.duration_ms}ms</span>}
                    {r.cache_hits > 0 && <span className="opacity-30 tabular-nums whitespace-nowrap" title={`${r.cache_hits} cache hits since`}>+{r.cache_hits} cached</span>}
                    {r.error && <span className="text-status-red truncate max-w-[100px]" title={r.error}>err</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Home />
    </Suspense>
  );
}

function useWorkItems(intervalMs = 300000) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [reviewPrs, setReviewPrs] = useState<GitHubPR[]>([]);
  const [reviewIssues, setReviewIssues] = useState<LinearIssue[]>([]);
  const [viewerLogin, setViewerLogin] = useState("");
  const [rateLimits, setRateLimits] = useState<RateLimitInfo[]>([]);
  const [stats, setStats] = useState<ApiStatRow[]>([]);
  const [recent, setRecent] = useState<ApiCallRecord[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ step: number; totalSteps: number } | null>(null);
  const fetchingRef = useRef(false);
  const lastFetchRef = useRef(0);

  const applyChunk = useCallback((json: any) => {
    setItems(json.items ?? []);
    setReviewPrs(json.reviewPrs ?? []);
    setReviewIssues(json.reviewIssues ?? []);
    if (json.viewerLogin) setViewerLogin(json.viewerLogin);
    const rls: RateLimitInfo[] = [];
    if (json.rateLimits?.github) rls.push({ name: "GitHub Core", ...json.rateLimits.github });
    if (json.rateLimits?.githubSearch) rls.push({ name: "GitHub Search", ...json.rateLimits.githubSearch });
    if (json.rateLimits?.linear) rls.push({ name: "Linear", ...json.rateLimits.linear });
    setRateLimits(rls);
    setStats(json.stats ?? []);
    setRecent(json.recent ?? []);
    setErrors(json.errors ?? []);
    if (json.progress) setProgress(json.progress);
    if (json.done) setProgress(null);
  }, []);

  const doFetch = useCallback(async (bypassCache: boolean) => {
    if (fetchingRef.current) return;
    const now = Date.now();
    if (!bypassCache && now - lastFetchRef.current < intervalMs) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const url = bypassCache ? "/api/work-items?fresh=1" : "/api/work-items";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.body) {
        const json = await res.json();
        applyChunk(json);
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              applyChunk(JSON.parse(line));
            } catch {}
          }
        }
        // Process any remaining buffered data
        if (buffer.trim()) {
          try {
            applyChunk(JSON.parse(buffer));
          } catch {}
        }
      }
      lastFetchRef.current = Date.now();
    } catch (e: any) {
      setErrors([e.message]);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [intervalMs, applyChunk]);

  const refresh = useCallback(() => doFetch(true), [doFetch]);

  useEffect(() => {
    doFetch(false);
    const id = setInterval(() => doFetch(false), intervalMs);
    return () => clearInterval(id);
  }, [doFetch, intervalMs]);

  return { items, reviewPrs, reviewIssues, viewerLogin, rateLimits, stats, recent, errors, loading, progress, refresh };
}

function RepoFilter({ repos, value, onChange }: { repos: string[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = value === "all" ? "All repos" : value;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-text-tertiary hover:text-text-secondary transition-colors px-1.5 py-0.5 rounded hover:bg-surface-hover"
      >
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-md shadow-lg py-1 z-30 min-w-[140px]">
          {[{ value: "all", label: "All repos" }, ...repos.map(r => ({ value: r, label: r }))].map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`block w-full text-left text-xs px-3 py-1.5 transition-colors ${
                value === opt.value ? "text-text-primary bg-surface-hover" : "text-text-secondary hover:bg-surface-hover"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Home() {
  const { items: allUnfilteredItems, reviewPrs, reviewIssues, viewerLogin, rateLimits: rateLimitInfos, stats, recent, errors: serviceErrors, loading: anyLoading, progress, refresh: refreshAll } = useWorkItems();

  const searchParams = useSearchParams();


  type Tab = "tasks" | "review";
  type SortMode = "stage" | "priority" | "date";
  const [tab, setTabState] = useState<Tab>("tasks");
  const [sort, setSortState] = useState<SortMode>("stage");
  const [repoFilter, setRepoFilterState] = useState("descript");

  // Sync from URL on mount
  useEffect(() => {
    const t = searchParams.get("tab") as Tab;
    const s = searchParams.get("sort") as SortMode;
    const r = searchParams.get("repo");
    // Migrate legacy "view" param
    const legacyView = searchParams.get("view") as string;
    if (legacyView) {
      if (legacyView === "review") { setTabState("review"); }
      else if (legacyView === "stage" || legacyView === "priority" || legacyView === "date") { setSortState(legacyView); }
    }
    if (t) setTabState(t);
    if (s && (s === "stage" || s === "priority" || s === "date")) setSortState(s);
    if (r && r !== repoFilter) setRepoFilterState(r);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setParam = useCallback((key: string, value: string, defaultValue: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("view"); // clean up legacy param
    if (value === defaultValue) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : "/");
  }, [searchParams]);

  const setTab = useCallback((t: Tab) => { setTabState(t); setParam("tab", t, "tasks"); }, [setParam]);
  const setSort = useCallback((s: SortMode) => { setSortState(s); setParam("sort", s, "stage"); }, [setParam]);
  const view = tab === "review" ? "review" as ViewMode : sort as ViewMode;
  const isOpen = sort === "stage" || sort === "priority";
  const isReview = tab === "review";
  const setRepoFilter = useCallback((v: string) => { setRepoFilterState(v); setParam("repo", v, "descript"); }, [setParam]);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>();
    try {
      const saved = localStorage.getItem("dashboard:favorites");
      return saved ? new Set(JSON.parse(saved)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const toggleFavorite = useCallback((id: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem("dashboard:favorites", JSON.stringify([...next]));
      return next;
    });
  }, []);

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
      const isVerify = item.linear?.status.toLowerCase() === "verify";
      const isClosed =
        (item.pr?.merged && !isVerify) ||
        item.pr?.closed ||
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
    const items = view === "date" ? allItems : open;
    const sorted = sortByDate(items);
    if (view === "stage") return groupByAction(sorted, favorites);
    if (view === "priority") return groupByPriority(sorted, favorites);
    return [{ group: "other" as ActionGroup, label: "", items: sorted }];
  }, [view, open, allItems, favorites]);

  const displayItems = displayGroups.flatMap(g => g.items);

  const pageTitle = useMemo(() => {
    const section = isReview ? "Requested reviews" : "My tasks";
    let summary = "";
    if (isReview) {
      const s = reviewSummary(reviewPrs, reviewIssues, viewerLogin);
      const parts: string[] = [];
      if (s.personal > 0) parts.push(`${s.personal} personal`);
      if (s.team > 0) parts.push(`${s.team} team`);
      if (s.draft > 0) parts.push(`${s.draft} draft`);
      summary = parts.join(" · ");
    } else if (open.length > 0) {
      const stageGroups = groupByAction(sortByDate(open), new Set());
      summary = stageGroups.map(g => `${g.items.length} ${g.label.toLowerCase()}`).join(" · ");
    }
    return summary ? `${section} · ${summary}` : section;
  }, [isReview, reviewPrs, reviewIssues, viewerLogin, open]);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);


  return (
    <div className="w-full px-4 py-4">
      <header className="flex items-center gap-3 mb-3 sticky top-0 z-20 bg-background/70 backdrop-blur-[2px] py-3 -mt-3">
        <h1 className="text-lg font-bold text-text-primary">Dashboard</h1>
        <ToggleGroup
          options={[
            { value: "tasks" as const, label: `My tasks${open.length > 0 ? ` (${open.length})` : ""}` },
            { value: "review" as const, label: `Requested reviews${reviewPrs.length > 0 ? ` (${reviewPrs.length})` : ""}` },
          ]}
          value={isReview ? "review" as const : "tasks" as const}
          onChange={(v) => setTab(v as Tab)}
        />
        <span className="text-sm text-text-tertiary">
          {isReview ? (() => {
            const s = reviewSummary(reviewPrs, reviewIssues, viewerLogin);
            const parts: string[] = [];
            if (s.personal > 0) parts.push(`${s.personal} personal`);
            if (s.team > 0) parts.push(`${s.team} team`);
            if (s.draft > 0) parts.push(`${s.draft} draft`);
            return parts.join(" · ");
          })() : (() => {
            if (open.length === 0) return "";
            const stageGroups = groupByAction(sortByDate(open), new Set());
            return stageGroups.map(g => `${g.items.length} ${g.label.toLowerCase()}`).join(" · ");
          })()}
        </span>
        {progress && (
          <span className="text-[11px] text-text-tertiary tabular-nums">
            {progress.step}/{progress.totalSteps}
          </span>
        )}
        <button
          onClick={refreshAll}
          disabled={anyLoading}
          className="text-text-tertiary hover:text-text-secondary disabled:opacity-50 p-1"
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
        {rateLimitInfos.length > 0 && (
          <ApiStatsPopover rateLimits={rateLimitInfos} stats={stats} recent={recent} />
        )}
        <div className="flex-1" />
        {!isReview && (
          <ToggleGroup
            options={[
              { value: "stage" as ViewMode, label: "Status" },
              { value: "priority" as ViewMode, label: "Priority" },
              { value: "date" as ViewMode, label: "All" },
            ]}
            value={sort}
            onChange={(v) => setSort(v as SortMode)}
          />
        )}
        {repos.length > 1 && <RepoFilter repos={repos} value={repoFilter} onChange={setRepoFilter} />}
      </header>

      {serviceErrors.length > 0 && (
        <div className="mb-3 space-y-1">
          {serviceErrors.map((err, i) => (
            <p key={i} className="text-xs text-status-red">{err}</p>
          ))}
        </div>
      )}

      {isReview ? (
        <>
          <ReviewQueue prs={reviewPrs} issues={reviewIssues} viewerLogin={viewerLogin} favorites={favorites} onToggleFavorite={toggleFavorite} />
          {reviewPrs.length === 0 && reviewIssues.length === 0 && !anyLoading && (
            <p className="text-sm text-text-tertiary text-center py-12">No PRs awaiting your review</p>
          )}
        </>
      ) : (
        <>
          <WorkItemTable
            groups={displayGroups}
            errors={serviceErrors}
            dimmed={false}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            onAgentCreated={refreshAll}
          />
          {displayItems.length === 0 && !anyLoading && (
            <p className="text-sm text-text-tertiary text-center py-12">
              No active items. Check your API keys in .env.local
            </p>
          )}
        </>
      )}
    </div>
  );
}
