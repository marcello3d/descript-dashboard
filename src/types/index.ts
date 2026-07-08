export interface LinearIssue {
  id: string;
  title: string;
  identifier: string;
  status: string;
  statusType: string; // Linear workflow state type: triage, backlog, unstarted, started, completed, canceled, duplicate
  priority: number;
  url: string;
  updatedAt: string;
  assignee?: string; // display name of the assignee
  prUrls: string[]; // GitHub PR URLs linked via attachments/relations
  cursorAgentUrls: string[]; // Cursor agent URLs linked via attachments
}

export interface GitHubMergeReadiness {
  ready: boolean;
  state: "ready" | "not_ready" | "unknown";
  reasons: string[];
  mergeable: string | null;
  mergeStateStatus: string | null;
  requiredChecksState: "SUCCESS" | "FAILURE" | "PENDING" | "UNKNOWN" | null;
  requiredChecks: string[];
}

// Parsed from the Trunk merge-queue sticky comment (trunk-io[bot]) on a PR.
export type TrunkMergeState =
  | "awaiting" // sticky comment present, PR not in the queue — `/trunk merge` is available
  | "submitted" // ✨ submitted, waiting for branch protection rules / CI to pass
  | "waiting_batch" // ⏳ waiting to form a batch
  | "testing" // 🧪 running tests in the merge queue
  | "merged" // 😎 merged via the queue
  | "failed" // ❌ failed tests, removed from the queue (re-submittable)
  | "canceled"; // 🚫 canceled, removed from the queue (re-submittable)

export interface TrunkStatus {
  state: TrunkMergeState;
  label: string; // short, human-readable summary of the state
  canSubmit: boolean; // a `/trunk merge` command is valid (submit checkbox present)
  detailsUrl: string | null; // app.trunk.io merge-queue link, when present
}

export interface GitHubPR {
  id: number;
  title: string;
  author: string; // display name or login
  authorLogin: string; // GitHub username
  repo: string;
  branch: string;
  baseBranch: string;
  draft: boolean;
  merged: boolean;
  closed: boolean;
  url: string;
  updatedAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null
  checksState: string | null; // SUCCESS, FAILURE, PENDING, ERROR, EXPECTED, or null
  requestedReviewers: string[]; // individual logins requested for review
  requestedTeams: { slug: string; name: string }[]; // teams requested for review
  bugBotThreadCount: number; // unresolved review threads authored by cursor[bot]
  bugBotThreadUrls: string[]; // direct comment URLs for those threads
  slackThreadUrl: string | null; // Slack thread that requested the PR (parsed from body)
  claudeSessionUrl: string | null; // Claude Code session that produced the PR (parsed from body)
  mergeReadiness: GitHubMergeReadiness;
  trunk: TrunkStatus | null; // Trunk merge-queue status parsed from the PR's trunk-io[bot] comment
}

export interface CursorAgent {
  id: string;
  name: string;
  status: string;
  repo: string;
  branch: string;
  url: string;
  prUrl: string | null;
  createdAt: string;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

export interface ServiceResponse<T> {
  connected: boolean;
  error?: string;
  data?: T[];
  rateLimit?: { cost?: number; remaining: number; limit: number; resetAt: string };
}

// A unified work item that links related PRs, issues, and agents
export interface WorkItem {
  id: string;
  title: string;
  linear?: LinearIssue;
  prs: GitHubPR[];
  agents: CursorAgent[];
  tags: string[];
}

export interface ReviewItem {
  id: string;
  pr: GitHubPR;
  linear?: LinearIssue;
  requestType: "individual" | "team";
}

