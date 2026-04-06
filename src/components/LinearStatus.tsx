"use client";

// Linear-style status icons matching their UI
function StatusIcon({ status }: { status: string }) {
  const s = status.toLowerCase();

  if (s === "backlog" || s === "triage") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#bbb" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
      </svg>
    );
  }
  if (s === "todo" || s === "unstarted") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#bbb" strokeWidth="1.5" />
      </svg>
    );
  }
  if (s === "in progress" || s === "started") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#f59e0b" strokeWidth="1.5" />
        <path d="M7 1a6 6 0 010 12V1z" fill="#f59e0b" />
      </svg>
    );
  }
  if (s === "in review" || s === "pr" || s === "review") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#3b82f6" strokeWidth="1.5" />
        <path d="M7 1a6 6 0 110 12V1z" fill="#3b82f6" />
        <path d="M7 1A6 6 0 007 7V1z" fill="white" />
      </svg>
    );
  }
  if (s === "done" || s === "completed" || s === "verify") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="7" fill="#5e6ad2" />
        <path d="M4.5 7.5l1.75 1.75 3.25-3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (s === "on hold" || s === "paused" || s === "blocked") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#9ca3af" strokeWidth="1.5" />
        <rect x="5" y="4.5" width="1.5" height="5" rx="0.5" fill="#9ca3af" />
        <rect x="7.5" y="4.5" width="1.5" height="5" rx="0.5" fill="#9ca3af" />
      </svg>
    );
  }
  if (s === "cancelled" || s === "canceled") {
    return (
      <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#9ca3af" strokeWidth="1.5" />
        <path d="M5 5l4 4M9 5l-4 4" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="#bbb" strokeWidth="1.5" />
    </svg>
  );
}

export default function LinearStatus({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1" title={status}>
      <StatusIcon status={status} />
      <span className="text-xs text-gray-500">{status}</span>
    </span>
  );
}
