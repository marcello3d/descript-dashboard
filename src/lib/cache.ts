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
  }
  return db;
}

export function getCached<T>(key: string): T | null {
  const now = Date.now();
  const row = getDb()
    .prepare("SELECT data, expires_at FROM cache WHERE key = ?")
    .get(key) as { data: string; expires_at: number } | undefined;
  if (!row) {
    console.log(`[cache] MISS ${key} — no entry`);
    return null;
  }
  if (row.expires_at <= now) {
    console.log(`[cache] MISS ${key} — expired ${Math.round((now - row.expires_at) / 1000)}s ago`);
    return null;
  }
  console.log(`[cache] HIT ${key} — expires in ${Math.round((row.expires_at - now) / 1000)}s`);
  return JSON.parse(row.data) as T;
}

export function setCache<T>(key: string, data: T, ttlMs: number): void {
  console.log(`[cache] SET ${key} — ttl ${Math.round(ttlMs / 1000)}s`);
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO cache (key, data, expires_at) VALUES (?, ?, ?)"
    )
    .run(key, JSON.stringify(data), Date.now() + ttlMs);
}
