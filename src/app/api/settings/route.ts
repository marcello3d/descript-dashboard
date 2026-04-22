import { getConfig, setConfig, maskKey, SECRET_KEYS, type AppConfig } from "@/lib/config";
import { invalidateEnvCache } from "@/lib/env";

function notificationPrefs(config: AppConfig) {
  return {
    enabled: config.notifications?.enabled !== false,
    reviewRequests: config.notifications?.reviewRequests !== false,
    prReviews: config.notifications?.prReviews !== false,
    syncErrors: config.notifications?.syncErrors !== false,
  };
}

function keyStates(config: AppConfig) {
  const keys: Record<string, { set: boolean; masked: string }> = {};
  for (const key of SECRET_KEYS) {
    keys[key] = { set: !!config[key], masked: maskKey(config[key]) };
  }
  return keys;
}

function envOverrides() {
  const overrides: Record<string, boolean> = {};
  for (const key of SECRET_KEYS) {
    overrides[key] = !!process.env[key];
  }
  return overrides;
}

export async function GET() {
  const config = getConfig();
  return Response.json({
    keys: keyStates(config),
    envOverrides: envOverrides(),
    notifications: notificationPrefs(config),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const updates: Partial<AppConfig> = {};
  for (const key of SECRET_KEYS) {
    if (key in body) {
      updates[key] = typeof body[key] === "string" ? body[key] : undefined;
    }
  }
  if (body.notifications && typeof body.notifications === "object") {
    updates.notifications = {};
    if (typeof body.notifications.reviewRequests === "boolean") {
      updates.notifications.reviewRequests = body.notifications.reviewRequests;
    }
    if (typeof body.notifications.enabled === "boolean") {
      updates.notifications.enabled = body.notifications.enabled;
    }
    if (typeof body.notifications.prReviews === "boolean") {
      updates.notifications.prReviews = body.notifications.prReviews;
    }
    if (typeof body.notifications.syncErrors === "boolean") {
      updates.notifications.syncErrors = body.notifications.syncErrors;
    }
  }

  try {
    const config = setConfig(updates);
    invalidateEnvCache();
    return Response.json({
      keys: keyStates(config),
      notifications: notificationPrefs(config),
    });
  } catch {
    return Response.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
