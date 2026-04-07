import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), ".cache.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        cost INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    // Migrate: add cost column if missing
    try {
      db.exec("ALTER TABLE api_calls ADD COLUMN cost INTEGER");
    } catch {
      // column already exists
    }
  }
  return db;
}

export function getCached<T>(key: string, ignoreExpiry = false): T | null {
  const now = Date.now();
  const row = getDb()
    .prepare("SELECT data, expires_at FROM cache WHERE key = ?")
    .get(key) as { data: string; expires_at: number } | undefined;
  if (!row) {
    console.log(`[cache] MISS ${key} — no entry`);
    return null;
  }
  if (!ignoreExpiry && row.expires_at <= now) {
    console.log(`[cache] MISS ${key} — expired ${Math.round((now - row.expires_at) / 1000)}s ago`);
    return null;
  }
  console.log(`[cache] HIT ${key} — expires in ${Math.round((row.expires_at - now) / 1000)}s${ignoreExpiry ? " (stale ok)" : ""}`);
  return JSON.parse(row.data) as T;
}

export function logApiCall(
  service: string,
  endpoint: string,
  status: "ok" | "error" | "cached",
  durationMs: number,
  opts?: { error?: string; cost?: number }
): void {
  getDb()
    .prepare(
      "INSERT INTO api_calls (service, endpoint, status, duration_ms, cost, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(service, endpoint, status, Math.round(durationMs), opts?.cost ?? null, opts?.error ?? null, Date.now());
}

export interface ApiCallStats {
  service: string;
  total: number;
  ok: number;
  cached: number;
  errors: number;
  last_call: number;
}

export function getApiCallStats(sinceMs?: number): ApiCallStats[] {
  const since = sinceMs ?? Date.now() - 60 * 60 * 1000; // default last hour
  return getDb()
    .prepare(`
      SELECT
        service,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN status = 'cached' THEN 1 ELSE 0 END) as cached,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
        MAX(created_at) as last_call
      FROM api_calls
      WHERE created_at >= ?
      GROUP BY service
    `)
    .all(since) as ApiCallStats[];
}

export interface RecentApiCall {
  service: string;
  endpoint: string;
  status: string;
  duration_ms: number;
  cost: number | null;
  error: string | null;
  created_at: number;
  cache_hits: number;
}

export function getRecentApiCalls(limit = 50): RecentApiCall[] {
  // Return actual API calls (ok/error) with a count of cache hits that followed
  // Uses a window function to group cache hits with the preceding real call
  return getDb()
    .prepare(`
      WITH numbered AS (
        SELECT *,
          SUM(CASE WHEN status != 'cached' THEN 1 ELSE 0 END) OVER (
            PARTITION BY service, endpoint ORDER BY created_at DESC
          ) as grp
        FROM api_calls
      )
      SELECT
        service, endpoint,
        MIN(CASE WHEN status != 'cached' THEN status END) as status,
        MAX(duration_ms) as duration_ms,
        MAX(cost) as cost,
        MAX(CASE WHEN status != 'cached' THEN error END) as error,
        MAX(CASE WHEN status != 'cached' THEN created_at END) as created_at,
        SUM(CASE WHEN status = 'cached' THEN 1 ELSE 0 END) as cache_hits
      FROM numbered
      GROUP BY service, endpoint, grp
      HAVING MAX(CASE WHEN status != 'cached' THEN 1 ELSE 0 END) = 1
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as RecentApiCall[];
}

// In-flight request deduplication: if the same key is already being fetched,
// return the existing promise instead of starting a new request.
const inflight = new Map<string, Promise<any>>();

export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function setCache<T>(key: string, data: T, ttlMs: number): void {
  console.log(`[cache] SET ${key} — ttl ${Math.round(ttlMs / 1000)}s`);
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO cache (key, data, expires_at) VALUES (?, ?, ?)"
    )
    .run(key, JSON.stringify(data), Date.now() + ttlMs);
}
