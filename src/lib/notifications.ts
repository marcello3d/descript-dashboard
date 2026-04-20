"use client";

import type { ReviewItem } from "@/types";

const seenReviewIds = new Set<string>();
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

async function fetchNotificationPrefs(): Promise<{ reviewRequests: boolean }> {
  try {
    const res = await fetch("/api/settings");
    const json = await res.json();
    return { reviewRequests: json.notifications?.reviewRequests !== false };
  } catch {
    return { reviewRequests: true };
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
  if (!prefs.reviewRequests) {
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
