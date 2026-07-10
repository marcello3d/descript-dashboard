"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SiLinear, SiGithub } from "react-icons/si";
import { FaBug } from "react-icons/fa";
import type { CursorAgent, GitHubPR, LinearIssue, WorkItem, ReviewItem } from "@/types";
import { getLastUpdated } from "@/lib/work-items";
import { errorMessage } from "@/lib/errors";
import { registerServiceWorker, notifyNewReviews, notifyPrReviewChanges, getPermissionState, requestPermission } from "@/lib/notifications";
import { StatusIcon } from "@/components/LinearStatus";
import LinearStatusDropdown from "@/components/LinearStatusDropdown";
import LinearPriorityDropdown, { priorityConfig } from "@/components/LinearPriorityDropdown";
import { useToast } from "@/components/Toast";
import {
  BellIcon,
  CheckIcon,
  ClaudeIcon,
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
  SlackIcon,
  StackIcon,
  WarningIcon,
} from "@/components/icons";

// GitHub PR status icons (Octicons)
function PrStatusIcon({ pr }: { pr?: { draft: boolean; merged: boolean; closed?: boolean } }) {
  if (!pr) return <SiGithub className="w-3.5 h-3.5 text-text-muted" />;
  if (pr.closed) return <ClosedPrIcon />;
  if (pr.merged) return <MergedPrIcon />;
  if (pr.draft) return <DraftPrIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />;
  return <OpenPrIcon />;
}

// Stack/tree connector drawn with crisp 1px CSS lines instead of box-drawing
// glyphs: a rounded elbow for the last child, a straight tee otherwise. Each
// ancestor level that still has following siblings draws a vertical
// continuation line. Lines bleed 6px into the row's vertical padding
// (-top-1.5 / -bottom-1.5) so they join seamlessly across rows. Relies on the
// parent being a `flex items-center` row (self-stretch → full content height).
function TreeConnector({ lines, isLast }: { lines: boolean[]; isLast: boolean }) {
  const LEVEL = "relative w-[20px]";
  const LINE = "bg-text-muted/70";
  const BORDER = "border-text-muted/70";
  // Standard tree: each elbow is a self-contained `└` sitting under its parent's
  // text — its short up-stub bleeds 8px into the padding gap above. A tee (`├`,
  // a node with a following sibling) continues 8px down, so the next sibling's
  // up-stub meets it in the gap: siblings touch, nested elbows don't. Ancestor
  // guides span full height. Verticals are inset `left-2.5` (past the column
  // edge + the connector's `mr-1.5` text gap) so a nested elbow tucks under its
  // parent's text rather than sitting left of it, and the elbow arm stays short.
  const GUIDE = `absolute left-2.5 -top-2 -bottom-2 w-px ${LINE}`;
  return (
    <span className="self-stretch flex flex-shrink-0 mr-1.5" aria-hidden="true">
      {lines.map((hasLine, i) => (
        <span key={i} className={LEVEL}>{hasLine && <span className={GUIDE} />}</span>
      ))}
      <span className={LEVEL}>
        {isLast ? (
          // rounded elbow: left border = vertical, bottom border = horizontal
          <span className={`absolute left-2.5 right-0 -top-2 bottom-1/2 border-l border-b ${BORDER} rounded-bl-md`} />
        ) : (
          <>
            <span className={`absolute left-2.5 -top-2 -bottom-2 w-px ${LINE}`} />
            <span className={`absolute left-2.5 right-0 top-1/2 -translate-y-1/2 h-px ${LINE}`} />
          </>
        )}
      </span>
    </span>
  );
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

function PriorityBadge({ priority }: { priority: number }) {
  const config = priorityConfig[priority];
  if (!config) return null;
  return (
    <span className={`text-[10px] font-mono font-medium ${config.color}`} title={config.name}>
      {config.label}
    </span>
  );
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

function getPrNumber(url: string): string {
  return url.match(/\/pull\/(\d+)/)?.[1] ?? "";
}

// Sticky header applied to the <th> CELLS, not the <thead>. WebKit doesn't paint
// a table section's (<thead>/<tr>) background as an occluding layer, so a sticky
// <thead> lets scrolled content bleed through it in Safari; sticky cells with
// their own opaque background occlude reliably across browsers.
//
// The vertical offsets are driven by `--work-header-h` — the measured height of
// the page header (see the ResizeObserver in the Dashboard component) — so the
// column header sticks flush under the page header instead of behind it, and the
// section header sticks flush under the column header (36px). Fallbacks match the
// previous hardcoded values in case the var hasn't been set yet.
const theadClass =
  "[&>tr>th]:sticky [&>tr>th]:top-[calc(var(--titlebar-height,0px)+var(--work-header-h,52px))] [&>tr>th]:z-10 [&>tr>th]:bg-background [&>tr>th]:!py-1";
const sectionHeaderClass =
  "sticky top-[calc(var(--titlebar-height,0px)+var(--work-header-h,52px)+32px)] z-[5] bg-surface-alt";
const tableRowClass = "border-b border-border-muted hover:bg-surface-hover transition-colors group";
// Same row, minus the bottom divider — used to visually fuse the rows of a
// stack (a multi-PR ticket + its PR rows) into one group.
const tableRowClassNoBorder = "hover:bg-surface-hover transition-colors group";
const cellLink = "py-1.5 px-1.5 -my-1 rounded hover:bg-fill-muted transition-colors";
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

function PrCellLink({ pr, onMerged }: { pr: GitHubPR; onMerged?: () => void }) {
  const isStacked = pr.baseBranch && pr.baseBranch !== "main" && pr.baseBranch !== "master";
  return (
    <div className="flex flex-row items-center gap-1">
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
        <CopyBranchButton branch={pr.branch} />
      </span>
      {/* fixed-width slot so a bug-bot badge lives in its own column and never
          shifts the merge button (empty on PRs with no bug-bot findings) */}
      <span className="w-7 flex justify-center flex-shrink-0">
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
      </span>
      <TrunkMergeCell pr={pr} onMerged={onMerged} />
    </div>
  );
}

// Trunk merge-queue status + a `/trunk merge` button, shown beneath the PR link.
// Falls back to the plain "Ready to merge" label for repos not managed by Trunk.
function TrunkMergeCell({ pr, onMerged }: { pr: GitHubPR; onMerged?: () => void }) {
  const trunk = pr.trunk;
  const ready = pr.mergeReadiness?.ready ?? false;

  if (pr.merged || pr.closed) return null;

  // No Trunk comment → can't post `/trunk merge`; keep the original readiness label.
  if (!trunk) {
    return ready ? (
      <span className="text-xs text-status-green font-medium">Ready to merge</span>
    ) : null;
  }

  // In-queue states show status only — the PR is already submitted.
  const queued: Partial<Record<typeof trunk.state, string>> = {
    submitted: "text-status-yellow",
    waiting_batch: "text-status-yellow",
    testing: "text-status-blue",
    merged: "text-status-purple",
  };
  const queuedColor = queued[trunk.state];
  if (queuedColor) {
    // Collapse the verbose in-flight labels to a single "In merge queue"; the
    // full state is kept as a tooltip. "Merged" is terminal, so leave it.
    const label = trunk.state === "merged" ? "Merged" : "In merge queue";
    return <TrunkStatusLabel color={queuedColor} label={label} title={trunk.label} url={trunk.detailsUrl} />;
  }

  // Submittable states (awaiting / failed / canceled) → show the merge button.
  // Readiness is carried by the button's color, not a separate label.
  return (
    <div className="flex items-center gap-2">
      {trunk.state === "failed" && (
        <TrunkStatusLabel color="text-status-red" label="Merge failed" url={trunk.detailsUrl} />
      )}
      {trunk.state === "canceled" && (
        <TrunkStatusLabel color="text-text-tertiary" label="Merge canceled" url={trunk.detailsUrl} />
      )}
      {trunk.canSubmit && (
        <TrunkMergeButton
          pr={pr}
          onMerged={onMerged}
          label={trunk.state === "awaiting" ? "Merge" : "Retry merge"}
          ready={trunk.state === "awaiting" && ready}
        />
      )}
    </div>
  );
}

function TrunkStatusLabel({ color, label, url, title }: { color: string; label: string; url: string | null; title?: string }) {
  const text = <span className={`text-xs font-medium ${color}`}>{label}</span>;
  if (!url) return text;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline" title={title ?? "View in Trunk merge queue"}>
      {text}
    </a>
  );
}

// Two-step confirm button that posts `/trunk merge` on the PR.
function TrunkMergeButton({ pr, onMerged, label, ready }: { pr: GitHubPR; onMerged?: () => void; label: string; ready?: boolean }) {
  const [state, setState] = useState<"idle" | "confirm" | "merging" | "done" | "error">("idle");
  const { toast } = useToast();
  const num = getPrNumber(pr.url);
  const reasons = pr.mergeReadiness?.reasons ?? [];

  // Drafts can't be merged at all — render a fully disabled, non-clickable button.
  if (pr.draft) {
    return (
      <button
        disabled
        className="text-xs font-medium px-1.5 py-0.5 rounded border border-border-muted/40 text-text-muted/50 cursor-not-allowed"
        title={reasons.length ? `Not ready: ${reasons.join(", ")}` : "Draft — not ready to merge"}
      >
        {label}
      </button>
    );
  }

  async function submit() {
    setState("merging");
    try {
      const res = await fetch("/api/trunk-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: pr.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to queue merge");
      setState("done");
      toast("success", `Queued /trunk merge for #${num}`);
      onMerged?.();
    } catch (e) {
      setState("error");
      toast("error", `Merge failed: ${errorMessage(e)}`);
    }
  }

  if (state === "done") return <span className="text-xs text-status-green font-medium">Queued ✓</span>;
  if (state === "merging") return <span className="text-xs text-text-tertiary">Submitting…</span>;

  if (state === "confirm") {
    return (
      <span className="inline-flex items-center gap-2">
        <button onClick={submit} className="text-xs font-medium text-status-green hover:underline" title={`Comment "/trunk merge" on #${num}`}>
          Confirm merge
        </button>
        <button onClick={() => setState("idle")} className="text-xs text-text-tertiary hover:text-text-secondary transition-colors">
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setState("confirm")}
      className={`text-xs font-medium px-1.5 py-0.5 rounded border transition-colors ${
        ready
          ? "border-status-green/40 text-status-green hover:bg-status-green/10 hover:border-status-green"
          : "border-border-muted/60 text-text-muted hover:text-text-secondary hover:bg-fill-muted hover:border-border"
      }`}
      title={
        ready
          ? `Ready to merge — comment "/trunk merge" on #${num}`
          : reasons.length
            ? `Not ready: ${reasons.join(", ")} — comment "/trunk merge" on #${num}`
            : `Comment "/trunk merge" on #${num}`
      }
    >
      {state === "error" ? "Retry" : label}
    </button>
  );
}

function CopyBranchButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`${iconButtonClass} rounded hover:bg-fill-muted opacity-0 group-hover:opacity-100`}
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
    <>
      {/* Non-sticky grey spacer: gives the section header breathing room above
          the label, but scrolls away so the stuck header is a clean normal-height
          row. Same grey as the label row, no border between them. */}
      <tr className="bg-surface-alt" aria-hidden="true">
        <td colSpan={colSpan} className="h-3 p-0" />
      </tr>
      <tr className={sectionHeaderClass}>
        <td colSpan={colSpan} className="py-1.5 px-2">
          <button onClick={onToggle} className="text-xs font-semibold text-text-tertiary uppercase tracking-wide hover:text-text-secondary transition-colors cursor-pointer inline-flex items-center gap-1.5">
            <span className="inline-block w-4 text-xs">{collapsed ? "▸" : "▾"}</span>
            {isDraft && <DraftPrIcon className="w-3.5 h-3.5 flex-shrink-0" />}
            <span>{isDraft ? `DRAFT: ${label}` : label}</span>
            <span className="font-normal">({count})</span>
          </button>
        </td>
      </tr>
    </>
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

// A small status dot overlaid on the Cursor icon (green running / red failed /
// yellow otherwise), so agent status costs no horizontal space — the status is
// spelled out in the icon's tooltip. Finished agents show no dot.
function AgentStatusDot({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "finished") return null;
  const color =
    s === "running" || s === "in_progress"
      ? "bg-status-green"
      : s === "failed" || s === "error"
      ? "bg-status-red"
      : "bg-status-yellow";
  return (
    <span
      className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-surface ${color}`}
      aria-hidden="true"
    />
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

function CreateAgentButton({ pr, linear, title, onCreated }: { pr: GitHubPR; linear?: LinearIssue; title: string; onCreated: () => void }) {
  const [state, setState] = useState<"idle" | "prompting" | "creating" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const { toast } = useToast();

  async function handleCreate() {
    const defaultPrompt = linear
      ? `Address the PR feedback and fix any issues on this PR: ${pr.url}\n\nLinear issue: ${linear.url}\n\nTitle: ${title}`
      : `Continue working on this PR: ${pr.url}\n\nTitle: ${title}`;
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
    } catch (e) {
      const msg = errorMessage(e);
      setState("error");
      setError(msg);
      toast("error", `Failed to create agent: ${msg}`);
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
      className="text-text-muted/40 hover:text-text-secondary p-1 rounded hover:bg-fill-muted transition-colors"
      title="Create Cursor agent for this PR"
      aria-label="Create Cursor agent for this PR"
    >
      <CursorIcon className="w-3.5 h-3.5" />
    </button>
  );
}

// "Links" column: consolidates the Claude Code session, the requesting Slack
// thread, and the Cursor agent for a work item into icon-only links. When there
// is no agent yet but a PR exists and onAgentCreated is provided, the Cursor
// icon doubles as a "create agent" button. Each icon gets a fixed-width slot so
// the columns stay vertically aligned across rows even when a link is absent.
const linkSlotClass = "w-[22px] flex items-center justify-center flex-shrink-0";
// transition-colors (not -all / opacity) — animating opacity promotes a
// compositor layer mid-hover, which visibly snaps the icon by a subpixel.
const linkIconClass = "p-1 rounded hover:bg-fill-muted transition-colors";

// Presentational "Links" cell. Scopes to a single PR's Claude/Slack/agent when
// rendering a stacked child row, or aggregates across an item's PRs via the
// WorkItemLinksCell wrapper for the ticket/single-PR row.
function LinksCell({
  claudeUrl,
  slackUrl,
  agent,
  createPr,
  linear,
  title,
  onAgentCreated,
}: {
  claudeUrl: string | null;
  slackUrl: string | null;
  agent: CursorAgent | undefined;
  createPr: GitHubPR | null;
  linear?: LinearIssue;
  title: string;
  onAgentCreated?: () => void;
}) {
  const canCreateAgent = !agent && Boolean(onAgentCreated) && Boolean(createPr);

  return (
    // block-level flex (not inline-flex): lets the cell's `align-middle` truly
    // vertically center the icons — an inline-flex box aligns to the text
    // baseline of the line box instead, sitting a few px high.
    <span className="flex items-center gap-0.5">
      <span className={linkSlotClass}>
        {claudeUrl && (
          <a
            href={claudeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={linkIconClass}
            title="Opened by Claude — open Claude Code session"
            aria-label="Open Claude Code session"
          >
            <ClaudeIcon className="w-3.5 h-3.5" />
          </a>
        )}
      </span>
      <span className={linkSlotClass}>
        {slackUrl && (
          <a
            href={slackUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={linkIconClass}
            title="Open Slack thread"
            aria-label="Open Slack thread"
          >
            <SlackIcon className="w-3.5 h-3.5" />
          </a>
        )}
      </span>
      <span className={`${linkSlotClass} w-auto min-w-[22px]`}>
        {agent ? (
          <a
            href={agent.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${linkIconClass} inline-flex items-center text-text-secondary hover:text-text-primary`}
            title={`Cursor agent — ${agent.status.toLowerCase()}`}
            aria-label={`Open Cursor agent (${agent.status.toLowerCase()})`}
          >
            <span className="relative inline-flex">
              <CursorIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <AgentStatusDot status={agent.status} />
            </span>
          </a>
        ) : canCreateAgent ? (
          <CreateAgentButton pr={createPr!} linear={linear} title={title} onCreated={onAgentCreated!} />
        ) : (
          <CursorIcon className="w-3.5 h-3.5 text-text-muted/40" />
        )}
      </span>
    </span>
  );
}

function WorkItemLinksCell({ item, onAgentCreated }: { item: WorkItem; onAgentCreated?: () => void }) {
  const claudeUrl = item.prs.find(pr => pr.claudeSessionUrl)?.claudeSessionUrl ?? null;
  const slackUrl = item.prs.find(pr => pr.slackThreadUrl)?.slackThreadUrl ?? null;
  return (
    <LinksCell
      claudeUrl={claudeUrl}
      slackUrl={slackUrl}
      agent={item.agents[0]}
      createPr={item.prs[0] ?? null}
      linear={item.linear}
      title={item.title}
      onAgentCreated={onAgentCreated}
    />
  );
}

function WorkItemTable({
  groups,
  errors,
  dimmed,
  favorites,
  onToggleFavorite,
  onAgentCreated,
  onMerged,
  collapsed,
  onToggleCollapsed,
  allTags,
  onAddTag,
  onRemoveTag,
  onStatusChanged,
  onPriorityChanged,
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
  onMerged: () => void;
  collapsed: Set<string>;
  onToggleCollapsed: (label: string) => void;
  allTags: string[];
  onAddTag: (itemId: string, tag: string) => void;
  onRemoveTag: (itemId: string, tag: string) => void;
  onStatusChanged: (issueIdentifier: string, newStatus: string) => void;
  onPriorityChanged: (issueIdentifier: string, newPriority: number) => void;
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
            <span className="flex items-center gap-1.5 px-2"><ServiceHeader icon={null} label="Links" error={errors.find(e => e.startsWith("cursor:"))?.slice(8) ?? null} /></span>
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

          // A ticket with more than one PR expands into a parent (ticket) row
          // plus one indented child row per PR, drawn as the stack the PRs form.
          if (item.prs.length > 1) {
            const forest = buildPrForest(item.prs);
            const isClosed = isItemClosed(item);
            // Keep child connectors aligned under the ticket's own stack indent
            // when this item is itself nested in a cross-item stack view.
            const childPrefixLines: boolean[] =
              stackMeta && stackMeta.depth > 0
                ? [...stackMeta.parentLines, !stackMeta.isLast]
                : [];
            return (
              <React.Fragment key={item.id}>
                <tr
                  className={tableRowClassNoBorder}
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
                          <TreeConnector lines={stackMeta.parentLines} isLast={stackMeta.isLast} />
                        )}
                        <a
                          href={item.linear?.url ?? item.prs[0]?.url ?? "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`text-sm text-text-primary hover:underline transition-colors line-clamp-1 ${isClosed ? "line-through opacity-50" : ""}`}
                        >
                          {item.title}
                        </a>
                      </>
                    </BlockerTags>
                  </td>
                  <td className="py-1.5 px-0 text-center w-[24px]">
                    {item.linear && (
                      <LinearPriorityDropdown
                        issue={item.linear}
                        onPriorityChanged={(newPriority) => onPriorityChanged(item.linear!.identifier, newPriority)}
                      />
                    )}
                  </td>
                  <td className="py-1.5 px-1 whitespace-nowrap">
                    {item.linear ? (
                      <LinearStatusDropdown
                        issue={item.linear}
                        onStatusChanged={(newStatus) => onStatusChanged(item.linear!.identifier, newStatus)}
                      />
                    ) : (
                      <EmptyServiceCell><SiLinear className="w-3.5 h-3.5 text-text-muted" /></EmptyServiceCell>
                    )}
                  </td>
                  <td className="py-1.5 px-1 whitespace-nowrap">
                    <span className="text-xs text-text-muted px-2">{item.prs.length} PRs</span>
                  </td>
                  <td className="py-1.5 px-1 whitespace-nowrap" />
                  <td className="py-1.5 px-1 whitespace-nowrap" />
                </tr>
                {forest.map((node, idx) => {
                  const pr = node.pr;
                  const agent = item.agents.find(a => a.prUrl === pr.url);
                  const prClosed = pr.merged || pr.closed;
                  return (
                    <tr key={`${item.id}:pr:${pr.id}`} className={idx === forest.length - 1 ? tableRowClass : tableRowClassNoBorder}>
                      <td className="py-1.5 px-0 w-[44px]" />
                      <td className="py-1.5 px-2 text-right">
                        {(() => {
                          const { text, color } = timeAgo(pr.updatedAt);
                          return <span className={`text-xs ${color}`} title={new Date(pr.updatedAt).toLocaleString()}>{text}</span>;
                        })()}
                      </td>
                      <td className="py-1.5 px-2">
                        <span className="flex items-center min-w-0">
                          <TreeConnector lines={[...childPrefixLines, ...node.parentLines]} isLast={node.isLast} />
                          <a
                            href={pr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`text-sm text-text-primary hover:underline transition-colors line-clamp-1 ${prClosed ? "line-through opacity-50" : ""}`}
                            title={pr.title}
                          >
                            {pr.title}
                          </a>
                        </span>
                      </td>
                      <td className="py-1.5 px-0 text-center w-[24px]" />
                      <td className="py-1.5 pl-1 pr-0 whitespace-nowrap" />
                      <td className="py-1.5 pl-0 pr-1 whitespace-nowrap">
                        <PrCellLink pr={pr} onMerged={onMerged} />
                      </td>
                      <td className="py-1.5 px-1 whitespace-nowrap align-middle">
                        <LinksCell
                          claudeUrl={pr.claudeSessionUrl}
                          slackUrl={pr.slackThreadUrl}
                          agent={agent}
                          createPr={pr}
                          linear={item.linear}
                          title={item.title}
                          onAgentCreated={onAgentCreated}
                        />
                      </td>
                      <td className="py-1.5 px-1 whitespace-nowrap">
                        <ChangesSummary
                          files={pr.changedFiles}
                          additions={pr.additions}
                          deletions={pr.deletions}
                          url={`${pr.url}/files`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          }

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
                      <TreeConnector lines={stackMeta.parentLines} isLast={stackMeta.isLast} />
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
                {item.linear && (
                  <LinearPriorityDropdown
                    issue={item.linear}
                    onPriorityChanged={(newPriority) => onPriorityChanged(item.linear!.identifier, newPriority)}
                  />
                )}
              </td>
              <td className="py-1.5 pl-1 pr-0 whitespace-nowrap">
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
              <td className="py-1.5 pl-0 pr-1 whitespace-nowrap">
                {item.prs.length > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {item.prs.map(pr => (
                      <PrCellLink key={pr.id} pr={pr} onMerged={onMerged} />
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
              <td className="py-1.5 px-1 whitespace-nowrap align-middle">
                <WorkItemLinksCell item={item} onAgentCreated={onAgentCreated} />
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
  if (statusType === "completed" || statusType === "canceled" || statusType === "duplicate") return true;
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

interface PrTreeNode {
  pr: GitHubPR;
  depth: number;
  isLast: boolean;
  parentLines: boolean[];
}

// Order an item's PRs into the stack forest they form (base→head) so a ticket
// with multiple stacked PRs renders each PR as an indented child row. A PR is a
// child of another PR in the same item when its base branch is that PR's head
// branch; roots are everything else (based on main, or on an external branch).
// A trailing pass emits any PR not reached, guarding against branch cycles.
function buildPrForest(prs: GitHubPR[]): PrTreeNode[] {
  const branchToPr = new Map<string, GitHubPR>();
  for (const pr of prs) {
    if (pr.branch) branchToPr.set(pr.branch, pr);
  }
  const childrenMap = new Map<string, GitHubPR[]>();
  const hasParent = new Set<number>();
  for (const pr of prs) {
    if (pr.baseBranch && pr.baseBranch !== pr.branch && branchToPr.has(pr.baseBranch)) {
      const list = childrenMap.get(pr.baseBranch) ?? [];
      list.push(pr);
      childrenMap.set(pr.baseBranch, list);
      hasParent.add(pr.id);
    }
  }

  const result: PrTreeNode[] = [];
  const visited = new Set<number>();
  const walk = (pr: GitHubPR, depth: number, parentLines: boolean[], isLast: boolean) => {
    if (visited.has(pr.id)) return;
    visited.add(pr.id);
    result.push({ pr, depth, isLast, parentLines: [...parentLines] });
    const children = pr.branch ? childrenMap.get(pr.branch) ?? [] : [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], depth + 1, [...parentLines, !isLast], i === children.length - 1);
    }
  };

  const roots = prs.filter(pr => !hasParent.has(pr.id));
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], 0, [], i === roots.length - 1);
  }
  for (const pr of prs) {
    if (!visited.has(pr.id)) result.push({ pr, depth: 0, isLast: true, parentLines: [] });
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

type RateLimitMap = { cost?: number; remaining: number; limit: number; resetAt: string };

interface WorkItemsResponse {
  items?: WorkItem[];
  reviewItems?: ReviewItem[];
  viewerLogin?: string;
  allTags?: string[];
  rateLimits?: { github?: RateLimitMap; githubSearch?: RateLimitMap; linear?: RateLimitMap };
  stats?: ApiStatRow[];
  recent?: ApiCallRecord[];
  errors?: string[];
  progress?: { step: number; totalSteps: number };
  done?: boolean;
}

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
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const fetchingRef = useRef(false);
  const lastFetchRef = useRef(0);

  const applyChunk = useCallback((json: WorkItemsResponse) => {
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
    const start = Date.now();
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
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setLastDurationMs(Date.now() - start);
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [intervalMs, applyChunk]);

  const refresh = useCallback(() => doFetch(true), [doFetch]);

  useEffect(() => {
    registerServiceWorker();
    // If arriving with ?fresh=1 (e.g. after saving settings), force a bypass
    const isFresh = new URLSearchParams(window.location.search).get("fresh") === "1";
    // doFetch flips loading state synchronously; the one extra render on mount
    // is the right tradeoff for a "fetch on load" hook here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const updateItemPriority = useCallback((issueIdentifier: string, newPriority: number) => {
    setItems(prev => prev.map(item =>
      item.linear?.identifier === issueIdentifier
        ? { ...item, linear: { ...item.linear!, priority: newPriority } }
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

  return { items, reviewItems, viewerLogin, allTags, rateLimits, stats, recent, errors, loading, progress, lastUpdated, lastDurationMs, refresh, updateItemStatus, updateItemPriority, addTag, removeTag };
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
  // Notification.permission is only knowable in the browser, so the server has
  // to guess — branching on it during render makes the server and first client
  // render disagree and trips hydration. Start as null (renders nothing, which
  // is what the server emits) and read the real permission after hydration.
  const [permission, setPermission] = useState<NotificationPermission | "unsupported" | null>(null);
  const { toast } = useToast();

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPermission(getPermissionState()); }, []);

  // Don't render until permission is known, or if already granted/unsupported.
  if (permission === null || permission === "granted" || permission === "unsupported") return null;

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
    item.linear?.url ?? "",
    ...item.prs.flatMap(pr => [pr.title, pr.author, pr.authorLogin, pr.repo, pr.branch, `#${getPrNumber(pr.url)}`, pr.url]),
    ...item.agents.flatMap(a => [a.name, a.repo, a.branch, a.status, a.url]),
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
    `#${getPrNumber(r.pr.url)}`,
    r.pr.url,
    r.linear?.title ?? "",
    r.linear?.identifier ?? "",
    r.linear?.url ?? "",
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
    item.linear?.url ?? "",
    ...item.prs.flatMap((pr) => [pr.title, pr.repo, pr.branch, `#${getPrNumber(pr.url)}`, pr.url]),
    ...item.agents.flatMap((a) => [a.name, a.repo, a.branch, a.url]),
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

  const applyChunk = useCallback((json: { items?: WorkItem[]; errors?: string[]; done?: boolean }) => {
    if (Array.isArray(json.items)) setItems(json.items);
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      setError(json.errors.join("; "));
    }
    if (json.done) setLoaded(true);
  }, []);

  const doFetch = useCallback(async (bypassCache: boolean) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const url = bypassCache ? "/api/completed-issues?fresh=1" : "/api/completed-issues";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.body) {
        const json = await res.json();
        applyChunk({ ...json, done: true });
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
        if (buffer.trim()) {
          try {
            applyChunk(JSON.parse(buffer));
          } catch {}
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [applyChunk]);

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
              <span className="text-xs font-medium text-text-secondary">Links</span>
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
            const issue = item.linear;
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
                    href={item.prs[0]?.url ?? issue?.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-text-primary hover:underline transition-colors line-clamp-1"
                  >
                    {item.title}
                  </a>
                </td>
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {issue ? (
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
                  ) : (
                    <EmptyServiceCell><SiLinear className="w-3.5 h-3.5 text-text-muted" /></EmptyServiceCell>
                  )}
                </td>
                <td className="py-1.5 px-1 whitespace-nowrap">
                  {item.prs.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {item.prs.map((pr) => (
                        <PrCellLink key={pr.id} pr={pr} />
                      ))}
                    </div>
                  ) : issue?.prUrls[0] ? (
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
                  <WorkItemLinksCell item={item} />
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
  const { items: allUnfilteredItems, reviewItems, allTags, rateLimits: rateLimitInfos, stats, recent, errors: serviceErrors, loading: anyLoading, progress, lastUpdated, lastDurationMs, refresh: refreshAll, updateItemStatus, updateItemPriority, addTag: rawAddTag, removeTag: rawRemoveTag } = useWorkItems();
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

  // Toast for priority changes
  const handlePriorityChanged = useCallback((issueIdentifier: string, newPriority: number) => {
    updateItemPriority(issueIdentifier, newPriority);
    toast("success", `${issueIdentifier} → ${priorityConfig[newPriority]?.name ?? "Unknown priority"}`);
  }, [updateItemPriority, toast]);

  // Toast for agent creation
  const handleAgentCreated = useCallback(() => {
    toast("success", "Cursor agent created");
    refreshAll();
  }, [toast, refreshAll]);

  // A `/trunk merge` comment was posted; the button toasts, so just re-sync
  // (with a short delay so GitHub has registered the comment / queue state).
  const handleMerged = useCallback(() => {
    setTimeout(refreshAll, 2000);
  }, [refreshAll]);

  // Tick every 15s to keep "updated X ago" fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const [isElectron] = useState(
    () => typeof navigator !== "undefined" && navigator.userAgent.includes("Electron"),
  );
  const titlebarHeight = isElectron ? 38 : 0;
  const headerRef = useRef<HTMLElement>(null);

  const searchParams = useSearchParams();


  type Tab = "tasks" | "review" | "completed";
  type SortMode = "stage" | "priority" | "stack" | "date";
  // Initial state seeded from URL search params (including the legacy "view"
  // alias); subsequent updates flow through setParam, which writes back.
  const [tab, setTabState] = useState<Tab>(() => {
    const t = searchParams.get("tab");
    if (t === "tasks" || t === "review" || t === "completed") return t;
    if (searchParams.get("view") === "review") return "review";
    return "tasks";
  });
  const [sort, setSortState] = useState<SortMode>(() => {
    const s = searchParams.get("sort");
    if (s === "stage" || s === "priority" || s === "stack" || s === "date") return s;
    const legacy = searchParams.get("view");
    if (legacy === "stage" || legacy === "priority" || legacy === "date") return legacy;
    return "stage";
  });
  const [repoFilter, setRepoFilterState] = useState(() => searchParams.get("repo") ?? "descript");
  const [serviceFilter, setServiceFilterState] = useState<Set<string>>(() => {
    const svc = searchParams.get("svc");
    if (!svc) return new Set<string>();
    return new Set(svc.split(",").filter((v) => ALL_SERVICES.has(v)));
  });
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+F hijacks the browser's find: focus our search box and
      // select any existing text. Capture phase + stopImmediatePropagation
      // so we beat any other handler racing for the same shortcut.
      const isFindKey = (e.code === "KeyF" || e.key.toLowerCase() === "f");
      if (isFindKey && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const el = searchInputRef.current;
        if (el) { el.focus(); el.select(); }
        return;
      }
      // Plain "f" focuses search, but only when not typing in another field.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isFindKey) {
        e.preventDefault();
        const el = searchInputRef.current;
        if (el) { el.focus(); el.select(); }
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // (URL → state sync happens via the useState initializers above.)

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

  const open = useMemo(
    () => visibleItems.filter((item) => !isItemClosed(item)),
    [visibleItems],
  );

  // Counts ignoring search, used to render fractions like "3/5" in the tab labels.
  const openTotalUnfiltered = useMemo(
    () => allItems.filter(i => !archived.has(i.id) && !isItemClosed(i)).length,
    [allItems, archived],
  );
  const reviewTotalUnfiltered = useMemo(() => {
    let items = reviewItems;
    if (repoFilter !== "all") {
      const repoSuffix = `/${repoFilter}`;
      items = items.filter(item => item.pr.repo.endsWith(repoSuffix) || item.pr.repo === repoFilter);
    }
    return items.length;
  }, [reviewItems, repoFilter]);
  const isSearching = searchTerms.length > 0;

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

  // Publish the page header's height so the sticky table/section headers can
  // sit flush beneath it (see theadClass / sectionHeaderClass). The header
  // height changes with the summary line / window width, so track it live.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () =>
      document.documentElement.style.setProperty("--work-header-h", `${el.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  return (
    <div className="w-full px-4 py-4" style={{ "--titlebar-height": `${titlebarHeight}px` } as React.CSSProperties}>
      {isElectron && <div className="h-[38px] -mx-4 -mt-4 sticky top-0 z-30 bg-background" data-drag-region />}
      <header ref={headerRef} className="sticky top-[var(--titlebar-height,0px)] z-20 bg-background pt-1 pb-1">
        <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-text-primary">Dashboard</h1>
        <ToggleGroup
          options={[
            { value: "tasks" as const, label: `My tasks${formatTabCount(open.length, openTotalUnfiltered, isSearching)}`, hotkey: "m" },
            { value: "review" as const, label: `Requested reviews${formatTabCount(filteredReviewItems.length, reviewTotalUnfiltered, isSearching)}`, hotkey: "r" },
          ]}
          value={isReview ? "review" as const : "tasks" as const}
          onChange={(v) => setTab(v as Tab)}
        />
        <button
          onClick={() => {
            refreshAll();
            if (isCompleted) completed.refresh();
          }}
          disabled={anyLoading || (isCompleted && completed.loading)}
          className={`${iconButtonClass} disabled:opacity-50`}
          title="Refresh all"
          aria-label="Refresh all"
        >
          <RefreshIcon className={`w-4 h-4 ${anyLoading || (isCompleted && completed.loading) ? "animate-spin" : ""}`} />
        </button>
        <span className="text-[11px] text-text-tertiary tabular-nums" suppressHydrationWarning>
          {progress ? `${progress.step}/${progress.totalSteps}` : lastUpdated ? timeAgo(new Date(lastUpdated).toISOString()).text : ""}
          {!progress && lastDurationMs != null && (
            <span className="text-text-muted" title="Time the last refresh took">
              {" ("}
              {lastDurationMs >= 1000 ? `${(lastDurationMs / 1000).toFixed(1)}s` : `${lastDurationMs}ms`}
              {")"}
            </span>
          )}
        </span>
        {rateLimitInfos.length > 0 && (
          <ApiStatsPopover rateLimits={rateLimitInfos} stats={stats} recent={recent} />
        )}
        <div className="flex-1" />
        <div className="relative w-36 focus-within:w-56 transition-all">
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
            className={`text-xs px-2 py-1 border border-border rounded bg-background text-text-primary placeholder:text-text-tertiary w-full focus:outline-none focus:border-text-tertiary transition-colors ${search ? "pr-6" : ""}`}
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                searchInputRef.current?.focus();
              }}
              aria-label="Clear filter"
              className="absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </div>
        {!isReview && !isCompleted && <ServiceFilter value={serviceFilter} onToggle={toggleServiceFilter} />}
        {!isReview && (
          <ToggleGroup
            options={[
              { value: "stage", label: "Status", hotkey: "s" },
              { value: "priority", label: "Priority", hotkey: "p" },
              { value: "stack", label: "Stack", hotkey: "k" },
              { value: "date", label: "All", hotkey: "a" },
              { value: "completed", label: "Completed", hotkey: "c" },
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
          {filteredReviewItems.length === 0 && !anyLoading && search.trim() && (
            <NoSearchMatches search={search} onClear={() => setSearch("")} />
          )}
          {filteredReviewItems.length === 0 && !anyLoading && !search.trim() && (
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
          {!completed.error && completedTotal === 0 && !completed.loading && completed.loaded && search.trim() && (
            <NoSearchMatches search={search} onClear={() => setSearch("")} />
          )}
          {!completed.error && completedTotal === 0 && !completed.loading && completed.loaded && !search.trim() && (
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
            onMerged={handleMerged}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            allTags={allTags}
            onAddTag={addTag}
            onRemoveTag={removeTag}
            onStatusChanged={handleStatusChanged}
            onPriorityChanged={handlePriorityChanged}
            archived={archived}
            onToggleArchive={toggleArchive}
            highlightedId={highlightedId}
          />
          {displayItems.length === 0 && !anyLoading && search.trim() && (
            <NoSearchMatches search={search} onClear={() => setSearch("")} />
          )}
          {displayItems.length === 0 && !anyLoading && !search.trim() && (
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

      {(() => {
        const visibleCount = isReview
          ? filteredReviewItems.length
          : isCompleted
            ? completedTotal
            : displayItems.length;
        if (search.trim() && visibleCount > 0) {
          return (
            <div className="text-center py-4 text-xs text-text-tertiary">
              Filtering by <span className="text-text-secondary">&ldquo;{search}&rdquo;</span>
              {" · "}
              <button
                onClick={() => setSearch("")}
                className="text-text-secondary hover:text-text-primary hover:underline transition-colors"
              >
                Clear search
              </button>
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
}

function formatTabCount(matched: number, total: number, isSearching: boolean): string {
  if (isSearching) return ` (${matched}/${total})`;
  return total > 0 ? ` (${total})` : "";
}

function NoSearchMatches({ search, onClear }: { search: string; onClear: () => void }) {
  return (
    <div className="text-center py-16 space-y-3">
      <p className="text-sm text-text-secondary">
        No matches for <span className="text-text-primary">&ldquo;{search}&rdquo;</span>
      </p>
      <button
        onClick={onClear}
        className="text-xs text-text-tertiary hover:text-text-secondary hover:underline transition-colors"
      >
        Clear search
      </button>
    </div>
  );
}
