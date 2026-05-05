"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SiLinear, SiGithub } from "react-icons/si";
import { FaBug } from "react-icons/fa";
import type { CursorAgent, GitHubPR, LinearIssue, WorkItem, ReviewItem } from "@/types";
import { getLastUpdated, getLastUpdatedSource } from "@/lib/work-items";
import { registerServiceWorker, notifyNewReviews, notifyPrReviewChanges, getPermissionState, requestPermission } from "@/lib/notifications";
import LinearStatus, { StatusIcon } from "@/components/LinearStatus";
import LinearStatusDropdown from "@/components/LinearStatusDropdown";
import { useToast } from "@/components/Toast";
import {
  BellIcon,
  CheckIcon,
  ClosedPrIcon,
  CopyIcon,
  CursorIcon,
  DraftPrIcon,
  FilterIcon,
  GearIcon,
  MergedPrIcon,
  OpenPrIcon,
  RefreshIcon,
  ReviewApprovedIcon,
  ReviewChangesRequestedIcon,
  ReviewRequiredIcon,
  StackIcon,
  WarningIcon,
} from "@/components/icons";

// GitHub PR status icons (Octicons)
function PrStatusIcon({ pr }: { pr?: { draft: boolean; merged: boolean; closed?: boolean } }) {
  if (!pr) return <SiGithub className="w-3.5 h-3.5 text-text-muted" />;
  if (pr.closed) return <ClosedPrIcon />;
  if (pr.merged) return <MergedPrIcon />;
  if (pr.draft) return <DraftPrIcon />;
  return <OpenPrIcon />;
}

// GitHub PR review status icons (Octicons)
function ReviewIcon({ decision }: { decision: string | null }) {
  if (decision === "APPROVED") return <span title="Approved"><ReviewApprovedIcon /></span>;
  if (decision === "CHANGES_REQUESTED") return <span title="Changes requested"><ReviewChangesRequestedIcon /></span>;
  if (decision === "REVIEW_REQUIRED") return <span title="Review required"><ReviewRequiredIcon /></span>;
  return null;
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

function getPrStatusInfo(pr: { merged: boolean; draft: boolean; reviewDecision: string | null }): { text: string; long: string; color: string } {
  if (pr.merged) return { text: "merged", long: "Merged", color: "text-status-purple" };
  if (pr.draft) return { text: "draft", long: "Draft", color: "text-text-tertiary" };
  switch (pr.reviewDecision) {
    case "APPROVED": return { text: "approved", long: "Approved", color: "text-status-green" };
    case "CHANGES_REQUESTED": return { text: "changes", long: "Changes requested", color: "text-status-red" };
    case "REVIEW_REQUIRED": return { text: "needs review", long: "Review required", color: "text-status-yellow" };
    default: return { text: "open", long: "Open", color: "text-text-tertiary" };
  }
}

function ReviewBadge({ decision, draft, merged, checksState }: { decision: string | null; draft: boolean; merged: boolean; checksState: string | null }) {
  const { text, color } = getPrStatusInfo({ merged, draft, reviewDecision: decision });
  const label = <span className={`text-xs ${color}`}>{text}</span>;
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
  const pr = item.prs[0];
  if (pr) {
    const { text, color } = getPrStatusInfo(pr);
    const label = <span className={`text-xs ${color}`}>PR {text}</span>;
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

function getPrNumber(url: string): string {
  return url.split("/").pop() ?? "";
}

const theadClass = "sticky top-[calc(var(--titlebar-height,0px)+52px)] z-10 bg-background/70 backdrop-blur-[2px]";
const sectionHeaderClass = "sticky top-[calc(var(--titlebar-height,0px)+84px)] z-[5] bg-surface-alt";
const tableRowClass = "border-b border-border-muted hover:bg-surface-hover transition-colors group";
const cellLink = "py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors";
const cellLinkFlex = `flex items-center gap-1.5 ${cellLink}`;
const iconButtonClass = "text-text-tertiary hover:text-text-secondary transition-all p-1";

function ChangesSummary({ files, additions, deletions, url }: { files: number; additions: number; deletions: number; url?: string | null }) {
  if (files === 0 && additions === 0 && deletions === 0) return null;
  const inner = (
    <span className="inline-flex items-center text-xs">
      <span className="text-text-tertiary text-right w-[40px] flex-shrink-0">{files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : ""}</span>
      <span className="w-2 flex-shrink-0" />
      {(additions > 0 || deletions > 0) && <DiffStats additions={additions} deletions={deletions} />}
    </span>
  );
  if (url) {
    return <a href={url} target="_blank" rel="noopener noreferrer" className={`${cellLink} inline-flex`}>{inner}</a>;
  }
  return inner;
}

function LinearIssueLink({ issue }: { issue: LinearIssue }) {
  return (
    <a href={issue.url} target="_blank" rel="noopener noreferrer" className={cellLinkFlex} title={issue.status}>
      <StatusIcon status={issue.status} />
      <span className="text-xs text-text-tertiary font-mono">{issue.identifier}</span>
    </a>
  );
}

function PrCellLink({ pr }: { pr: GitHubPR }) {
  const isStacked = pr.baseBranch && pr.baseBranch !== "main" && pr.baseBranch !== "master";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cellLinkFlex}
          title={`${getPrStatusInfo(pr).long}: ${pr.title}${isStacked ? ` · into ${pr.baseBranch}` : ""}`}
        >
          <PrStatusIcon pr={pr} />
          <span className="text-xs text-text-tertiary font-mono">#{getPrNumber(pr.url)}</span>
          <ReviewIcon decision={pr.reviewDecision} />
          {isStacked && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
              }}
              className="text-text-muted hover:text-text-secondary transition-colors flex-shrink-0"
              title={`Stacked on ${pr.baseBranch} — click to view stack`}
            >
              <StackIcon />
            </button>
          )}
        </a>
        {pr.bugBotThreadCount > 0 && (
          <a
            href={pr.bugBotThreadUrls?.[0] ?? pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-status-red/15 text-status-red text-[10px] font-medium leading-none hover:bg-status-red/25"
            title={`${pr.bugBotThreadCount} bug bot ${pr.bugBotThreadCount === 1 ? "issue" : "issues"} — click to open`}
          >
            <FaBug className="w-2.5 h-2.5" />
            <span className="text-[11px]">{pr.bugBotThreadCount}</span>
          </a>
        )}
        <CopyBranchButton branch={pr.branch} />
      </span>
      {pr.mergeReadiness?.ready && (
        <span className="text-xs text-status-green font-medium ml-4">
          Ready to merge
        </span>
      )}
    </div>
  );
}

function CopyBranchButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`${iconButtonClass} opacity-0 group-hover:opacity-100`}
      title={`Copy branch: ${branch}`}
      aria-label={`Copy branch name: ${branch}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(branch);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function SectionHeader({ label, count, colSpan, collapsed, onToggle, isDraft }: { label: string; count: number; colSpan: number; collapsed?: boolean; onToggle?: () => void; isDraft?: boolean }) {
  return (
    <tr className={sectionHeaderClass}>
      <td colSpan={colSpan} className="pt-4 pb-1 px-2">
        <button onClick={onToggle} className="text-xs font-semibold text-text-tertiary uppercase tracking-wide hover:text-text-secondary transition-colors cursor-pointer inline-flex items-center gap-1.5">
          <span className="inline-block w-4 text-xs">{collapsed ? "▸" : "▾"}</span>
          {isDraft && <DraftPrIcon className="w-3.5 h-3.5 flex-shrink-0" />}
          <span>{isDraft ? `DRAFT: ${label}` : label}</span>
          <span className="font-normal">({count})</span>
        </button>
      </td>
    </tr>
  );
}

function EmptyServiceCell({ children }: { children: React.ReactNode }) {
  return <div className="flex px-2">{children}</div>;
}

function FavoriteButton({ id, isFavorite, onToggle }: { id: string; isFavorite: boolean; onToggle: (id: string) => void }) {
  return (
    <button
      onClick={() => onToggle(id)}
      className={`text-sm leading-none ${isFavorite ? "text-yellow-400" : "text-text-muted hover:text-yellow-300"} transition-colors`}
      title={isFavorite ? "Unfavorite" : "Favorite"}
    >
      {isFavorite ? "★" : "☆"}
    </button>
  );
}

function ArchiveButton({ id, isArchived, onToggle }: { id: string; isArchived: boolean; onToggle: (id: string) => void }) {
  return (
    <button
      onClick={() => onToggle(id)}
      className={`${iconButtonClass} ${isArchived ? "text-text-tertiary" : "opacity-0 group-hover:opacity-100"}`}
      title={isArchived ? "Unarchive" : "Archive"}
      aria-label={isArchived ? "Unarchive item" : "Archive item"}
    >
      {isArchived ? (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15l3-3m0 0l3 3m-3-3v12M3 7.5V6a2 2 0 012-2h14a2 2 0 012 2v1.5M3 7.5h18M3 7.5l1.5 12A2 2 0 006.48 21.5h11.04a2 2 0 001.98-1.5L21 7.5" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-1.5 12.5a2 2 0 01-2 1.5H7.5a2 2 0 01-2-1.5L4 7m16 0H4m16 0l-1-3H5L4 7m5 4v6m6-6v6" />
        </svg>
      )}
    </button>
  );
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

  const showStatus = s !== "finished";

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

function reviewItemOwner(item: ReviewItem): string {
  const pr = item.pr;
  return pr.author !== pr.authorLogin ? `@${pr.authorLogin} (${pr.author})` : `@${pr.authorLogin}`;
}

function formatReviewSummary(items: ReviewItem[], long?: boolean): string {
  let personal = 0, team = 0, draft = 0;
  for (const item of items) {
    if (item.pr.draft) { draft++; }
    else if (item.requestType === "individual") { personal++; }
    else { team++; }
  }
  const parts: string[] = [];
  if (personal > 0) parts.push(`${personal} ${long ? "personally requested" : "personal"}`);
  if (team > 0) parts.push(`${team} ${long ? "team requested" : "team"}`);
  if (draft > 0) parts.push(`${draft} draft`);
  return parts.join(" · ");
}

function ReviewQueue({ items: reviewItems, favorites, onToggleFavorite, archived, onToggleArchive, collapsed, onToggleCollapsed, highlightedId }: { items: ReviewItem[]; favorites: Set<string>; onToggleFavorite: (id: string) => void; archived: Set<string>; onToggleArchive: (id: string) => void; collapsed: Set<string>; onToggleCollapsed: (label: string) => void; highlightedId: string | null }) {
  const groups = useMemo(() => {
    const favs: ReviewItem[] = [];
    const directReady: ReviewItem[] = [];
    const directDraft: ReviewItem[] = [];
    // Map from team-set key (sorted slugs joined by "|") → { label, ready, draft }
    const teamSetGroups = new Map<string, { label: string; ready: ReviewItem[]; draft: ReviewItem[] }>();
    // Fallback when a team-requested PR has no team data
    const teamReadyFallback: ReviewItem[] = [];
    const teamDraftFallback: ReviewItem[] = [];
    const archivedItems: ReviewItem[] = [];

    for (const item of reviewItems) {
      if (archived.has(item.id)) {
        archivedItems.push(item);
        continue;
      }
      if (favorites.has(item.id)) {
        favs.push(item);
        continue;
      }
      if (item.requestType === "individual") {
        (item.pr.draft ? directDraft : directReady).push(item);
        continue;
      }
      const teams = [...item.pr.requestedTeams].sort((a, b) => a.slug.localeCompare(b.slug));
      if (teams.length === 0) {
        (item.pr.draft ? teamDraftFallback : teamReadyFallback).push(item);
        continue;
      }
      const key = teams.map(t => t.slug).join("|");
      let group = teamSetGroups.get(key);
      if (!group) {
        const label = teams.map(t => t.name).join(" + ");
        group = { label, ready: [], draft: [] };
        teamSetGroups.set(key, group);
      }
      (item.pr.draft ? group.draft : group.ready).push(item);
    }

    const groups: { label: string; items: ReviewItem[]; isDraft?: boolean }[] = [];
    if (favs.length > 0) groups.push({ label: "Favorites", items: favs });
    if (directReady.length > 0) groups.push({ label: "Individually requested", items: directReady });
    const sortedTeamGroups = [...teamSetGroups.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const g of sortedTeamGroups) {
      if (g.ready.length > 0) groups.push({ label: `Team: ${g.label}`, items: g.ready });
    }
    if (teamReadyFallback.length > 0) groups.push({ label: "Team requested", items: teamReadyFallback });
    if (directDraft.length > 0) groups.push({ label: "Individually requested", items: directDraft, isDraft: true });
    for (const g of sortedTeamGroups) {
      if (g.draft.length > 0) groups.push({ label: `Team: ${g.label}`, items: g.draft, isDraft: true });
    }
    if (teamDraftFallback.length > 0) groups.push({ label: "Team requested", items: teamDraftFallback, isDraft: true });
    if (archivedItems.length > 0) groups.push({ label: "Archived", items: archivedItems });
    return groups;
  }, [reviewItems, favorites, archived]);
  const colCount = 7;
  if (groups.length === 0) return null;
  return (
    <div className="mb-4">
      <table className="w-full">
        <thead className={theadClass}>
          <tr className="border-b border-border">
            <th className="w-[44px] px-0"></th>
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
        {groups.map(({ label, items, isDraft }) => {
        const collapseKey = isDraft ? `${label}|draft` : label;
        return (
        <tbody key={collapseKey}>
          {groups.length > 1 && <SectionHeader label={label} count={items.length} colSpan={colCount} collapsed={collapsed.has(collapseKey)} onToggle={() => onToggleCollapsed(collapseKey)} isDraft={isDraft} />}
          {!collapsed.has(collapseKey) && items.map(item => (
            <tr key={item.id} className={tableRowClass} data-item-id={item.id} data-highlight={highlightedId === item.id ? "true" : undefined}>
              <td className="py-1.5 px-0 w-[44px]">
                <div className="flex items-center justify-center gap-0.5">
                  <FavoriteButton id={item.id} isFavorite={favorites.has(item.id)} onToggle={onToggleFavorite} />
                  <ArchiveButton id={item.id} isArchived={archived.has(item.id)} onToggle={onToggleArchive} />
                </div>
              </td>
              <td className="py-1.5 px-2 text-right w-[70px]">
                {(() => {
                  const { text, color } = timeAgo(item.pr.updatedAt);
                  return <span className={`text-xs ${color}`} title={new Date(item.pr.updatedAt).toLocaleString()}>{text}</span>;
                })()}
              </td>
              <td className="py-1.5 px-2">
                <span className="inline-flex items-center gap-1.5">
                  <a href={item.pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-text-primary hover:underline">
                    <PrStatusIcon pr={item.pr} />
                    <span className="text-xs text-text-tertiary font-mono">#{getPrNumber(item.pr.url)}</span>
                    {item.pr.title}
                  </a>
                  <CopyBranchButton branch={item.pr.branch} />
                </span>
              </td>
              <td className="py-1.5 px-2 whitespace-nowrap">
                <a href={`https://github.com/${item.pr.authorLogin}`} target="_blank" rel="noopener noreferrer" className="text-xs text-text-tertiary hover:underline">{reviewItemOwner(item)}</a>
              </td>
              <td className="py-1.5 px-1 text-center">
                {item.linear && (
                  <PriorityBadge priority={item.linear.priority} />
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.linear ? (
                  <LinearIssueLink issue={item.linear} />
                ) : (
                  <EmptyServiceCell><SiLinear className="w-3.5 h-3.5 text-text-muted" /></EmptyServiceCell>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                <ChangesSummary files={item.pr.changedFiles} additions={item.pr.additions} deletions={item.pr.deletions} url={`${item.pr.url}/files`} />
              </td>
            </tr>
          ))}
        </tbody>
        );
        })}
      </table>
    </div>
  );
}

function CreateAgentButton({ item, onCreated }: { item: WorkItem; onCreated: () => void }) {
  const [state, setState] = useState<"idle" | "prompting" | "creating" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const { toast } = useToast();

  async function handleCreate() {
    const pr = item.prs[0]!;
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
      toast("error", `Failed to create agent: ${e.message}`);
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
        className={cellLinkFlex}
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
      className={`${cellLinkFlex} group`}
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
  collapsed,
  onToggleCollapsed,
  allTags,
  onAddTag,
  onRemoveTag,
  onStatusChanged,
  archived,
  onToggleArchive,
  highlightedId,
}: {
  groups: { label: string; items: WorkItem[]; stackMetaMap?: Map<string, StackMeta> }[];
  errors: string[];
  dimmed?: boolean;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  onAgentCreated: () => void;
  collapsed: Set<string>;
  onToggleCollapsed: (label: string) => void;
  allTags: string[];
  onAddTag: (itemId: string, tag: string) => void;
  onRemoveTag: (itemId: string, tag: string) => void;
  onStatusChanged: (issueIdentifier: string, newStatus: string) => void;
  archived: Set<string>;
  onToggleArchive: (id: string) => void;
  highlightedId: string | null;
}) {
  const colCount = 8;
  return (
    <table className={`w-full ${dimmed ? "opacity-60" : ""}`}>
      <thead className={theadClass}>
        <tr className="border-b border-border">
          <th className="w-[44px] px-0"></th>
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
      {groups.map(({ label, items, stackMetaMap }) => (
      <tbody key={label}>
        {groups.length > 1 && label && <SectionHeader label={label} count={items.length} colSpan={colCount} collapsed={collapsed.has(label)} onToggle={() => onToggleCollapsed(label)} />}
        {!collapsed.has(label) && items.map((item) => {
          const stackMeta = stackMetaMap?.get(item.id);
          const lastUpdated = getLastUpdated(item);
          return (
            <tr
              key={item.id}
              className={tableRowClass}
              data-item-id={item.id}
              data-highlight={highlightedId === item.id ? "true" : undefined}
            >
              <td className="py-1.5 px-0 w-[44px]">
                <div className="flex items-center justify-center gap-0.5">
                  <FavoriteButton id={item.id} isFavorite={favorites.has(item.id)} onToggle={onToggleFavorite} />
                  <ArchiveButton id={item.id} isArchived={archived.has(item.id)} onToggle={onToggleArchive} />
                </div>
              </td>
              <td className="py-1.5 px-2 text-right">
                {lastUpdated && (() => {
                  const { text, color } = timeAgo(lastUpdated);
                  const tooltipEntries: { date: string; label: string }[] = [];
                  if (item.linear?.updatedAt) tooltipEntries.push({ date: item.linear.updatedAt, label: "Linear" });
                  for (const pr of item.prs) {
                    if (pr.updatedAt) tooltipEntries.push({ date: pr.updatedAt, label: "GitHub" });
                  }
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
                <BlockerTags
                  itemId={item.id}
                  tags={item.tags}
                  allTags={allTags}
                  onAdd={onAddTag}
                  onRemove={onRemoveTag}
                >
                  <>
                    {stackMeta && stackMeta.depth > 0 && (
                      <span className="text-text-muted font-mono text-xs whitespace-pre flex-shrink-0">
                        {stackMeta.parentLines.map((hasLine) => hasLine ? "│  " : "   ").join("")}
                        {stackMeta.isLast ? "└─" : "├─"}{" "}
                      </span>
                    )}
                    {(() => {
                      const isClosed = isItemClosed(item);
                      return (
                        <a
                          href={item.linear?.url ?? item.prs[0]?.url ?? item.agents[0]?.url ?? "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`text-sm text-text-primary hover:underline transition-colors line-clamp-1 ${isClosed ? "line-through opacity-50" : ""}`}
                        >
                          {item.title}
                        </a>
                      );
                    })()}
                  </>
                </BlockerTags>
              </td>
              <td className="py-1.5 px-0 text-center w-[24px]">
                {item.linear && item.linear.priority > 0 && (
                  <PriorityBadge priority={item.linear.priority} />
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.linear ? (
                  <LinearStatusDropdown
                    issue={item.linear}
                    onStatusChanged={(newStatus) => onStatusChanged(item.linear!.identifier, newStatus)}
                  />
                ) : item.prs[0] ? (
                  <a
                    href={`https://linear.app/descript/new?title=${encodeURIComponent(item.prs[0].title)}&description=${encodeURIComponent(item.prs[0].url)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-center gap-1 ${cellLink} text-text-muted hover:text-text-secondary`}
                    title="Create Linear issue from PR"
                  >
                    <SiLinear className="w-3.5 h-3.5" />
                    <span className="text-xs">+</span>
                  </a>
                ) : (
                  <EmptyServiceCell><SiLinear className="w-3.5 h-3.5 text-text-muted" /></EmptyServiceCell>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.prs.length > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {item.prs.map(pr => (
                      <PrCellLink key={pr.id} pr={pr} />
                    ))}
                  </div>
                ) : item.linear?.prUrls?.[0] ? (
                  <a
                    href={item.linear.prUrls[0]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cellLinkFlex}
                  >
                    <PrStatusIcon />
                    <span className="text-xs text-text-tertiary font-mono">#{getPrNumber(item.linear.prUrls[0])}</span>
                  </a>
                ) : (
                  <EmptyServiceCell><PrStatusIcon /></EmptyServiceCell>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                {item.agents.length > 0 ? (
                  <a
                    href={item.agents[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cellLinkFlex}
                  >
                    <CursorIcon className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />
                    <span className="text-xs text-text-tertiary">Agent</span>
                    <AgentInfo agent={item.agents[0]} />
                  </a>
                ) : item.prs.length > 0 ? (
                  <CreateAgentButton item={item} onCreated={onAgentCreated} />
                ) : (
                  <EmptyServiceCell><CursorIcon className="w-3.5 h-3.5 text-text-muted" /></EmptyServiceCell>
                )}
              </td>
              <td className="py-1.5 px-1 whitespace-nowrap">
                <ChangesSummary
                  files={item.prs[0]?.changedFiles ?? item.agents[0]?.filesChanged ?? 0}
                  additions={item.prs[0]?.additions ?? item.agents[0]?.linesAdded ?? 0}
                  deletions={item.prs[0]?.deletions ?? item.agents[0]?.linesRemoved ?? 0}
                  url={(() => { const u = item.prs[0]?.url ?? item.linear?.prUrls?.[0]; return u ? `${u}/files` : null; })()}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
      ))}
    </table>
  );
}

type ViewMode = "stage" | "date" | "priority" | "stack" | "review";

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; hotkey?: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  useEffect(() => {
    const mapped = options.filter(o => o.hotkey).map(o => ({ key: o.hotkey!.toLowerCase(), value: o.value }));
    if (mapped.length === 0) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const match = mapped.find(m => m.key === e.key.toLowerCase());
      if (match) { e.preventDefault(); onChange(match.value); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options, onChange]);

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
          {opt.hotkey ? highlightHotkey(opt.label, opt.hotkey) : opt.label}
        </button>
      ))}
    </div>
  );
}

function highlightHotkey(label: string, hotkey: string): React.ReactNode {
  const idx = label.toLowerCase().indexOf(hotkey.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <span className="underline underline-offset-2">{label[idx]}</span>
      {label.slice(idx + 1)}
    </>
  );
}

function isItemClosed(item: WorkItem): boolean {
  const hasActiveAgent = item.agents.some(a => a.status === "running" || a.status === "in_progress");
  if (hasActiveAgent) return false;
  const cursorOnly = !item.linear && item.prs.length === 0 && item.agents.length > 0;
  if (cursorOnly) return true;
  const statusType = item.linear?.statusType;
  if (statusType === "completed" || statusType === "canceled") return true;
  const isVerify = item.linear?.status.toLowerCase() === "verify";
  const openPrs = item.prs.filter(pr => !pr.closed && !pr.merged);
  const hasMerged = item.prs.some(pr => pr.merged);
  if (hasMerged && openPrs.length === 0 && !isVerify) return true;
  if (item.prs.length > 0 && item.prs.every(pr => pr.closed) && !item.linear) return true;
  return false;
}

type ActionGroup = "ready" | "verify" | "review" | "changes" | "draft" | "other";

function getActionGroup(item: WorkItem): ActionGroup {
  if (item.linear?.status.toLowerCase() === "verify") return "verify";
  const pr = item.prs[0];
  if (pr) {
    if (pr.merged) return "other";
    if (pr.reviewDecision === "APPROVED") return "ready";
    if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
    if (pr.draft) return "draft";
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

interface StackMeta {
  depth: number;
  isLast: boolean;
  parentLines: boolean[];
}

function flattenTree(
  item: WorkItem,
  childrenMap: Map<string, WorkItem[]>,
  depth: number,
  parentLines: boolean[],
  isLast: boolean,
): { item: WorkItem; meta: StackMeta }[] {
  const result: { item: WorkItem; meta: StackMeta }[] = [];
  result.push({ item, meta: { depth, isLast, parentLines: [...parentLines] } });
  const branch = item.prs[0]?.branch;
  const children = branch ? childrenMap.get(branch) ?? [] : [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childIsLast = i === children.length - 1;
    if (children.length === 1 && depth === 0) {
      result.push(...flattenTree(child, childrenMap, 0, [], isLast));
    } else {
      const nextParentLines = depth > 0 ? [...parentLines, !isLast] : [];
      result.push(...flattenTree(child, childrenMap, depth + 1, nextParentLines, childIsLast));
    }
  }
  return result;
}

function groupByStack(
  items: WorkItem[],
  favorites: Set<string>,
): { group: ActionGroup; label: string; items: WorkItem[]; stackMetaMap?: Map<string, StackMeta> }[] {
  const favItems: WorkItem[] = [];
  const rest: WorkItem[] = [];
  for (const item of items) {
    if (favorites.has(item.id)) favItems.push(item);
    else rest.push(item);
  }

  const branchToItem = new Map<string, WorkItem>();
  for (const item of rest) {
    const branch = item.prs[0]?.branch;
    if (branch) branchToItem.set(branch, item);
  }

  const childrenMap = new Map<string, WorkItem[]>();
  const hasParent = new Set<string>();
  for (const item of rest) {
    const baseBranch = item.prs[0]?.baseBranch;
    if (!baseBranch || baseBranch === "main" || baseBranch === "master") continue;
    if (branchToItem.has(baseBranch)) {
      const list = childrenMap.get(baseBranch) ?? [];
      list.push(item);
      childrenMap.set(baseBranch, list);
      hasParent.add(item.id);
    }
  }

  const roots: WorkItem[] = [];
  const standalone: WorkItem[] = [];
  for (const item of rest) {
    if (hasParent.has(item.id)) continue;
    const branch = item.prs[0]?.branch;
    if (branch && childrenMap.has(branch)) {
      roots.push(item);
    } else {
      standalone.push(item);
    }
  }

  const groups: { group: ActionGroup; label: string; items: WorkItem[]; stackMetaMap?: Map<string, StackMeta> }[] = [];

  if (favItems.length > 0) {
    groups.push({ group: "other" as ActionGroup, label: "Favorites", items: favItems });
  }

  for (const root of roots) {
    const flat = flattenTree(root, childrenMap, 0, [], true);
    const label = root.linear
      ? `${root.linear.identifier} ${root.title}`
      : root.title;
    const metaMap = new Map<string, StackMeta>();
    for (const f of flat) metaMap.set(f.item.id, f.meta);
    groups.push({
      group: "other" as ActionGroup,
      label,
      items: flat.map(f => f.item),
      stackMetaMap: metaMap,
    });
  }

  if (standalone.length > 0) {
    groups.push({ group: "other" as ActionGroup, label: "No stack", items: standalone });
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
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [viewerLogin, setViewerLogin] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [rateLimits, setRateLimits] = useState<RateLimitInfo[]>([]);
  const [stats, setStats] = useState<ApiStatRow[]>([]);
  const [recent, setRecent] = useState<ApiCallRecord[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ step: number; totalSteps: number } | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const fetchingRef = useRef(false);
  const lastFetchRef = useRef(0);

  const applyChunk = useCallback((json: any) => {
    setItems(json.items ?? []);
    setReviewItems(json.reviewItems ?? []);
    if (json.viewerLogin) setViewerLogin(json.viewerLogin);
    if (json.allTags) setAllTags(json.allTags);
    const rls: RateLimitInfo[] = [];
    if (json.rateLimits?.github) rls.push({ name: "GitHub Core", ...json.rateLimits.github });
    if (json.rateLimits?.githubSearch) rls.push({ name: "GitHub Search", ...json.rateLimits.githubSearch });
    if (json.rateLimits?.linear) rls.push({ name: "Linear", ...json.rateLimits.linear });
    setRateLimits(rls);
    setStats(json.stats ?? []);
    setRecent(json.recent ?? []);
    setErrors(json.errors ?? []);
    if (json.progress) setProgress(json.progress);
    if (json.done) {
      setProgress(null);
      setLastUpdated(Date.now());
    }
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
    registerServiceWorker();
    // If arriving with ?fresh=1 (e.g. after saving settings), force a bypass
    const isFresh = new URLSearchParams(window.location.search).get("fresh") === "1";
    doFetch(isFresh);
    if (isFresh) {
      // Clean up the URL param
      const params = new URLSearchParams(window.location.search);
      params.delete("fresh");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `?${qs}` : "/");
    }
    const id = setInterval(() => doFetch(false), intervalMs);
    return () => clearInterval(id);
  }, [doFetch, intervalMs]);

  const updateItemStatus = useCallback((issueIdentifier: string, newStatus: string) => {
    setItems(prev => prev.map(item =>
      item.linear?.identifier === issueIdentifier
        ? { ...item, linear: { ...item.linear!, status: newStatus } }
        : item
    ));
  }, []);

  const addTag = useCallback((itemId: string, tag: string) => {
    setItems(prev => prev.map(item =>
      item.id === itemId && !item.tags.includes(tag)
        ? { ...item, tags: [...item.tags, tag] }
        : item
    ));
    setAllTags(prev => prev.includes(tag) ? prev : [...prev, tag].sort());
    fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: itemId, tag }),
    }).catch(() => {});
  }, []);

  const removeTag = useCallback((itemId: string, tag: string) => {
    setItems(prev => prev.map(item =>
      item.id === itemId
        ? { ...item, tags: item.tags.filter(t => t !== tag) }
        : item
    ));
    fetch("/api/tags", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: itemId, tag }),
    }).catch(() => {});
  }, []);

  return { items, reviewItems, viewerLogin, allTags, rateLimits, stats, recent, errors, loading, progress, lastUpdated, refresh, updateItemStatus, addTag, removeTag };
}

// Drives desktop notifications on a fast cadence, independent of the heavier
// UI refresh. Runs regardless of window focus — the notification helpers handle
// the skip-while-focused rule themselves.
//
// The server hits GitHub's /notifications endpoint with If-Modified-Since as a
// cheap "anything changed?" gate, so we can poll this often without burning
// rate limit. It also returns GitHub's recommended poll interval, which we
// honor so the client backs off automatically if GitHub asks us to.
function useNotificationPoll() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      let nextDelay = 60000;
      try {
        const res = await fetch("/api/notify-check", { cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          if (!cancelled) {
            const reviews: ReviewItem[] = json.reviewItems ?? [];
            const items: WorkItem[] = json.items ?? [];
            notifyNewReviews(reviews);
            notifyPrReviewChanges(items);
            if (typeof json.pollInterval === "number" && json.pollInterval > 0) {
              nextDelay = json.pollInterval * 1000;
            }
          }
        }
      } catch { /* transient network errors are fine; next tick retries */ }
      if (!cancelled) timer = setTimeout(poll, nextDelay);
    }

    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);
}

function ServiceFilter({ value, onToggle }: { value: Set<string>; onToggle: (svc: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const allChecked = value.size === 0 || value.size === ALL_SERVICES.size;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const services = [
    { key: "linear", label: "Linear", icon: <SiLinear className="w-3.5 h-3.5 text-[#5E6AD2]" /> },
    { key: "github", label: "GitHub", icon: <SiGithub className="w-3.5 h-3.5" /> },
    { key: "closed", label: "Closed PRs", icon: <ClosedPrIcon /> },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`p-1 rounded transition-colors ${allChecked ? "text-text-tertiary hover:text-text-secondary" : "text-text-primary"}`}
        title="Filter by service"
      >
        <FilterIcon />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-surface border border-border rounded-md shadow-lg py-1 z-30 min-w-[150px]">
          {services.map(svc => (
            <button
              key={svc.key}
              onClick={() => onToggle(svc.key)}
              className="flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 transition-colors text-text-secondary hover:bg-surface-hover"
            >
              <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${(allChecked || value.has(svc.key)) ? "bg-blue-500 border-blue-500 text-white" : "border-border"}`}>
                {(allChecked || value.has(svc.key)) && <CheckIcon className="w-2.5 h-2.5" strokeWidth={3} />}
              </span>
              {svc.icon}
              <span>{svc.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
        ({label})
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-surface border border-border rounded-md shadow-lg py-1 z-30 min-w-[140px]">
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

const ALL_SERVICES = new Set(["linear", "github", "closed"]);

const TAG_COLORS = [
  { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/25" },
  { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/25" },
  { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/25" },
  { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/25" },
  { bg: "bg-cyan-500/15", text: "text-cyan-400", border: "border-cyan-500/25" },
  { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/25" },
  { bg: "bg-violet-500/15", text: "text-violet-400", border: "border-violet-500/25" },
  { bg: "bg-pink-500/15", text: "text-pink-400", border: "border-pink-500/25" },
];

function getTagColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function BlockerTags({
  itemId,
  tags,
  allTags,
  onAdd,
  onRemove,
  children,
}: {
  itemId: string;
  tags: string[];
  allTags: string[];
  onAdd: (itemId: string, tag: string) => void;
  onRemove: (itemId: string, tag: string) => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setEditing(false);
        setInput("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  const suggestions = allTags.filter(
    t => !tags.includes(t) && t.toLowerCase().includes(input.toLowerCase())
  );
  const trimmed = input.trim();
  const canCreate = trimmed.length > 0 && !tags.includes(trimmed) && !allTags.includes(trimmed);

  const commitTag = useCallback((tag: string) => {
    onAdd(itemId, tag);
    setInput("");
    setEditing(false);
  }, [itemId, onAdd]);

  const dismiss = useCallback(() => {
    setEditing(false);
    setInput("");
  }, []);

  return (
    <div ref={containerRef}>
      <div className="flex items-center gap-1.5">
        {children}
        {editing && tags.length === 0 ? (
          <div className="relative flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && trimmed) commitTag(trimmed);
                if (e.key === "Escape") dismiss();
              }}
              className="text-[11px] bg-transparent border border-border rounded px-1 py-0.5 w-[80px] outline-none text-text-primary"
              placeholder="tag…"
            />
            {(suggestions.length > 0 || canCreate) && (
              <div className="absolute left-0 top-full mt-0.5 bg-surface border border-border rounded shadow-lg py-0.5 z-40 min-w-[100px] max-h-[120px] overflow-y-auto">
                {canCreate && (
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => commitTag(trimmed)}
                    className="block w-full text-left text-[11px] px-2 py-1 text-text-secondary hover:bg-surface-hover"
                  >
                    Create &ldquo;{trimmed}&rdquo;
                  </button>
                )}
                {suggestions.map(s => {
                  const sc = getTagColor(s);
                  return (
                    <button
                      key={s}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => commitTag(s)}
                      className="block w-full text-left text-[11px] px-2 py-1 text-text-secondary hover:bg-surface-hover"
                    >
                      <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${sc.bg} border ${sc.border}`} />
                      {s}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : tags.length === 0 ? (
          <button
            onClick={() => setEditing(true)}
            className="text-text-muted hover:text-text-secondary hover:bg-fill-muted text-[11px] border border-border rounded px-1.5 py-0.5 transition-colors flex-shrink-0"
            title="Add blocker tag"
          >
            + blocker
          </button>
        ) : null}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 items-center">
          {tags.map(tag => {
            const c = getTagColor(tag);
            return (
              <span
                key={tag}
                className={`inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full border ${c.bg} ${c.text} ${c.border} group/tag`}
              >
                {tag}
                <button
                  onClick={() => onRemove(itemId, tag)}
                  className="opacity-0 group-hover/tag:opacity-100 ml-0.5 hover:text-text-primary transition-opacity leading-none"
                  aria-label={`Remove ${tag}`}
                >
                  &times;
                </button>
              </span>
            );
          })}
          {editing ? (
            <div className="relative flex-shrink-0">
              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && trimmed) commitTag(trimmed);
                  if (e.key === "Escape") dismiss();
                }}
                className="text-[11px] bg-transparent border border-border rounded px-1 py-0.5 w-[80px] outline-none text-text-primary"
                placeholder="tag…"
              />
              {(suggestions.length > 0 || canCreate) && (
                <div className="absolute left-0 top-full mt-0.5 bg-surface border border-border rounded shadow-lg py-0.5 z-40 min-w-[100px] max-h-[120px] overflow-y-auto">
                  {canCreate && (
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => commitTag(trimmed)}
                      className="block w-full text-left text-[11px] px-2 py-1 text-text-secondary hover:bg-surface-hover"
                    >
                      Create &ldquo;{trimmed}&rdquo;
                    </button>
                  )}
                  {suggestions.map(s => {
                    const sc = getTagColor(s);
                    return (
                      <button
                        key={s}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => commitTag(s)}
                        className="block w-full text-left text-[11px] px-2 py-1 text-text-secondary hover:bg-surface-hover"
                      >
                        <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${sc.bg} border ${sc.border}`} />
                        {s}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="text-text-muted hover:text-text-secondary hover:bg-fill-muted text-[11px] border border-border rounded px-1 py-0.5 transition-colors flex-shrink-0"
              title="Add blocker tag"
            >
              +
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("granted");
  const { toast } = useToast();

  useEffect(() => {
    setPermission(getPermissionState());
  }, []);

  // Don't render if already granted or unsupported
  if (permission === "granted" || permission === "unsupported") return null;

  const handleClick = async () => {
    if (permission === "denied") {
      toast("error", "Notifications blocked — check browser site settings to re-enable");
      return;
    }
    const result = await requestPermission();
    setPermission(result);
    if (result === "granted") {
      toast("success", "Notifications enabled");
    } else if (result === "denied") {
      toast("error", "Notifications blocked");
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`${iconButtonClass} relative`}
      title={permission === "denied" ? "Notifications blocked" : "Enable notifications"}
      aria-label={permission === "denied" ? "Notifications blocked" : "Enable notifications"}
    >
      <BellIcon />
      {permission === "default" && (
        <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-status-blue rounded-full" />
      )}
      {permission === "denied" && (
        <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-status-red rounded-full" />
      )}
    </button>
  );
}

function workItemHaystack(item: WorkItem): string {
  const parts: string[] = [
    item.title,
    item.linear?.title ?? "",
    item.linear?.identifier ?? "",
    item.linear?.status ?? "",
    item.linear?.assignee ?? "",
    ...item.prs.flatMap(pr => [pr.title, pr.author, pr.authorLogin, pr.repo, pr.branch]),
    ...item.agents.flatMap(a => [a.name, a.repo, a.branch, a.status]),
    ...item.tags,
  ];
  return parts.join("   ").toLowerCase();
}

function reviewItemHaystack(r: ReviewItem): string {
  const parts: string[] = [
    r.pr.title,
    r.pr.author,
    r.pr.authorLogin,
    r.pr.repo,
    r.pr.branch,
    r.linear?.title ?? "",
    r.linear?.identifier ?? "",
    ...r.pr.requestedTeams.map(t => t.name),
  ];
  return parts.join("   ").toLowerCase();
}

function matchesSearchTerms(haystack: string, terms: string[]): boolean {
  for (const t of terms) if (!haystack.includes(t)) return false;
  return true;
}

function completedItemHaystack(item: WorkItem): string {
  const parts: string[] = [
    item.title,
    item.linear?.title ?? "",
    item.linear?.identifier ?? "",
    item.linear?.status ?? "",
    ...item.prs.flatMap((pr) => [pr.title, pr.repo, pr.branch]),
    ...item.agents.flatMap((a) => [a.name, a.repo, a.branch]),
  ];
  return parts.join("   ").toLowerCase();
}

function completedItemDate(item: WorkItem): string {
  // Prefer the latest merged PR date; otherwise fall back to Linear's updatedAt.
  let latest: string | null = null;
  for (const pr of item.prs) {
    if (pr.mergedAt && (!latest || pr.mergedAt > latest)) latest = pr.mergedAt;
  }
  return latest ?? item.linear?.updatedAt ?? "";
}

function useCompletedItems(active: boolean) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fetchingRef = useRef(false);

  const doFetch = useCallback(async (bypassCache: boolean) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const url = bypassCache ? "/api/completed-issues?fresh=1" : "/api/completed-issues";
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load completed issues");
      setItems(json.items ?? []);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (active && !loaded && !fetchingRef.current) {
      doFetch(false);
    }
  }, [active, loaded, doFetch]);

  const refresh = useCallback(() => doFetch(true), [doFetch]);

  return { items, loading, error, loaded, refresh };
}

type CompletedBucket = { name: string; label: string; items: WorkItem[] };

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDateRange(start: Date, endInclusive: Date): string {
  const sameDay =
    start.getFullYear() === endInclusive.getFullYear() &&
    start.getMonth() === endInclusive.getMonth() &&
    start.getDate() === endInclusive.getDate();
  if (sameDay) return `${MONTH_ABBR[start.getMonth()]} ${start.getDate()}`;
  const sameMonth = start.getMonth() === endInclusive.getMonth() && start.getFullYear() === endInclusive.getFullYear();
  if (sameMonth) {
    return `${MONTH_ABBR[start.getMonth()]} ${start.getDate()}–${endInclusive.getDate()}`;
  }
  return `${MONTH_ABBR[start.getMonth()]} ${start.getDate()} – ${MONTH_ABBR[endInclusive.getMonth()]} ${endInclusive.getDate()}`;
}

function bucketCompletedItems(items: WorkItem[]): CompletedBucket[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (startOfToday.getDay() + 6) % 7; // 0 = Monday
  const startOfThisWeek = new Date(startOfToday);
  startOfThisWeek.setDate(startOfToday.getDate() - dow);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
  const startOfWeekBeforeLast = new Date(startOfLastWeek);
  startOfWeekBeforeLast.setDate(startOfLastWeek.getDate() - 7);
  // 30-day cutoff for the "earlier" bucket end
  const earliestCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const endOfThisWeek = startOfToday;
  const endOfLastWeek = new Date(startOfLastWeek);
  endOfLastWeek.setDate(startOfLastWeek.getDate() + 6);
  const endOfWeekBeforeLast = new Date(startOfWeekBeforeLast);
  endOfWeekBeforeLast.setDate(startOfWeekBeforeLast.getDate() + 6);
  const endOfEarlier = new Date(startOfWeekBeforeLast.getTime() - 1);

  const sorted = [...items].sort((a, b) => completedItemDate(b).localeCompare(completedItemDate(a)));

  const thisWeek: WorkItem[] = [];
  const lastWeek: WorkItem[] = [];
  const weekBeforeLast: WorkItem[] = [];
  const earlier: WorkItem[] = [];

  for (const item of sorted) {
    const d = new Date(completedItemDate(item));
    if (d >= startOfThisWeek) thisWeek.push(item);
    else if (d >= startOfLastWeek) lastWeek.push(item);
    else if (d >= startOfWeekBeforeLast) weekBeforeLast.push(item);
    else earlier.push(item);
  }

  return [
    { name: "This week", label: `This week (${fmtDateRange(startOfThisWeek, endOfThisWeek)})`, items: thisWeek },
    { name: "Last week", label: `Last week (${fmtDateRange(startOfLastWeek, endOfLastWeek)})`, items: lastWeek },
    { name: "Week before last", label: `Week before last (${fmtDateRange(startOfWeekBeforeLast, endOfWeekBeforeLast)})`, items: weekBeforeLast },
    { name: "Past month", label: `Past month (${fmtDateRange(earliestCutoff, endOfEarlier)})`, items: earlier },
  ];
}

function CompletedTable({
  buckets,
  collapsed,
  onToggleCollapsed,
}: {
  buckets: CompletedBucket[];
  collapsed: Set<string>;
  onToggleCollapsed: (label: string) => void;
}) {
  const colCount = 5;
  return (
    <table className="w-full">
      <thead className={theadClass}>
        <tr className="border-b border-border">
          <th className="text-right py-2 px-2 w-[110px]">
            <span className="text-xs font-medium text-text-secondary">Merged</span>
          </th>
          <th className="text-left py-2 px-2">
            <span className="text-xs font-medium text-text-secondary">Item</span>
          </th>
          <th className="text-left py-2 px-1 w-px whitespace-nowrap">
            <span className="flex items-center gap-1.5 px-2">
              <SiLinear className="w-3.5 h-3.5 text-[#5E6AD2]" />
              <span className="text-xs font-medium text-text-secondary">Linear</span>
            </span>
          </th>
          <th className="text-left py-2 px-1 w-px whitespace-nowrap">
            <span className="flex items-center gap-1.5 px-2">
              <SiGithub className="w-3.5 h-3.5 text-text-secondary" />
              <span className="text-xs font-medium text-text-secondary">GitHub</span>
            </span>
          </th>
          <th className="text-left py-2 px-1 w-px whitespace-nowrap">
            <span className="flex items-center gap-1.5 px-2">
              <CursorIcon className="w-3.5 h-3.5 text-text-secondary" />
              <span className="text-xs font-medium text-text-secondary">Cursor</span>
            </span>
          </th>
        </tr>
      </thead>
      {buckets.map(({ label, items }) => (
        <tbody key={label}>
          <SectionHeader
            label={label}
            count={items.length}
            colSpan={colCount}
            collapsed={collapsed.has(label)}
            onToggle={() => onToggleCollapsed(label)}
          />
          {!collapsed.has(label) && items.map((item) => {
            const issue = item.linear!;
            const dateStr = completedItemDate(item);
            const { text, color } = timeAgo(dateStr);
            return (
              <tr key={item.id} className={tableRowClass}>
                <td className="py-1.5 px-2 text-right">
                  <span
                    className={`text-xs ${color} cursor-default hover:underline hover:decoration-dotted`}
                    title={new Date(dateStr).toLocaleString()}
                  >
                    {text}
                  </span>
                </td>
                <td className="py-1.5 px-2">
                  <a
                    href={item.prs[0]?.url ?? issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-text-primary hover:underline transition-colors line-clamp-1"
                  >
                    {item.title}
                  </a>
                </td>
                <td className="py-1.5 px-1 whitespace-nowrap">
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cellLinkFlex}
                    title={`${issue.status} — open ${issue.identifier} in Linear`}
                  >
                    <StatusIcon status={issue.status} />
                    <span className="text-xs text-text-tertiary font-mono">{issue.identifier}</span>
                  </a>
                </td>
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {item.prs.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {item.prs.map((pr) => (
                        <PrCellLink key={pr.id} pr={pr} />
                      ))}
                    </div>
                  ) : issue.prUrls[0] ? (
                    <a
                      href={issue.prUrls[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cellLinkFlex}
                    >
                      <PrStatusIcon />
                      <span className="text-xs text-text-tertiary font-mono">#{getPrNumber(issue.prUrls[0])}</span>
                    </a>
                  ) : (
                    <EmptyServiceCell><PrStatusIcon /></EmptyServiceCell>
                  )}
                </td>
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {item.agents.length > 0 ? (
                    <a
                      href={item.agents[0].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cellLinkFlex}
                    >
                      <CursorIcon className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />
                      <span className="text-xs text-text-tertiary">Agent</span>
                    </a>
                  ) : (
                    <EmptyServiceCell><CursorIcon className="w-3.5 h-3.5 text-text-muted" /></EmptyServiceCell>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

function Home() {
  const { items: allUnfilteredItems, reviewItems, viewerLogin, allTags, rateLimits: rateLimitInfos, stats, recent, errors: serviceErrors, loading: anyLoading, progress, lastUpdated, refresh: refreshAll, updateItemStatus, addTag: rawAddTag, removeTag: rawRemoveTag } = useWorkItems();
  useNotificationPoll();
  const { toast } = useToast();

  // Toast wrappers for tag actions
  const addTag = useCallback((itemId: string, tag: string) => {
    rawAddTag(itemId, tag);
    toast("success", `Tag "${tag}" added`);
  }, [rawAddTag, toast]);

  const removeTag = useCallback((itemId: string, tag: string) => {
    rawRemoveTag(itemId, tag);
    toast("info", `Tag "${tag}" removed`);
  }, [rawRemoveTag, toast]);

  // Toast for status changes
  const handleStatusChanged = useCallback((issueIdentifier: string, newStatus: string) => {
    updateItemStatus(issueIdentifier, newStatus);
    toast("success", `${issueIdentifier} → ${newStatus}`);
  }, [updateItemStatus, toast]);

  // Toast for agent creation
  const handleAgentCreated = useCallback(() => {
    toast("success", "Cursor agent created");
    refreshAll();
  }, [toast, refreshAll]);

  // Tick every 15s to keep "updated X ago" fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const [isElectron, setIsElectron] = useState(false);
  useEffect(() => {
    if (navigator.userAgent.includes("Electron")) setIsElectron(true);
  }, []);
  const titlebarHeight = isElectron ? 38 : 0;

  const searchParams = useSearchParams();


  type Tab = "tasks" | "review" | "completed";
  type SortMode = "stage" | "priority" | "stack" | "date";
  const [tab, setTabState] = useState<Tab>("tasks");
  const [sort, setSortState] = useState<SortMode>("stage");
  const [repoFilter, setRepoFilterState] = useState("descript");
  const [serviceFilter, setServiceFilterState] = useState<Set<string>>(new Set<string>());
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        const el = searchInputRef.current;
        if (el) { el.focus(); el.select(); }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sync from URL on mount
  useEffect(() => {
    const t = searchParams.get("tab") as Tab;
    const s = searchParams.get("sort") as SortMode;
    const r = searchParams.get("repo");
    const svc = searchParams.get("svc");
    // Migrate legacy "view" param
    const legacyView = searchParams.get("view") as string;
    if (legacyView) {
      if (legacyView === "review") { setTabState("review"); }
      else if (legacyView === "stage" || legacyView === "priority" || legacyView === "date") { setSortState(legacyView); }
    }
    if (t === "tasks" || t === "review" || t === "completed") setTabState(t);
    if (s && (s === "stage" || s === "priority" || s === "stack" || s === "date")) setSortState(s);
    if (r && r !== repoFilter) setRepoFilterState(r);
    if (svc) setServiceFilterState(new Set(svc.split(",").filter(v => ALL_SERVICES.has(v))));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setParam = useCallback((key: string, value: string, defaultValue: string) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("view"); // clean up legacy param
    if (value === defaultValue) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : "/");
  }, []);

  const setTab = useCallback((t: Tab) => { setTabState(t); setParam("tab", t, "tasks"); }, [setParam]);

  // Notification click → switch tab, scroll to row, flash highlight
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: Tab; itemId?: string } | undefined;
      if (!detail) return;
      if (detail.tab) {
        setTabState(detail.tab);
        setParam("tab", detail.tab, "tasks");
      }
      if (detail.itemId) {
        const target = detail.itemId;
        setHighlightedId(target);
        // Wait two frames for the tab switch + layout, then scroll
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const el = document.querySelector(`[data-item-id="${CSS.escape(target)}"]`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }));
        window.setTimeout(() => {
          setHighlightedId(curr => (curr === target ? null : curr));
        }, 3000);
      }
    };
    window.addEventListener("dashboard:focusItem", handler);
    return () => window.removeEventListener("dashboard:focusItem", handler);
  }, [setParam]);

  const setSort = useCallback((s: SortMode) => { setSortState(s); setParam("sort", s, "stage"); }, [setParam]);
  const view = tab === "review" ? "review" as ViewMode : sort as ViewMode;
  const isOpen = sort === "stage" || sort === "priority";
  const isReview = tab === "review";
  const isCompleted = tab === "completed";

  const completed = useCompletedItems(isCompleted);
  const setRepoFilter = useCallback((v: string) => { setRepoFilterState(v); setParam("repo", v, "descript"); }, [setParam]);
  const toggleServiceFilter = useCallback((svc: string) => {
    setServiceFilterState(prev => {
      const expanded = prev.size === 0 ? new Set(ALL_SERVICES) : new Set(prev);
      if (expanded.has(svc)) expanded.delete(svc); else expanded.add(svc);
      if (expanded.size === ALL_SERVICES.size) return new Set<string>();
      return expanded;
    });
  }, []);
  useEffect(() => {
    const val = serviceFilter.size === 0 ? "" : [...serviceFilter].sort().join(",");
    setParam("svc", val, "");
  }, [serviceFilter, setParam]);
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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>();
    try {
      const saved = localStorage.getItem("dashboard:collapsed");
      if (saved) return new Set(JSON.parse(saved));
      return new Set<string>(["Archived"]);
    } catch { return new Set<string>(["Archived"]); }
  });
  const toggleCollapsed = useCallback((label: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      localStorage.setItem("dashboard:collapsed", JSON.stringify([...next]));
      return next;
    });
  }, []);


  const [archived, setArchived] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>();
    try {
      const saved = localStorage.getItem("dashboard:archived");
      return saved ? new Set(JSON.parse(saved)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const toggleArchive = useCallback((id: string) => {
    setArchived(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem("dashboard:archived", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const item of allUnfilteredItems) {
      for (const pr of item.prs) set.add(pr.repo.split("/").pop()!);
      if (item.agents.length > 0) set.add(item.agents[0].repo.split("/").pop()!);
    }
    return Array.from(set).sort();
  }, [allUnfilteredItems]);

  const allItems = useMemo(() => {
    let items = allUnfilteredItems;
    if (repoFilter !== "all") {
      const repoSuffix = `/${repoFilter}`;
      items = items.filter(item => {
        if (item.prs.some(pr => pr.repo.endsWith(repoSuffix) || pr.repo === repoFilter)) return true;
        if (item.agents.some(a => a.repo.endsWith(repoSuffix) || a.repo === repoFilter)) return true;
        if (item.prs.length === 0 && item.agents.length === 0) {
          const prUrls = item.linear?.prUrls ?? [];
          if (prUrls.length === 0) return true;
          return prUrls.some(url => url.includes(`/${repoFilter}/`));
        }
        return false;
      });
    }
    const showAll = serviceFilter.size === 0 || serviceFilter.size === ALL_SERVICES.size;
    if (!showAll) {
      const showClosed = serviceFilter.has("closed");
      const showLinear = serviceFilter.has("linear");
      const showGithub = serviceFilter.has("github");

      if (!showClosed) {
        items = items.flatMap(item => {
          const hadClosed = item.prs.some(pr => pr.closed);
          if (!hadClosed) return [item];
          const openPrs = item.prs.filter(pr => !pr.closed);
          if (openPrs.length === 0) return [];
          const updated: WorkItem = { ...item, prs: openPrs };
          if (updated.linear?.prUrls?.length) {
            const closedUrls = new Set(item.prs.filter(pr => pr.closed).map(pr => pr.url));
            const filteredUrls = updated.linear.prUrls.filter(u => !closedUrls.has(u));
            if (filteredUrls.length !== updated.linear.prUrls.length) {
              updated.linear = { ...updated.linear, prUrls: filteredUrls };
            }
          }
          return [updated];
        });
      }

      if (!showLinear || !showGithub) {
        items = items.filter(item => {
          if (showLinear && item.linear) return true;
          if (showGithub && item.prs.length > 0) return true;
          if (item.agents.length > 0) return true;
          return false;
        });
      }

      items = items.filter(item => item.linear || item.prs.length > 0 || item.agents.length > 0);
    }
    return items;
  }, [allUnfilteredItems, repoFilter, serviceFilter]);

  const searchTerms = useMemo(
    () => search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [search],
  );

  const visibleItems = useMemo(() => {
    let items = allItems.filter(i => !archived.has(i.id));
    if (searchTerms.length > 0) {
      items = items.filter(i => matchesSearchTerms(workItemHaystack(i), searchTerms));
    }
    return items;
  }, [allItems, archived, searchTerms]);

  const archivedVisibleItems = useMemo(() => {
    let items = allItems.filter(i => archived.has(i.id));
    if (searchTerms.length > 0) {
      items = items.filter(i => matchesSearchTerms(workItemHaystack(i), searchTerms));
    }
    return items;
  }, [allItems, archived, searchTerms]);

  const filteredReviewItems = useMemo(() => {
    let items = reviewItems;
    if (repoFilter !== "all") {
      const repoSuffix = `/${repoFilter}`;
      items = items.filter(item =>
        item.pr.repo.endsWith(repoSuffix) || item.pr.repo === repoFilter,
      );
    }
    if (searchTerms.length > 0) {
      items = items.filter(i => matchesSearchTerms(reviewItemHaystack(i), searchTerms));
    }
    return items;
  }, [reviewItems, repoFilter, searchTerms]);

  const activeReviewItems = useMemo(
    () => filteredReviewItems.filter(i => !archived.has(i.id)),
    [filteredReviewItems, archived],
  );
  const archivedReviewItems = useMemo(
    () => filteredReviewItems.filter(i => archived.has(i.id)),
    [filteredReviewItems, archived],
  );

  const filteredCompletedItems = useMemo(() => {
    if (searchTerms.length === 0) return completed.items;
    return completed.items.filter(i => matchesSearchTerms(completedItemHaystack(i), searchTerms));
  }, [completed.items, searchTerms]);
  const completedBuckets = useMemo(() => bucketCompletedItems(filteredCompletedItems), [filteredCompletedItems]);
  const completedTotal = filteredCompletedItems.length;

  const { open, closed } = useMemo(() => {
    const open: WorkItem[] = [];
    const closed: WorkItem[] = [];
    for (const item of visibleItems) {
      if (isItemClosed(item)) {
        closed.push(item);
      } else {
        open.push(item);
      }
    }
    return { open, closed };
  }, [visibleItems]);

  const displayGroups = useMemo(() => {
    const items = view === "date" ? visibleItems : open;
    const sorted = sortByDate(items);
    let groups: { group: ActionGroup; label: string; items: WorkItem[]; stackMetaMap?: Map<string, StackMeta> }[];
    if (view === "stage") groups = groupByAction(sorted, favorites);
    else if (view === "priority") groups = groupByPriority(sorted, favorites);
    else if (view === "stack") groups = groupByStack(sorted, favorites);
    else groups = [{ group: "other" as ActionGroup, label: "", items: sorted }];
    if (archivedVisibleItems.length > 0) {
      groups = [...groups, { group: "other" as ActionGroup, label: "Archived", items: sortByDate(archivedVisibleItems) }];
    }
    return groups;
  }, [view, open, visibleItems, archivedVisibleItems, favorites]);

  const displayItems = displayGroups.flatMap(g => g.items);

  const pageTitle = useMemo(() => {
    const section = isCompleted ? "Completed" : isReview ? "Requested reviews" : "My tasks";
    let summary = "";
    if (isCompleted) {
      summary = completedTotal > 0 ? `${completedTotal}` : "";
    } else if (isReview) {
      summary = formatReviewSummary(activeReviewItems);
    } else if (open.length > 0) {
      const stageGroups = groupByAction(sortByDate(open), new Set());
      const SHORT_LABELS: Record<string, string> = { "Changes requested": "Changes", "Waiting": "Review" };
      summary = stageGroups.map(g => `${g.items.length} ${(SHORT_LABELS[g.label] || g.label).toLowerCase()}`).join(" · ");
    }
    return summary ? `${section} · ${summary}` : section;
  }, [isCompleted, completedTotal, isReview, activeReviewItems, open]);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);


  return (
    <div className="w-full px-4 py-4" style={{ "--titlebar-height": `${titlebarHeight}px` } as React.CSSProperties}>
      {isElectron && <div className="h-[38px] -mx-4 -mt-4 sticky top-0 z-30 bg-background" data-drag-region />}
      <header className="mb-1 sticky top-[var(--titlebar-height,0px)] z-20 bg-background/70 backdrop-blur-[2px] py-3 -mt-3">
        <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-text-primary">Dashboard</h1>
        <ToggleGroup
          options={[
            { value: "tasks" as const, label: `My tasks${open.length > 0 ? ` (${open.length})` : ""}`, hotkey: "m" },
            { value: "review" as const, label: `Requested reviews${filteredReviewItems.length > 0 ? ` (${filteredReviewItems.length})` : ""}`, hotkey: "r" },
          ]}
          value={isReview ? "review" as const : "tasks" as const}
          onChange={(v) => setTab(v as Tab)}
        />
        <button
          onClick={refreshAll}
          disabled={anyLoading}
          className={`${iconButtonClass} disabled:opacity-50`}
          title="Refresh all"
          aria-label="Refresh all"
        >
          <RefreshIcon className={`w-4 h-4 ${anyLoading ? "animate-spin" : ""}`} />
        </button>
        <span className="text-[11px] text-text-tertiary tabular-nums" suppressHydrationWarning>
          {progress ? `${progress.step}/${progress.totalSteps}` : lastUpdated ? timeAgo(new Date(lastUpdated).toISOString()).text : ""}
        </span>
        {rateLimitInfos.length > 0 && (
          <ApiStatsPopover rateLimits={rateLimitInfos} stats={stats} recent={recent} />
        )}
        <div className="flex-1" />
        <input
          ref={searchInputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearch("");
              e.currentTarget.blur();
            }
          }}
          placeholder="Filter (F)"
          aria-label="Filter items"
          className="text-xs px-2 py-1 border border-border rounded bg-background text-text-primary placeholder:text-text-tertiary w-36 focus:w-56 focus:outline-none focus:border-text-tertiary transition-all"
        />
        {!isReview && !isCompleted && <ServiceFilter value={serviceFilter} onToggle={toggleServiceFilter} />}
        {!isReview && (
          <ToggleGroup
            options={[
              { value: "stage", label: "Status", hotkey: "s" },
              { value: "priority", label: "Priority", hotkey: "p" },
              { value: "stack", label: "Stack", hotkey: "k" },
              { value: "date", label: "All", hotkey: "a" },
              { value: "completed", label: `Completed${completedTotal > 0 ? ` (${completedTotal})` : ""}`, hotkey: "c" },
            ]}
            value={isCompleted ? "completed" : sort}
            onChange={(v) => {
              if (v === "completed") {
                setTab("completed");
              } else {
                if (isCompleted) setTab("tasks");
                setSort(v as SortMode);
              }
            }}
          />
        )}
        <NotificationBell />
        <a
          href="/settings"
          className={iconButtonClass}
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon />
        </a>
        </div>
        <div className="text-sm text-text-tertiary mt-1 flex items-center gap-1">
          {!isCompleted && repos.length > 1 && <><RepoFilter repos={repos} value={repoFilter} onChange={setRepoFilter} /><span>·</span></>}
          {isCompleted ? (completedBuckets.filter(b => b.items.length > 0).map(b => `${b.items.length} ${b.name.toLowerCase()}`).join(" · ")) : isReview ? formatReviewSummary(activeReviewItems, true) : (() => {
            if (open.length === 0) return "";
            const stageGroups = groupByAction(sortByDate(open), new Set());
            return stageGroups.map(g => `${g.items.length} ${g.label.toLowerCase()}`).join(" · ");
          })()}
          {!isReview && !isCompleted && archivedVisibleItems.length > 0 && (
            <>
              {open.length > 0 && <span> · </span>}
              <span className="text-text-muted">{archivedVisibleItems.length} archived</span>
            </>
          )}
          {isReview && archivedReviewItems.length > 0 && (
            <>
              {activeReviewItems.length > 0 && <span> · </span>}
              <span className="text-text-muted">{archivedReviewItems.length} archived</span>
            </>
          )}
        </div>
      </header>

      {serviceErrors.length > 0 && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-status-red/20 bg-status-red/5">
          <div className="flex items-center gap-2 mb-1">
            <WarningIcon className="w-4 h-4 text-status-red flex-shrink-0" />
            <span className="text-sm font-medium text-status-red">Connection errors</span>
            <a href="/settings" className="ml-auto text-xs text-text-tertiary hover:text-text-secondary hover:underline transition-colors">Check Settings &rarr;</a>
          </div>
          {serviceErrors.map((err, i) => (
            <p key={i} className="text-xs text-status-red/80 ml-6">{err}</p>
          ))}
        </div>
      )}

      {isReview ? (
        <>
          <ReviewQueue items={filteredReviewItems} favorites={favorites} onToggleFavorite={toggleFavorite} archived={archived} onToggleArchive={toggleArchive} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} highlightedId={highlightedId} />
          {filteredReviewItems.length === 0 && !anyLoading && (
            <div className="text-center py-16 space-y-2">
              <p className="text-sm text-text-tertiary">No PRs awaiting your review</p>
              {serviceErrors.length > 0 && (
                <a href="/settings" className="inline-block text-xs text-text-tertiary hover:text-text-secondary hover:underline transition-colors">Check Settings &rarr;</a>
              )}
            </div>
          )}
        </>
      ) : isCompleted ? (
        <>
          <CompletedTable
            buckets={completedBuckets}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
          {completed.error && (
            <div className="text-center py-16 text-sm text-status-red">{completed.error}</div>
          )}
          {!completed.error && completedTotal === 0 && !completed.loading && completed.loaded && (
            <div className="text-center py-16 text-sm text-text-tertiary">
              No completed issues in the last 30 days
            </div>
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
            onAgentCreated={handleAgentCreated}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            allTags={allTags}
            onAddTag={addTag}
            onRemoveTag={removeTag}
            onStatusChanged={handleStatusChanged}
            archived={archived}
            onToggleArchive={toggleArchive}
            highlightedId={highlightedId}
          />
          {displayItems.length === 0 && !anyLoading && (
            <div className="text-center py-16 space-y-3">
              <GearIcon className="w-10 h-10 mx-auto text-text-muted" strokeWidth={1.5} />
              <p className="text-sm text-text-secondary font-medium">No active items</p>
              <p className="text-sm text-text-tertiary">Add your API keys to get started</p>
              <a
                href="/settings"
                className="inline-block mt-2 px-4 py-1.5 text-sm font-medium rounded-md bg-text-primary text-background hover:opacity-90 transition-opacity"
              >
                Open Settings
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
