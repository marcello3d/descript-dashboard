import { getConfig, type AppConfig, SECRET_KEYS } from "@/lib/config";

let cached: AppConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 2_000; // re-read config file frequently to pick up settings changes

export function invalidateEnvCache(): void {
  cached = null;
  cacheTime = 0;
}


export function getEnv(key: (typeof SECRET_KEYS)[number]): string | undefined {
  // process.env takes priority
  const envVal = process.env[key];
  if (envVal) return envVal;

  // Fall back to config file
  const now = Date.now();
  if (!cached || now - cacheTime > CACHE_TTL) {
    cached = getConfig();
    cacheTime = now;
  }
  return cached[key] || undefined;
}
