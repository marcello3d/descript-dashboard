@AGENTS.md

## Architecture

Personal dashboard that aggregates work items from Linear, GitHub, and Cursor into a single view. Next.js 16 app (runs on port 4080).

### Data flow

1. **API routes** (`src/app/api/work-items/route.ts`) fetch from three services in parallel:
   - `src/lib/linear.ts` — assigned Linear issues (excludes completed/canceled state types)
   - `src/lib/github.ts` — authored GitHub PRs via REST API
   - `src/lib/cursor.ts` — Cursor background agent jobs
2. **`src/lib/work-items.ts`** (`buildWorkItems`) joins them into unified `WorkItem` objects by matching Linear identifiers in PR titles/branches/attachments. Also discovers missing Linear issues referenced in PRs/agents and fetches them in a second pass.
3. **`src/lib/cache.ts`** — SQLite-backed cache (`better-sqlite3`) with TTLs, request deduplication, and API call stats tracking.
4. **`src/app/page.tsx`** — single-page client UI. Polls `/api/work-items`, then filters (open/closed/all), sorts (stage/date/priority), and groups items client-side.

### Key types (`src/types/index.ts`)

`WorkItem` = `{ id, title, linear?: LinearIssue, pr?: GitHubPR, agents: CursorAgent[] }`

### Client-side grouping (page.tsx)

- **Open/closed split**: closed = merged PR (unless Linear status is "verify"), canceled, or cursor-only items
- **Stage groups** (when sort=stage): verify → approved → changes requested → waiting → draft → other
- **`getActionGroup()`** determines stage; Linear "verify" status takes priority over PR state

## Debugging

- Dev server: `npm run dev` (port 4080)
- Hit the API directly: `curl http://localhost:4080/api/work-items | jq`
- Bypass cache: `curl http://localhost:4080/api/work-items?fresh=1 | jq`
- Filter for a specific issue: `curl -s http://localhost:4080/api/work-items | jq '.items[] | select(.id == "MM-34063")'`
- API call stats are included in the response under `.stats` and `.recent`
- Cache TTLs: Linear 5min, GitHub 5min, Cursor 2min, work-items 2min
- SQLite cache DB: `.cache.db` in project root

## Environment variables

- `LINEAR_API_KEY` — Linear personal API key
- `GITHUB_TOKEN` — GitHub personal access token
- `CURSOR_API_KEY` — Cursor API key
