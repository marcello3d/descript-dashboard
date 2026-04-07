"use client";

// Linear-style status icons matching their actual UI colors
export function StatusIcon({ status }: { status: string }) {
  const s = status.toLowerCase();

  // Triage — orange filled circle with left-right arrow
  if (s === "triage") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="3.5" stroke="#e8590c" strokeWidth="7" strokeDasharray="2 0" strokeDashoffset="3.2" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#e8590c" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="12.189" transform="rotate(-90 7 7)" />
        <path stroke="none" className="fill-white dark:fill-black" d="M8.0126 7.98223V9.50781C8.0126 9.92901 8.52329 10.1548 8.85102 9.87854L11.8258 7.37066C12.0581 7.17486 12.0581 6.82507 11.8258 6.62927L8.85102 4.12139C8.52329 3.84509 8.0126 4.07092 8.0126 4.49212V6.01763H5.98739V4.49218C5.98739 4.07098 5.4767 3.84515 5.14897 4.12146L2.17419 6.62933C1.94194 6.82513 1.94194 7.17492 2.17419 7.37072L5.14897 9.8786C5.4767 10.1549 5.98739 9.92907 5.98739 9.50787V7.98223H8.0126Z" />
      </svg>
    );
  }

  // Backlog — gray dotted circle
  if (s === "backlog") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#e2e2e2" strokeWidth="1.5" strokeDasharray="1.4 1.74" strokeDashoffset="0.65" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#e2e2e2" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="12.189" transform="rotate(-90 7 7)" />
      </svg>
    );
  }

  // Upcoming — orange dotted circle
  if (s === "upcoming") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#f2b661" strokeWidth="1.5" strokeDasharray="1.4 1.74" strokeDashoffset="0.65" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#f2b661" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="12.189" transform="rotate(-90 7 7)" />
      </svg>
    );
  }

  // Todo — orange empty circle
  if (s === "todo" || s === "unstarted") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#f2b661" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#f2b661" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="12.189" transform="rotate(-90 7 7)" />
      </svg>
    );
  }

  // In Progress — green circle with quarter pie
  if (s === "in progress" || s === "started") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#4cb782" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#4cb782" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="9.142" transform="rotate(-90 7 7)" />
      </svg>
    );
  }

  // PR — teal circle with half pie
  if (s === "in review" || s === "pr" || s === "review") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#0f7488" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#0f7488" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="6.095" transform="rotate(-90 7 7)" />
      </svg>
    );
  }


  // Verify — indigo circle with 3/4 pie
  if (s === "verify") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#5E6AD2" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="2" fill="none" stroke="#5E6AD2" strokeWidth="4" strokeDasharray="12.189 24.379" strokeDashoffset="3.047" transform="rotate(-90 7 7)" />
      </svg>
    );
  }

  // Done — gray filled circle with checkmark
  if (s === "done" || s === "completed") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#95a2b3" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="3" fill="none" stroke="#95a2b3" strokeWidth="6" strokeDasharray="18.85 37.7" strokeDashoffset="0" transform="rotate(-90 7 7)" />
        <path stroke="none" className="fill-white dark:fill-black" d="M10.951 4.24896C11.283 4.58091 11.283 5.11909 10.951 5.45104L5.95104 10.451C5.61909 10.783 5.0809 10.783 4.74896 10.451L2.74896 8.45104C2.41701 8.11909 2.41701 7.5809 2.74896 7.24896C3.0809 6.91701 3.61909 6.91701 3.95104 7.24896L5.35 8.64792L9.74896 4.24896C10.0809 3.91701 10.6191 3.91701 10.951 4.24896Z" />
      </svg>
    );
  }

  // Monitor — teal filled circle with checkmark
  if (s === "monitor") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="7" fill="#0d9373" />
        <path d="M4.5 7.5l1.75 1.75 3.25-3.5" className="stroke-white dark:stroke-black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // On Hold / Paused / Blocked
  if (s === "on hold" || s === "paused" || s === "blocked") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#9ca3af" strokeWidth="1.5" />
        <rect x="5" y="4.5" width="1.5" height="5" rx="0.5" fill="#9ca3af" />
        <rect x="7.5" y="4.5" width="1.5" height="5" rx="0.5" fill="#9ca3af" />
      </svg>
    );
  }

  // Cancelled — gray filled circle with X
  if (s === "cancelled" || s === "canceled") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#95a2b3" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="3" fill="none" stroke="#95a2b3" strokeWidth="6" strokeDasharray="18.85 37.7" strokeDashoffset="0" transform="rotate(-90 7 7)" />
        <path stroke="none" className="fill-white dark:fill-black" d="M3.73657 3.73657C4.05199 3.42114 4.56339 3.42114 4.87881 3.73657L5.93941 4.79716L7 5.85775L9.12117 3.73657C9.4366 3.42114 9.94801 3.42114 10.2634 3.73657C10.5789 4.05199 10.5789 4.56339 10.2634 4.87881L8.14225 7L10.2634 9.12118C10.5789 9.4366 10.5789 9.94801 10.2634 10.2634C9.94801 10.5789 9.4366 10.5789 9.12117 10.2634L7 8.14225L4.87881 10.2634C4.56339 10.5789 4.05199 10.5789 3.73657 10.2634C3.42114 9.94801 3.42114 9.4366 3.73657 9.12118L4.79716 8.06059L5.85775 7L3.73657 4.87881C3.42114 4.56339 3.42114 4.05199 3.73657 3.73657Z" />
      </svg>
    );
  }

  // Icebox — teal filled circle with X
  if (s === "icebox") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#26b5ce" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="3" fill="none" stroke="#26b5ce" strokeWidth="6" strokeDasharray="18.85 37.7" strokeDashoffset="0" transform="rotate(-90 7 7)" />
        <path stroke="none" className="fill-white dark:fill-black" d="M3.73657 3.73657C4.05199 3.42114 4.56339 3.42114 4.87881 3.73657L5.93941 4.79716L7 5.85775L9.12117 3.73657C9.4366 3.42114 9.94801 3.42114 10.2634 3.73657C10.5789 4.05199 10.5789 4.56339 10.2634 4.87881L8.14225 7L10.2634 9.12118C10.5789 9.4366 10.5789 9.94801 10.2634 10.2634C9.94801 10.5789 9.4366 10.5789 9.12117 10.2634L7 8.14225L4.87881 10.2634C4.56339 10.5789 4.05199 10.5789 3.73657 10.2634C3.42114 9.94801 3.42114 9.4366 3.73657 9.12118L4.79716 8.06059L5.85775 7L3.73657 4.87881C3.42114 4.56339 3.42114 4.05199 3.73657 3.73657Z" />
      </svg>
    );
  }

  // Duplicate — pink filled circle with X
  if (s === "duplicate") {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="#f7c8c1" strokeWidth="1.5" strokeDasharray="3.14 0" strokeDashoffset="-0.7" />
        <circle cx="7" cy="7" r="3" fill="none" stroke="#f7c8c1" strokeWidth="6" strokeDasharray="18.85 37.7" strokeDashoffset="0" transform="rotate(-90 7 7)" />
        <path stroke="none" className="fill-white dark:fill-black" d="M3.73657 3.73657C4.05199 3.42114 4.56339 3.42114 4.87881 3.73657L5.93941 4.79716L7 5.85775L9.12117 3.73657C9.4366 3.42114 9.94801 3.42114 10.2634 3.73657C10.5789 4.05199 10.5789 4.56339 10.2634 4.87881L8.14225 7L10.2634 9.12118C10.5789 9.4366 10.5789 9.94801 10.2634 10.2634C9.94801 10.5789 9.4366 10.5789 9.12117 10.2634L7 8.14225L4.87881 10.2634C4.56339 10.5789 4.05199 10.5789 3.73657 10.2634C3.42114 9.94801 3.42114 9.4366 3.73657 9.12118L4.79716 8.06059L5.85775 7L3.73657 4.87881C3.42114 4.56339 3.42114 4.05199 3.73657 3.73657Z" />
      </svg>
    );
  }

  // Fallback — gray empty circle
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="#bbb" strokeWidth="1.5" />
    </svg>
  );
}

export default function LinearStatus({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1" title={status}>
      <StatusIcon status={status} />
      <span className="text-xs text-text-secondary">{status}</span>
    </span>
  );
}
