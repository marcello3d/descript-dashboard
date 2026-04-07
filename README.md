# Descript Dashboard

Personal dashboard that aggregates work items from Linear, GitHub, and Cursor into a single view.

Matches Linear issues to GitHub PRs and Cursor background agents automatically by identifier (e.g. `DIO-123` in PR titles, branch names, and Linear attachments).

## Setup

1. Install dependencies:

```sh
npm install
```

2. Copy `.env.example` to `.env.local` and fill in your API keys:

```sh
cp .env.example .env.local
```

You'll need:

- **`GITHUB_TOKEN`** -- [GitHub personal access token](https://github.com/settings/tokens) with `repo` scope
- **`LINEAR_API_KEY`** -- [Linear personal API key](https://linear.app/settings/api)
- **`CURSOR_API_KEY`** -- Cursor API key (from Cursor Dashboard, Integrations)

All three are optional -- the dashboard works with any subset, just showing less data.

3. Start the dev server:

```sh
npm run dev
```

4. Open [http://localhost:4080](http://localhost:4080)

## Features

- Unified view of Linear issues, GitHub PRs, and Cursor background agents
- Automatic matching across services by Linear identifiers
- Extracts Cursor agent links from GitHub PR descriptions
- Open/closed filtering with status-based grouping (stage, priority)
- Requested reviews tab with individual vs team request sections
- Favorites (starred items) that pin to the top
- SQLite-backed caching (Linear 5min, GitHub 5min, Cursor 2min) to minimize API calls
- Dark mode support

## Debugging

```sh
# Hit the API directly
curl http://localhost:4080/api/work-items | jq

# Bypass cache
curl http://localhost:4080/api/work-items?fresh=1 | jq

# Filter for a specific issue
curl -s http://localhost:4080/api/work-items | jq '.items[] | select(.id == "DIO-123")'
```

API call stats are included in the response under `.stats` and `.recent`. The SQLite cache DB is stored at `.cache.db` in the project root -- delete it to force a full refresh.
