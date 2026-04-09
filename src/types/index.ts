export interface LinearIssue {
  id: string;
  title: string;
  identifier: string;
  status: string;
  priority: number;
  url: string;
  updatedAt: string;
  assignee?: string; // display name of the assignee
  prUrls: string[]; // GitHub PR URLs linked via attachments/relations
}

export interface GitHubPR {
  id: number;
  title: string;
  author: string; // display name or login
  authorLogin: string; // GitHub username
  repo: string;
  branch: string;
  draft: boolean;
  merged: boolean;
  closed: boolean;
  url: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null
  checksState: string | null; // SUCCESS, FAILURE, PENDING, ERROR, EXPECTED, or null
  requestedReviewers: string[]; // individual logins requested for review
  requestedTeams: string[]; // team slugs requested for review
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
}
