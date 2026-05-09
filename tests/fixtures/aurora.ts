// Test fixtures for the fictional company "Aurora Labs" — an analytics
// dashboard SaaS. None of this data is real; it exists to give the test
// suite plausible-looking Linear identifiers, GitHub URLs, and ticket
// titles instead of arbitrary placeholders.
//
// Story:
//   - Engineer alex.chen is shipping work across three Linear teams:
//     DASH (revenue dashboard), API (event ingestion), ETL (data pipeline).
//   - DASH-412 has a Cursor agent that finished days ago and has dropped
//     off the active /v0/agents list — only a Linear comment links it.
//   - API-89 is the conventional case: Linear has the GitHub PR attached.
//   - ETL-203 is the orphan-style case: only the PR title carries the
//     identifier, Linear has no PR/Cursor reference.

import type { RawCursorAgent } from "@/lib/cursor";
import type { RawGitHubPR } from "@/lib/github";
import type { RawLinearIssue } from "@/lib/linear";

export const ORG = "aurora-labs";
export const REPO = "aurora";
export const VIEWER_LOGIN = "alex-chen";

const ghPr = (n: number) => `https://github.com/${ORG}/${REPO}/pull/${n}`;
const cursorAgent = (id: string) => `https://www.cursor.com/agents/${id}`;
const linearUrl = (id: string) => `https://linear.app/aurora/issue/${id}`;

export const FIXTURES = {
  prs: {
    csvExport: 1421,
    rateLimit: 1430,
    backfill: 1418,
    standalone: 1442,
  },
  agents: {
    csvExport: "bc-csv-dash412-7f31",
    rateLimit: "bc-rl-api89-2a90",
  },
  issues: {
    dash: "DASH-412",
    api: "API-89",
    etl: "ETL-203",
  },
} as const;

export const auroraIssues: RawLinearIssue[] = [
  {
    id: "linear-uuid-dash-412",
    title: "Add CSV export to revenue dashboard",
    identifier: FIXTURES.issues.dash,
    statusName: "In Progress",
    statusType: "started",
    priority: 2,
    url: linearUrl(FIXTURES.issues.dash),
    updatedAt: "2026-04-22T19:51:25.703Z",
    assigneeName: "Alex Chen",
    // Linear's UI shows a "Cursor connected" tile for this issue, but the
    // underlying record is a comment, not an attachment. attachmentUrls
    // therefore only carries the linked Slack thread.
    attachmentUrls: [
      "https://aurora.slack.com/archives/C0123ABCD/p1776977406918669",
    ],
    // The Linear comment carries the Cursor agent URL only (not the PR
    // URL directly) — exercising the agent-as-bridge code path.
    commentUrls: [cursorAgent(FIXTURES.agents.csvExport)],
  },
  {
    id: "linear-uuid-api-89",
    title: "Rate-limit /v2/events endpoint per workspace",
    identifier: FIXTURES.issues.api,
    statusName: "In Review",
    statusType: "started",
    priority: 1,
    url: linearUrl(FIXTURES.issues.api),
    updatedAt: "2026-04-23T09:14:10.122Z",
    assigneeName: "Alex Chen",
    attachmentUrls: [ghPr(FIXTURES.prs.rateLimit)],
    commentUrls: [],
  },
  {
    id: "linear-uuid-etl-203",
    title: "Backfill missing user_id on legacy events",
    identifier: FIXTURES.issues.etl,
    statusName: "Todo",
    statusType: "unstarted",
    priority: 3,
    url: linearUrl(FIXTURES.issues.etl),
    updatedAt: "2026-04-19T22:03:01.501Z",
    assigneeName: "Alex Chen",
    attachmentUrls: [],
    commentUrls: [],
  },
];

export const auroraPrs: RawGitHubPR[] = [
  {
    id: 9001,
    title: "Add CSV export to revenue dashboard",
    userLogin: VIEWER_LOGIN,
    owner: ORG,
    repo: REPO,
    branch: "alex-cursor/csv-export-7f31",
    baseBranch: "main",
    draft: false,
    merged: false,
    state: "open",
    url: ghPr(FIXTURES.prs.csvExport),
    updatedAt: "2026-04-27T18:29:57Z",
    mergedAt: null,
    body: "Adds a CSV export action to the revenue dashboard tile menu.",
    additions: 134,
    deletions: 0,
    changedFiles: 12,
    reviews: [],
  },
  {
    id: 9002,
    title: "API-89: per-workspace event rate limiting",
    userLogin: VIEWER_LOGIN,
    owner: ORG,
    repo: REPO,
    branch: "alex/api-89-rate-limit",
    baseBranch: "main",
    draft: false,
    merged: false,
    state: "open",
    url: ghPr(FIXTURES.prs.rateLimit),
    updatedAt: "2026-04-26T11:02:14Z",
    mergedAt: null,
    body: "Implements a token-bucket rate limiter keyed by workspace.",
    additions: 287,
    deletions: 41,
    changedFiles: 9,
    reviews: [{ login: "priya-shah", state: "APPROVED" }],
  },
  {
    id: 9003,
    title: "ETL-203 backfill user_id on legacy events table",
    userLogin: VIEWER_LOGIN,
    owner: ORG,
    repo: REPO,
    branch: "alex/etl-203-backfill",
    baseBranch: "main",
    draft: true,
    merged: false,
    state: "open",
    url: ghPr(FIXTURES.prs.backfill),
    updatedAt: "2026-04-21T08:45:02Z",
    mergedAt: null,
    body: null,
    additions: 96,
    deletions: 4,
    changedFiles: 3,
    reviews: [],
  },
  {
    id: 9004,
    title: "Bump postgres client to 8.11",
    userLogin: VIEWER_LOGIN,
    owner: ORG,
    repo: REPO,
    branch: "alex/bump-pg",
    baseBranch: "main",
    draft: false,
    merged: false,
    state: "open",
    url: ghPr(FIXTURES.prs.standalone),
    updatedAt: "2026-04-25T16:11:55Z",
    mergedAt: null,
    body: null,
    additions: 4,
    deletions: 4,
    changedFiles: 2,
    reviews: [],
  },
];

// Cursor's /v0/agents only returns agents from the recent window. The
// CSV-export agent finished days ago and is therefore absent — it must
// be backfilled via /v0/agents/{id}.
export const auroraActiveAgents: RawCursorAgent[] = [
  {
    id: FIXTURES.agents.rateLimit,
    name: "Rate-limit per workspace",
    status: "FINISHED",
    source: { repository: `github.com/${ORG}/${REPO}` },
    target: {
      branchName: "alex/api-89-rate-limit",
      url: cursorAgent(FIXTURES.agents.rateLimit),
      prUrl: ghPr(FIXTURES.prs.rateLimit),
    },
    createdAt: "2026-04-25T17:58:00Z",
    linesAdded: 287,
    linesRemoved: 41,
    filesChanged: 9,
  },
];

export const auroraInactiveAgent: RawCursorAgent = {
  id: FIXTURES.agents.csvExport,
  name: "CSV export for revenue dashboard",
  status: "FINISHED",
  source: { repository: `github.com/${ORG}/${REPO}` },
  target: {
    branchName: "alex-cursor/csv-export-7f31",
    url: cursorAgent(FIXTURES.agents.csvExport),
    prUrl: ghPr(FIXTURES.prs.csvExport),
  },
  createdAt: "2026-04-19T14:02:33Z",
  linesAdded: 134,
  linesRemoved: 0,
  filesChanged: 12,
};
