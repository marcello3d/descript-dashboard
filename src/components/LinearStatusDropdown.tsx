"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { StatusIcon } from "./LinearStatus";
import type { LinearIssue } from "@/types";

interface WorkflowState {
  id: string;
  name: string;
  color: string;
  type: string;
}

// Type ordering for display grouping
const TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

export default function LinearStatusDropdown({
  issue,
  onStatusChanged,
}: {
  issue: LinearIssue;
  onStatusChanged?: (newStatus: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [states, setStates] = useState<WorkflowState[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchStates = useCallback(async () => {
    if (states) return; // already fetched
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/linear/states?issueId=${issue.identifier}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch states");
      setStates(data.states);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [issue.identifier, states]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        setOpen(true);
        fetchStates();
      } else {
        setOpen(false);
      }
    },
    [open, fetchStates]
  );

  const handleSelect = useCallback(
    async (state: WorkflowState) => {
      if (state.name === issue.status) {
        setOpen(false);
        return;
      }
      setUpdating(true);
      setError(null);
      try {
        const res = await fetch("/api/linear/update-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId: issue.identifier, stateId: state.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to update status");
        onStatusChanged?.(data.statusName);
        setOpen(false);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setUpdating(false);
      }
    },
    [issue.identifier, issue.status, onStatusChanged]
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const sortedStates = states
    ? [...states].sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99))
    : null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleToggle}
        className={`flex items-center gap-1.5 py-1.5 px-2 -my-1 rounded hover:bg-fill-muted transition-colors ${updating ? "opacity-50 pointer-events-none" : ""}`}
        title={`${issue.status} — click to change`}
      >
        <StatusIcon status={issue.status} />
        <span className="text-xs text-text-tertiary font-mono">{issue.identifier}</span>
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 min-w-[180px] bg-surface border border-border rounded-lg shadow-lg py-1 max-h-[300px] overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-xs text-text-tertiary">Loading…</div>
          )}
          {error && (
            <div className="px-3 py-2 text-xs text-status-red">{error}</div>
          )}
          {sortedStates?.map((state) => {
            const isActive = state.name === issue.status;
            return (
              <button
                key={state.id}
                onClick={() => handleSelect(state)}
                disabled={updating}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-fill-muted transition-colors ${isActive ? "bg-fill-muted font-medium" : ""}`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: state.color }}
                />
                <span className="text-text-primary">{state.name}</span>
                {isActive && <span className="ml-auto text-text-tertiary">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
