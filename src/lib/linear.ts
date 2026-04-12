import { LinearClient } from "@linear/sdk";
import type { LinearIssue } from "@/types";

// Raw resolved data from Linear SDK (plain object, JSON-serializable)
export interface RawLinearIssue {
  id: string;
  title: string;
  identifier: string;
  statusName: string;
  priority: number;
  url: string;
  updatedAt: string;
  assigneeName?: string;
  attachmentUrls: string[];
}

async function resolveIssue(issue: any): Promise<RawLinearIssue> {
  const state = await issue.state;
  const assigneeObj = await issue.assignee;
  const attachments = await issue.attachments();
  const attachmentUrls: string[] = [];
  for (const att of attachments.nodes) {
    if (att.url) attachmentUrls.push(att.url);
  }
  return {
    id: issue.id,
    title: issue.title,
    identifier: issue.identifier,
    statusName: state?.name ?? "Unknown",
    priority: issue.priority,
    url: issue.url,
    updatedAt: issue.updatedAt.toISOString(),
    assigneeName: assigneeObj?.displayName ?? undefined,
    attachmentUrls,
  };
}

export function transformIssue(raw: RawLinearIssue): LinearIssue {
  const prUrls: string[] = [];
  for (const url of raw.attachmentUrls) {
    if (url.includes("github.com") && url.includes("/pull/")) {
      prUrls.push(url);
    }
  }
  return {
    id: raw.id,
    title: raw.title,
    identifier: raw.identifier,
    status: raw.statusName,
    priority: raw.priority,
    url: raw.url,
    updatedAt: raw.updatedAt,
    assignee: raw.assigneeName,
    prUrls,
  };
}

export function transformIssues(raw: RawLinearIssue[]): LinearIssue[] {
  return raw.map(transformIssue);
}

export async function fetchRawIssuesByIdentifiers(
  apiKey: string,
  identifiers: string[]
): Promise<RawLinearIssue[]> {
  if (identifiers.length === 0) return [];
  const client = new LinearClient({ apiKey });
  const promises = identifiers.map(async (id) => {
    try {
      const issue = await client.issue(id);
      if (issue) return resolveIssue(issue);
    } catch {
      // Issue not found or other error
    }
    return null;
  });
  const resolved = await Promise.all(promises);
  return resolved.filter((r): r is RawLinearIssue => r !== null);
}

export interface LinearRateLimit {
  cost?: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface RawLinearResult {
  issues: RawLinearIssue[];
  rateLimit?: LinearRateLimit;
}

export async function fetchRawSubscribedIssues(
  apiKey: string
): Promise<RawLinearIssue[]> {
  const client = new LinearClient({ apiKey });
  const issues = await client.issues({
    first: 50,
    filter: {
      and: [
        { subscribers: { some: { isMe: { eq: true } } } },
        { assignee: { isMe: { eq: false } } },
        { state: { type: { nin: ["completed", "canceled"] } } },
      ],
    },
    orderBy: "updatedAt" as any,
  });

  return Promise.all(issues.nodes.map(resolveIssue));
}

export interface WorkflowStateInfo {
  id: string;
  name: string;
  color: string;
  type: string;
  position: number;
}

export async function fetchWorkflowStatesForIssue(
  apiKey: string,
  issueId: string
): Promise<WorkflowStateInfo[]> {
  const client = new LinearClient({ apiKey });
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) throw new Error("Issue has no team");
  const states = await team.states();
  return states.nodes
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      type: s.type,
      position: s.position,
    }))
    .sort((a, b) => a.position - b.position);
}

export async function updateIssueStatus(
  apiKey: string,
  issueId: string,
  stateId: string
): Promise<{ success: boolean; statusName: string }> {
  const client = new LinearClient({ apiKey });
  const payload = await client.updateIssue(issueId, { stateId });
  if (!payload.success) throw new Error("Failed to update issue");
  const updated = await payload.issue;
  if (!updated) throw new Error("Issue not found after update");
  const state = await updated.state;
  return { success: true, statusName: state?.name ?? "Unknown" };
}

export async function fetchRawAssignedIssues(
  apiKey: string
): Promise<RawLinearResult> {
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

  const result = await Promise.all(issues.nodes.map(resolveIssue));

  let rateLimit: LinearRateLimit | undefined;
  try {
    const rl = await client.rateLimitStatus;
    if (rl.limits.length > 0) {
      const lim = rl.limits[0];
      rateLimit = {
        cost: Math.round(lim.requestedAmount),
        remaining: Math.round(lim.remainingAmount),
        limit: Math.round(lim.allowedAmount),
        resetAt: new Date(lim.reset).toISOString(),
      };
    }
  } catch {
    // ignore
  }

  return { issues: result, rateLimit };
}
