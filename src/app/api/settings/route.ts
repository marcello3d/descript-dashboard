import { getConfig, setConfig, maskKey, type AppConfig } from "@/lib/config";
import { invalidateEnvCache } from "@/lib/env";

function notificationPrefs(config: AppConfig) {
  return {
    reviewRequests: config.notifications?.reviewRequests !== false,
    syncErrors: config.notifications?.syncErrors !== false,
  };
}

export async function GET() {
  const config = getConfig();
  return Response.json({
    keys: {
      GITHUB_TOKEN: { set: !!config.GITHUB_TOKEN, masked: maskKey(config.GITHUB_TOKEN) },
      LINEAR_API_KEY: { set: !!config.LINEAR_API_KEY, masked: maskKey(config.LINEAR_API_KEY) },
      CURSOR_API_KEY: { set: !!config.CURSOR_API_KEY, masked: maskKey(config.CURSOR_API_KEY) },
    },
    envOverrides: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      LINEAR_API_KEY: !!process.env.LINEAR_API_KEY,
      CURSOR_API_KEY: !!process.env.CURSOR_API_KEY,
    },
    notifications: notificationPrefs(config),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const updates: Partial<AppConfig> = {};
  for (const key of ["GITHUB_TOKEN", "LINEAR_API_KEY", "CURSOR_API_KEY"] as const) {
    if (key in body) {
      updates[key] = typeof body[key] === "string" ? body[key] : undefined;
    }
  }
  if (body.notifications && typeof body.notifications === "object") {
    updates.notifications = {};
    if (typeof body.notifications.reviewRequests === "boolean") {
      updates.notifications.reviewRequests = body.notifications.reviewRequests;
    }
    if (typeof body.notifications.syncErrors === "boolean") {
      updates.notifications.syncErrors = body.notifications.syncErrors;
    }
  }

  try {
    const config = setConfig(updates);
    invalidateEnvCache();
    return Response.json({
      keys: {
        GITHUB_TOKEN: { set: !!config.GITHUB_TOKEN, masked: maskKey(config.GITHUB_TOKEN) },
        LINEAR_API_KEY: { set: !!config.LINEAR_API_KEY, masked: maskKey(config.LINEAR_API_KEY) },
        CURSOR_API_KEY: { set: !!config.CURSOR_API_KEY, masked: maskKey(config.CURSOR_API_KEY) },
      },
      notifications: notificationPrefs(config),
    });
  } catch {
    return Response.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
