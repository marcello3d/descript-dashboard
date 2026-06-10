"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { errorMessage } from "@/lib/errors";
import type { LinearIssue } from "@/types";

// Linear priorities are fixed: 0 = No priority, 1 = Urgent … 4 = Low
export const priorityConfig: Record<number, { label: string; name: string; color: string }> = {
  0: { label: "P-", name: "No priority", color: "text-text-muted" },
  1: { label: "P0", name: "Urgent", color: "text-status-red" },
  2: { label: "P1", name: "High", color: "text-status-orange" },
  3: { label: "P2", name: "Medium", color: "text-text-tertiary" },
  4: { label: "P3", name: "Low", color: "text-text-muted" },
};

const PRIORITIES = [0, 1, 2, 3, 4];

export default function LinearPriorityDropdown({
  issue,
  onPriorityChanged,
}: {
  issue: LinearIssue;
  onPriorityChanged?: (newPriority: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  const handleSelect = useCallback(
    async (priority: number) => {
      if (priority === issue.priority) {
        setOpen(false);
        return;
      }
      setUpdating(true);
      try {
        const res = await fetch("/api/linear/update-priority", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId: issue.identifier, priority }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to update priority");
        onPriorityChanged?.(data.priority);
        setOpen(false);
      } catch (e) {
        toast("error", errorMessage(e));
      } finally {
        setUpdating(false);
      }
    },
    [issue.identifier, issue.priority, onPriorityChanged, toast]
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

  const current = priorityConfig[issue.priority] ?? priorityConfig[0];

  return (
    <div
      className={`relative inline-flex ${updating ? "opacity-50 pointer-events-none" : ""}`}
      ref={dropdownRef}
    >
      <button
        onClick={handleToggle}
        className={`py-1.5 px-1.5 -my-1 rounded hover:bg-fill-muted transition-colors text-[10px] leading-none font-mono font-medium ${current.color}`}
        title={`Priority: ${current.name} — click to change`}
        aria-label="Change Linear priority"
      >
        {current.label}
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 min-w-[150px] bg-surface border border-border rounded-lg shadow-lg py-1">
          {PRIORITIES.map((priority) => {
            const config = priorityConfig[priority];
            const isActive = priority === issue.priority;
            return (
              <button
                key={priority}
                onClick={() => handleSelect(priority)}
                disabled={updating}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs whitespace-nowrap hover:bg-fill-muted transition-colors ${isActive ? "bg-fill-muted font-medium" : ""}`}
              >
                <span className={`w-5 flex-shrink-0 font-mono font-medium ${config.color}`}>
                  {config.label}
                </span>
                <span className="text-text-primary">{config.name}</span>
                {isActive && <span className="ml-auto text-text-tertiary">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
