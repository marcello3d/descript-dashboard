import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import type { WorkItem, ReviewItem, LinearIssue, GitHubPR, CursorAgent } from "@/types";

const DB_PATH = path.join(process.cwd(), ".cache.db");

let db: Database.Database | null = null;

interface RateLimit {
  cost?: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

interface SyncStatusRow {
  service: string;
  last_synced_at: number;
  ttl_ms: number;
  rate_limit_data: string | null;
  meta: string | null;
}

interface WorkItemRow {
  id: string;
  anchor: string;
  title: string;
  linear_data: string | null;
  prs_data: string;
  agents_data: string;
  created_at: number;
  updated_at: number;
}

interface ReviewItemRow {
  id: string;
  anchor: string;
  pr_data: string;
  linear_data: string | null;
  request_type: string;
  created_at: number;
  updated_at: number;
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        anchor TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        linear_data TEXT,
        prs_data TEXT NOT NULL DEFAULT '[]',
        agents_data TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        anchor TEXT UNIQUE NOT NULL,
        pr_data TEXT NOT NULL,
        linear_data TEXT,
        request_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_status (
        service TEXT PRIMARY KEY,
        last_synced_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL,
        rate_limit_data TEXT,
        meta TEXT
      )
    `);
  }
  return db;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    title: row.title,
    linear: row.linear_data ? JSON.parse(row.linear_data) as LinearIssue : undefined,
    prs: JSON.parse(row.prs_data) as GitHubPR[],
    agents: JSON.parse(row.agents_data) as CursorAgent[],
  };
}

function rowToReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    id: row.id,
    pr: JSON.parse(row.pr_data) as GitHubPR,
    linear: row.linear_data ? JSON.parse(row.linear_data) as LinearIssue : undefined,
    requestType: row.request_type as "individual" | "team",
  };
}

// --- Work Items ---

export function upsertWorkItems(items: WorkItem[]): void {
  const d = getDb();
  const findByAnchor = d.prepare("SELECT id, created_at FROM work_items WHERE anchor = ?");
  const insert = d.prepare(
    "INSERT OR REPLACE INTO work_items (id, anchor, title, linear_data, prs_data, agents_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const now = Date.now();
  const tx = d.transaction(() => {
    for (const item of items) {
      const anchor = workItemAnchor(item);
      const existing = findByAnchor.get(anchor) as { id: string; created_at: number } | undefined;
      const id = existing?.id ?? crypto.randomUUID();
      const createdAt = existing?.created_at ?? now;
      insert.run(
        id, anchor, item.title,
        item.linear ? JSON.stringify(item.linear) : null,
        JSON.stringify(item.prs), JSON.stringify(item.agents),
        createdAt, now,
      );
    }
  });
  tx();
}

export function getWorkItems(): WorkItem[] {
  return (getDb().prepare("SELECT * FROM work_items").all() as WorkItemRow[]).map(rowToWorkItem);
}

export function getWorkItemByAnchor(anchor: string): WorkItem | null {
  const row = getDb().prepare("SELECT * FROM work_items WHERE anchor = ?").get(anchor) as WorkItemRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

// --- Review Items ---

export function upsertReviewItems(items: ReviewItem[]): void {
  const d = getDb();
  const findByAnchor = d.prepare("SELECT id, created_at FROM review_items WHERE anchor = ?");
  const insert = d.prepare(
    "INSERT OR REPLACE INTO review_items (id, anchor, pr_data, linear_data, request_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const now = Date.now();
  const tx = d.transaction(() => {
    for (const item of items) {
      const anchor = reviewItemAnchor(item);
      const existing = findByAnchor.get(anchor) as { id: string; created_at: number } | undefined;
      const id = existing?.id ?? crypto.randomUUID();
      const createdAt = existing?.created_at ?? now;
      insert.run(
        id, anchor,
        JSON.stringify(item.pr),
        item.linear ? JSON.stringify(item.linear) : null,
        item.requestType, createdAt, now,
      );
    }
  });
  tx();
}

export function getReviewItems(): ReviewItem[] {
  return (getDb().prepare("SELECT * FROM review_items").all() as ReviewItemRow[]).map(rowToReviewItem);
}

// --- Sync Status ---

export function getSyncStatus(service: string): { lastSyncedAt: number; ttlMs: number; rateLimitData?: RateLimit; meta?: Record<string, unknown> } | null {
  const row = getDb().prepare("SELECT * FROM sync_status WHERE service = ?").get(service) as SyncStatusRow | undefined;
  if (!row) return null;
  return {
    lastSyncedAt: row.last_synced_at,
    ttlMs: row.ttl_ms,
    rateLimitData: row.rate_limit_data ? JSON.parse(row.rate_limit_data) : undefined,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
  };
}

export function setSyncStatus(service: string, ttlMs: number, opts?: { rateLimitData?: RateLimit; meta?: Record<string, unknown> }): void {
  getDb().prepare(
    "INSERT OR REPLACE INTO sync_status (service, last_synced_at, ttl_ms, rate_limit_data, meta) VALUES (?, ?, ?, ?, ?)"
  ).run(
    service, Date.now(), ttlMs,
    opts?.rateLimitData ? JSON.stringify(opts.rateLimitData) : null,
    opts?.meta ? JSON.stringify(opts.meta) : null,
  );
}

export function needsSync(service: string): boolean {
  const row = getDb().prepare("SELECT last_synced_at, ttl_ms FROM sync_status WHERE service = ?").get(service) as { last_synced_at: number; ttl_ms: number } | undefined;
  if (!row) return true;
  return Date.now() - row.last_synced_at > row.ttl_ms;
}

export function resetSyncStatus(service: string): void {
  getDb().prepare("DELETE FROM sync_status WHERE service = ?").run(service);
}

// --- Anchor helpers ---

export function workItemAnchor(item: WorkItem): string {
  if (item.linear) return item.linear.identifier;
  if (item.prs.length > 0) {
    const pr = item.prs[0];
    const num = pr.url.match(/\/pull\/(\d+)/)?.[1] ?? String(pr.id);
    return `pr:${pr.repo}#${num}`;
  }
  if (item.agents.length > 0) return `agent:${item.agents[0].id}`;
  return `unknown:${crypto.randomUUID()}`;
}

export function reviewItemAnchor(item: ReviewItem): string {
  const num = item.pr.url.match(/\/pull\/(\d+)/)?.[1] ?? String(item.pr.id);
  return `review:${item.pr.repo}#${num}`;
}
