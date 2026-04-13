import fs from "fs";
import path from "path";

export interface AppConfig {
  GITHUB_TOKEN?: string;
  LINEAR_API_KEY?: string;
  CURSOR_API_KEY?: string;
}

const CONFIG_KEYS: (keyof AppConfig)[] = ["GITHUB_TOKEN", "LINEAR_API_KEY", "CURSOR_API_KEY"];

function getConfigPath(): string {
  return path.join(process.cwd(), ".config.json");
}

export function getConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const config: AppConfig = {};
    for (const key of CONFIG_KEYS) {
      if (typeof parsed[key] === "string" && parsed[key]) {
        config[key] = parsed[key];
      }
    }
    return config;
  } catch {
    return {};
  }
}

export function setConfig(updates: Partial<AppConfig>): AppConfig {
  const current = getConfig();
  for (const key of CONFIG_KEYS) {
    if (key in updates) {
      const val = updates[key];
      if (val) {
        current[key] = val;
      } else {
        delete current[key];
      }
    }
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(current, null, 2) + "\n");
  return current;
}

export function maskKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
