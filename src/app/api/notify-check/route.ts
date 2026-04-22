import { NextResponse } from "next/server";
import { sync } from "@/lib/sync";
import { getWorkItems, getReviewItems, getSyncStatus } from "@/lib/db";
import { getCached, setCache, logApiCall } from "@/lib/cache";
import { checkGitHubNotificationSignal } from "@/lib/github";
import { getEnv } from "@/lib/env";

// Lightweight endpoint driven by the client's fast notification poll.
// Uses GitHub's /notifications endpoint with If-Modified-Since as a cheap
// gate: a 304 response means nothing changed, so we skip the sync() and
// return cached data. That lets us poll frequently without burning quota.
const SIGNAL_CACHE_KEY = "github:notifications:lastModified";
const SIGNAL_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // persist across restarts

export async function GET() {
  let viewerLogin = "";
  const ghStatus = getSyncStatus("github_reviews");
  if (ghStatus?.meta && typeof ghStatus.meta === "object" && "viewerLogin" in ghStatus.meta) {
    viewerLogin = ghStatus.meta.viewerLogin as string;
  }

  // Prefer a dedicated classic PAT for /notifications (fine-grained PATs can't
  // access that endpoint). Fall back to the main token for users who already
  // use a classic PAT for everything.
  const token = getEnv("GITHUB_NOTIFICATIONS_TOKEN") ?? getEnv("GITHUB_TOKEN");
  let shouldSync = true;
  let pollInterval = 60;
  let signalStatus: "modified" | "unchanged" | "unavailable" = "unavailable";

  if (token) {
    const lastModified = getCached<string>(SIGNAL_CACHE_KEY) ?? undefined;
    const start = Date.now();
    const signal = await checkGitHubNotificationSignal(token, lastModified);
    if (signal) {
      pollInterval = signal.pollInterval;
      if (signal.modified) {
        signalStatus = "modified";
        setCache(SIGNAL_CACHE_KEY, signal.lastModified, SIGNAL_CACHE_TTL);
        logApiCall("github", "notifications", "ok", Date.now() - start);
      } else {
        signalStatus = "unchanged";
        shouldSync = false;
        logApiCall("github", "notifications", "cached", Date.now() - start);
      }
    }
  }

  const errors: string[] = [];
  if (shouldSync) {
    const result = await sync({ force: false });
    if (result.viewerLogin) viewerLogin = result.viewerLogin;
    errors.push(...result.errors);
  }

  return NextResponse.json({
    viewerLogin,
    items: getWorkItems(),
    reviewItems: getReviewItems(),
    pollInterval,
    signal: signalStatus,
    errors,
  });
}
