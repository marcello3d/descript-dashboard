export interface LinearIssue {
  id: string;
  title: string;
  identifier: string;
  status: string;
  priority: number;
  url: string;
  updatedAt: string;
}

export interface GitHubPR {
  id: number;
  title: string;
  repo: string;
  draft: boolean;
  url: string;
  updatedAt: string;
  reviewDecision: string | null; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null
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
}

// A unified work item that links related PRs, issues, and agents
export interface WorkItem {
  id: string;
  title: string;
  linear?: LinearIssue;
  pr?: GitHubPR;
  agents: CursorAgent[];
}
