import { LinearClient } from "@linear/sdk";
import type { LinearIssue } from "@/types";

// Extract Linear identifiers (e.g. "DIO-123") from text
const IDENTIFIER_RE = /[A-Z]+-\d+/gi;

async function issueToLinearIssue(issue: any): Promise<LinearIssue> {
  const state = await issue.state;
  const attachments = await issue.attachments();
  const prUrls: string[] = [];
  for (const att of attachments.nodes) {
    if (att.url && att.url.includes("github.com") && att.url.includes("/pull/")) {
      prUrls.push(att.url);
    }
  }
  return {
    id: issue.id,
    title: issue.title,
    identifier: issue.identifier,
    status: state?.name ?? "Unknown",
    priority: issue.priority,
    url: issue.url,
    updatedAt: issue.updatedAt.toISOString(),
    prUrls,
  };
}

export async function fetchIssuesByIdentifiers(
  apiKey: string,
  identifiers: string[]
): Promise<LinearIssue[]> {
  if (identifiers.length === 0) return [];
  const client = new LinearClient({ apiKey });
  const result: LinearIssue[] = [];
  // Linear SDK doesn't support batch identifier lookup, so fetch one at a time
  // but parallelize them
  const promises = identifiers.map(async (id) => {
    try {
      const issue = await client.issue(id);
      if (issue) return issueToLinearIssue(issue);
    } catch {
      // Issue not found or other error
    }
    return null;
  });
  const resolved = await Promise.all(promises);
  for (const r of resolved) {
    if (r) result.push(r);
  }
  return result;
}

export interface LinearRateLimit {
  cost?: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface LinearResult {
  issues: LinearIssue[];
  rateLimit?: LinearRateLimit;
}

export async function fetchAssignedIssues(
  apiKey: string
): Promise<LinearResult> {
  const client = new LinearClient({ apiKey });
  const viewer = await client.viewer;
  const issues = await viewer.assignedIssues({
    first: 50,
    filter: {
      state: {
        type: { nin: ["completed", "canceled"] },
      },
    },
  });

  const result = await Promise.all(issues.nodes.map(issueToLinearIssue));

  let rateLimit: LinearRateLimit | undefined;
  try {
    const rl = await client.rateLimitStatus;
    if (rl.limits.length > 0) {
      const lim = rl.limits[0];
      rateLimit = {
        cost: Math.round(lim.requestedAmount),
        remaining: Math.round(lim.remainingAmount),
        limit: Math.round(lim.allowedAmount),
        resetAt: new Date(lim.reset * 1000).toISOString(),
      };
    }
  } catch {
    // ignore
  }

  return { issues: result, rateLimit };
}
