import fs from "fs";
import path from "path";

export interface NotificationPrefs {
  reviewRequests?: boolean;
  syncErrors?: boolean;
}

export interface AppConfig {
  GITHUB_TOKEN?: string;
  LINEAR_API_KEY?: string;
  CURSOR_API_KEY?: string;
  notifications?: NotificationPrefs;
}

export const SECRET_KEYS = ["GITHUB_TOKEN", "LINEAR_API_KEY", "CURSOR_API_KEY"] as const;

function getConfigPath(): string {
  const configDir = process.env.DESCRIPT_DASHBOARD_CONFIG_PATH || process.cwd();
  return path.join(configDir, ".config.json");
}

export function getConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const config: AppConfig = {};
    for (const key of SECRET_KEYS) {
      if (typeof parsed[key] === "string" && parsed[key]) {
        config[key] = parsed[key];
      }
    }
    if (parsed.notifications && typeof parsed.notifications === "object") {
      config.notifications = {};
      if (typeof parsed.notifications.reviewRequests === "boolean") {
        config.notifications.reviewRequests = parsed.notifications.reviewRequests;
      }
      if (typeof parsed.notifications.syncErrors === "boolean") {
        config.notifications.syncErrors = parsed.notifications.syncErrors;
      }
    }
    return config;
  } catch {
    return {};
  }
}

export function setConfig(updates: Partial<AppConfig>): AppConfig {
  const current = getConfig();
  for (const key of SECRET_KEYS) {
    if (key in updates) {
      const val = updates[key];
      if (val) {
        current[key] = val;
      } else {
        delete current[key];
      }
    }
  }
  if (updates.notifications) {
    current.notifications = { ...current.notifications, ...updates.notifications };
  }
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return current;
}

export function maskKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
