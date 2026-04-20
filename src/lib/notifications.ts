"use client";

import type { ReviewItem, WorkItem } from "@/types";

const seenReviewIds = new Set<string>();
// Track PR review decisions by PR URL to detect changes
const knownPrDecisions = new Map<string, string | null>();
let initialized = false;

export function registerServiceWorker(): void {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

export function getPermissionState(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  const result = await Notification.requestPermission();
  return result;
}

async function fetchNotificationPrefs(): Promise<{ enabled: boolean; reviewRequests: boolean; prReviews: boolean }> {
  try {
    const res = await fetch("/api/settings");
    const json = await res.json();
    return {
      enabled: json.notifications?.enabled !== false,
      reviewRequests: json.notifications?.reviewRequests !== false,
      prReviews: json.notifications?.prReviews !== false,
    };
  } catch {
    return { enabled: true, reviewRequests: true, prReviews: true };
  }
}

export function initSeenReviews(reviews: ReviewItem[]): void {
  for (const r of reviews) seenReviewIds.add(r.id);
  initialized = true;
}

export async function notifyNewReviews(reviews: ReviewItem[]): Promise<void> {
  if (!initialized) {
    initSeenReviews(reviews);
    return;
  }

  if (getPermissionState() !== "granted") {
    for (const r of reviews) seenReviewIds.add(r.id);
    return;
  }

  // Skip if window is focused (matches Electron behavior)
  if (document.hasFocus()) {
    for (const r of reviews) seenReviewIds.add(r.id);
    return;
  }

  const prefs = await fetchNotificationPrefs();
  if (!prefs.enabled || !prefs.reviewRequests) {
    for (const r of reviews) seenReviewIds.add(r.id);
    return;
  }

  const newReviews = reviews.filter((r) => !seenReviewIds.has(r.id));
  for (const r of newReviews) seenReviewIds.add(r.id);
  if (newReviews.length === 0) return;

  if (newReviews.length === 1) {
    const r = newReviews[0];
    const prefix = r.linear?.identifier ? `${r.linear.identifier}: ` : "";
    const author =
      r.pr.author !== r.pr.authorLogin
        ? r.pr.author
        : `@${r.pr.authorLogin}`;
    showNotification("New review request", `${prefix}${r.pr.title} — ${author}`);
  } else {
    showNotification(
      `${newReviews.length} new review requests`,
      newReviews
        .slice(0, 3)
        .map((r) => r.pr.title)
        .join(", ") +
        (newReviews.length > 3 ? ` +${newReviews.length - 3} more` : ""),
    );
  }
}

export async function notifyPrReviewChanges(items: WorkItem[]): Promise<void> {
  // Collect all open PRs with their review decisions
  const currentPrs = new Map<string, { decision: string | null; title: string; identifier?: string }>();
  for (const item of items) {
    for (const pr of item.prs) {
      if (pr.merged || pr.closed) continue;
      currentPrs.set(pr.url, {
        decision: pr.reviewDecision,
        title: pr.title,
        identifier: item.linear?.identifier,
      });
    }
  }

  if (!initialized) {
    // Seed on first load
    for (const [url, { decision }] of currentPrs) {
      knownPrDecisions.set(url, decision);
    }
    return;
  }

  if (getPermissionState() !== "granted" || document.hasFocus()) {
    for (const [url, { decision }] of currentPrs) {
      knownPrDecisions.set(url, decision);
    }
    return;
  }

  const prefs = await fetchNotificationPrefs();
  if (!prefs.enabled || !prefs.prReviews) {
    for (const [url, { decision }] of currentPrs) {
      knownPrDecisions.set(url, decision);
    }
    return;
  }

  for (const [url, { decision, title, identifier }] of currentPrs) {
    const prev = knownPrDecisions.get(url);
    knownPrDecisions.set(url, decision);

    // Only notify on transitions to APPROVED or CHANGES_REQUESTED
    if (prev === decision) continue;
    if (prev === undefined) continue; // new PR, not a status change

    const prefix = identifier ? `${identifier}: ` : "";
    if (decision === "APPROVED") {
      showNotification("PR approved", `${prefix}${title}`);
    } else if (decision === "CHANGES_REQUESTED") {
      showNotification("Changes requested", `${prefix}${title}`);
    }
  }
}

function showNotification(title: string, body: string): void {
  const notif = new Notification(title, {
    body,
    icon: "/icon-192.png",
  });
  notif.onclick = () => {
    window.focus();
    notif.close();
  };
}
