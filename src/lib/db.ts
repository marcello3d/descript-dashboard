import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import type { WorkItem, ReviewItem, LinearIssue, GitHubPR, CursorAgent } from "@/types";

const DB_PATH = path.join(process.env.DESCRIPT_DASHBOARD_CONFIG_PATH || process.cwd(), ".cache.db");

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
  tags: string;
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
    const hasTagsCol = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('work_items') WHERE name = 'tags'").get() as { c: number };
    if (hasTagsCol.c === 0) {
      db.exec("ALTER TABLE work_items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    // Migrate any rows that still have the old random-UUID id to the stable anchor.
    // Lets the client's localStorage favorites/archive (keyed by id) survive cache rebuilds.
    db.exec(`
      UPDATE work_items SET id = anchor WHERE id != anchor;
      UPDATE review_items SET id = anchor WHERE id != anchor;
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS tags (tag TEXT PRIMARY KEY)`);
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
    tags: JSON.parse(row.tags) as string[],
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
  const findByAnchor = d.prepare("SELECT id, created_at, tags FROM work_items WHERE anchor = ?");
  const insert = d.prepare(
    "INSERT OR REPLACE INTO work_items (id, anchor, title, linear_data, prs_data, agents_data, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const now = Date.now();
  const currentAnchors = new Set(items.map(workItemAnchor));

  // Build a map of PR URL -> new anchor, for migrating tags from stale orphans
  const prUrlToNewAnchor = new Map<string, string>();
  for (const item of items) {
    const anchor = workItemAnchor(item);
    for (const pr of item.prs) prUrlToNewAnchor.set(pr.url, anchor);
  }

  const tx = d.transaction(() => {
    // Find stale items and migrate their tags before deleting
    const allRows = d.prepare("SELECT anchor, tags, prs_data FROM work_items").all() as { anchor: string; tags: string; prs_data: string }[];
    const tagsToMigrate = new Map<string, string[]>(); // new anchor -> tags to add
    for (const row of allRows) {
      if (currentAnchors.has(row.anchor)) continue;
      // Migrate tags from stale item to the new item that contains its PRs
      const oldTags: string[] = JSON.parse(row.tags || "[]");
      if (oldTags.length > 0) {
        const oldPrs: { url: string }[] = JSON.parse(row.prs_data || "[]");
        for (const pr of oldPrs) {
          const newAnchor = prUrlToNewAnchor.get(pr.url);
          if (newAnchor) {
            tagsToMigrate.set(newAnchor, [...(tagsToMigrate.get(newAnchor) ?? []), ...oldTags]);
            break;
          }
        }
      }
      d.prepare("DELETE FROM work_items WHERE anchor = ?").run(row.anchor);
    }

    for (const item of items) {
      const anchor = workItemAnchor(item);
      const existing = findByAnchor.get(anchor) as { id: string; created_at: number; tags: string } | undefined;
      const createdAt = existing?.created_at ?? now;
      const existingTags: string[] = JSON.parse(existing?.tags ?? "[]");
      const migratedTags = tagsToMigrate.get(anchor) ?? [];
      const mergedTags = [...new Set([...existingTags, ...migratedTags])];
      insert.run(
        anchor, anchor, item.title,
        item.linear ? JSON.stringify(item.linear) : null,
        JSON.stringify(item.prs), JSON.stringify(item.agents),
        JSON.stringify(mergedTags), createdAt, now,
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
  const currentAnchors = new Set(items.map(reviewItemAnchor));
  const tx = d.transaction(() => {
    // Delete review items no longer in the current set
    const allAnchors = d.prepare("SELECT anchor FROM review_items").all() as { anchor: string }[];
    for (const { anchor } of allAnchors) {
      if (!currentAnchors.has(anchor)) {
        d.prepare("DELETE FROM review_items WHERE anchor = ?").run(anchor);
      }
    }
    for (const item of items) {
      const anchor = reviewItemAnchor(item);
      const existing = findByAnchor.get(anchor) as { id: string; created_at: number } | undefined;
      const createdAt = existing?.created_at ?? now;
      insert.run(
        anchor, anchor,
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

// --- Tags ---

export function addWorkItemTag(workItemId: string, tag: string): string[] {
  const d = getDb();
  const row = d.prepare("SELECT tags FROM work_items WHERE id = ?").get(workItemId) as { tags: string } | undefined;
  if (!row) return [];
  const tags: string[] = JSON.parse(row.tags);
  if (tags.includes(tag)) return tags;
  tags.push(tag);
  d.prepare("UPDATE work_items SET tags = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tags), Date.now(), workItemId);
  d.prepare("INSERT OR IGNORE INTO tags (tag) VALUES (?)").run(tag);
  return tags;
}

export function removeWorkItemTag(workItemId: string, tag: string): string[] {
  const d = getDb();
  const row = d.prepare("SELECT tags FROM work_items WHERE id = ?").get(workItemId) as { tags: string } | undefined;
  if (!row) return [];
  const tags: string[] = JSON.parse(row.tags).filter((t: string) => t !== tag);
  d.prepare("UPDATE work_items SET tags = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tags), Date.now(), workItemId);
  return tags;
}

export function getAllTags(): string[] {
  return (getDb().prepare("SELECT tag FROM tags ORDER BY tag").all() as { tag: string }[]).map(r => r.tag);
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

// --- Reset ---

export function resetAll(): void {
  const d = getDb();
  d.exec(`
    DELETE FROM work_items;
    DELETE FROM review_items;
    DELETE FROM cache;
    DELETE FROM sync_status;
    DELETE FROM api_calls;
    DELETE FROM tags;
  `);
}
