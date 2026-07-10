import { LinearClient } from "@linear/sdk";
import type { LinearIssue } from "@/types";

// Raw resolved data — JSON-serializable, suitable for caching as-is.
export interface RawLinearIssue {
  id: string;
  title: string;
  identifier: string;
  statusName: string;
  statusType: string;
  priority: number;
  url: string;
  updatedAt: string;
  assigneeName?: string;
  attachmentUrls: string[];
  // URLs of interest (GitHub PRs, Cursor agents) extracted from comment bodies.
  // Linear's "Cursor connected" UI tile is rendered from a comment, not an attachment.
  commentUrls: string[];
}

const COMMENT_URL_RE = /https?:\/\/(?:[a-z0-9.-]*\.)?(?:github\.com\/[^\s)\]<>"]+\/pull\/\d+|cursor\.com\/agents\/[^\s)\]<>"]+)/gi;

// Single-shot GraphQL: pulls everything resolveIssue() used to lazy-load
// (state, assignee, attachments, comments) in one request per fetch instead
// of 5 requests per issue. Cuts a 50-issue sync from ~250 round-trips to 1.
const ISSUE_FIELDS_FRAGMENT = `
  fragment IssueFields on Issue {
    id
    title
    identifier
    priority
    url
    updatedAt
    state { name type }
    assignee { displayName }
    attachments { nodes { url } }
    comments(first: 50) { nodes { body } }
  }
`;

interface IssueFieldsGraphQL {
  id: string;
  title: string;
  identifier: string;
  priority: number;
  url: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { displayName: string } | null;
  attachments: { nodes: { url: string | null }[] };
  comments: { nodes: { body: string | null }[] };
}

interface LinearGraphQLClient {
  rawRequest<T>(query: string, variables?: Record<string, unknown>): Promise<{ data?: T }>;
}

function getRawClient(client: LinearClient): LinearGraphQLClient {
  return (client as unknown as { client: LinearGraphQLClient }).client;
}

function mapIssue(raw: IssueFieldsGraphQL): RawLinearIssue {
  const attachmentUrls: string[] = [];
  for (const att of raw.attachments.nodes) {
    if (att.url) attachmentUrls.push(att.url);
  }
  const commentUrls = new Set<string>();
  for (const c of raw.comments.nodes) {
    if (!c.body) continue;
    for (const m of c.body.matchAll(COMMENT_URL_RE)) {
      commentUrls.add(m[0].replace(/[)>,.;]+$/, ""));
    }
  }
  return {
    id: raw.id,
    title: raw.title,
    identifier: raw.identifier,
    statusName: raw.state?.name ?? "Unknown",
    statusType: raw.state?.type ?? "unstarted",
    priority: raw.priority,
    url: raw.url,
    updatedAt: raw.updatedAt,
    assigneeName: raw.assignee?.displayName ?? undefined,
    attachmentUrls,
    commentUrls: [...commentUrls],
  };
}

export function transformIssue(raw: RawLinearIssue): LinearIssue {
  const prUrls = new Set<string>();
  const cursorAgentUrls = new Set<string>();
  const sources = [raw.attachmentUrls, raw.commentUrls ?? []];
  for (const list of sources) {
    for (const url of list) {
      if (url.includes("github.com") && url.includes("/pull/")) {
        prUrls.add(url);
      } else if (url.includes("cursor.com/agents/")) {
        cursorAgentUrls.add(url);
      }
    }
  }
  return {
    id: raw.id,
    title: raw.title,
    identifier: raw.identifier,
    status: raw.statusName,
    statusType: raw.statusType ?? "unstarted",
    priority: raw.priority,
    url: raw.url,
    updatedAt: raw.updatedAt,
    assignee: raw.assigneeName,
    prUrls: [...prUrls],
    cursorAgentUrls: [...cursorAgentUrls],
  };
}

export function transformIssues(raw: RawLinearIssue[]): LinearIssue[] {
  return raw.map(transformIssue);
}

// One round-trip per N identifiers via aliased subqueries.
export async function fetchRawIssuesByIdentifiers(
  apiKey: string,
  identifiers: string[]
): Promise<RawLinearIssue[]> {
  if (identifiers.length === 0) return [];
  const client = new LinearClient({ apiKey });

  // Parse "TEAM-123" into { key, number }; skip anything malformed.
  const parsed = identifiers
    .map((id) => {
      const m = id.match(/^([A-Za-z]+)-(\d+)$/);
      return m ? { key: m[1].toUpperCase(), number: Number(m[2]) } : null;
    })
    .filter((p): p is { key: string; number: number } => p !== null);
  if (parsed.length === 0) return [];

  // Use a filtered `issues` query rather than aliased `issue(id:)` lookups: Linear
  // nulls the ENTIRE response if any single `issue(id:)` alias references a missing or
  // inaccessible issue, which would wipe out every valid result in the batch (e.g. one
  // stale identifier in a claude[bot] PR branch would drop all the others). A filter
  // silently skips non-matching identifiers and still costs a single request.
  const query = `
    ${ISSUE_FIELDS_FRAGMENT}
    query IssuesByIdentifiers($filter: IssueFilter!) {
      issues(first: 250, filter: $filter) {
        nodes { ...IssueFields }
      }
    }
  `;
  const filter = {
    or: parsed.map(({ key, number }) => ({
      and: [{ team: { key: { eq: key } } }, { number: { eq: number } }],
    })),
  };

  try {
    const res = await getRawClient(client).rawRequest<{ issues: { nodes: IssueFieldsGraphQL[] } }>(query, { filter });
    return (res.data?.issues.nodes ?? []).map(mapIssue);
  } catch {
    // On a hard failure, fall back to no results.
    return [];
  }
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

interface RateLimitGraphQL {
  limits: { requestedAmount: number; remainingAmount: number; allowedAmount: number; reset: number }[];
}

function pickRateLimit(rl: RateLimitGraphQL | null | undefined): LinearRateLimit | undefined {
  if (!rl?.limits?.length) return undefined;
  const lim = rl.limits[0];
  return {
    cost: Math.round(lim.requestedAmount),
    remaining: Math.round(lim.remainingAmount),
    limit: Math.round(lim.allowedAmount),
    resetAt: new Date(lim.reset).toISOString(),
  };
}

const RATE_LIMIT_FRAGMENT = `
  rateLimitStatus {
    limits { requestedAmount remainingAmount allowedAmount reset }
  }
`;

export async function fetchRawAssignedIssues(
  apiKey: string
): Promise<RawLinearResult> {
  const client = new LinearClient({ apiKey });
  const query = `
    ${ISSUE_FIELDS_FRAGMENT}
    query AssignedIssues {
      viewer {
        assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
          nodes { ...IssueFields }
        }
      }
      ${RATE_LIMIT_FRAGMENT}
    }
  `;
  const res = await getRawClient(client).rawRequest<{
    viewer: { assignedIssues: { nodes: IssueFieldsGraphQL[] } };
    rateLimitStatus: RateLimitGraphQL | null;
  }>(query);
  const nodes = res.data?.viewer.assignedIssues.nodes ?? [];
  return {
    issues: nodes.map(mapIssue),
    rateLimit: pickRateLimit(res.data?.rateLimitStatus),
  };
}

export async function fetchRawSubscribedIssues(
  apiKey: string
): Promise<RawLinearIssue[]> {
  const client = new LinearClient({ apiKey });
  const query = `
    ${ISSUE_FIELDS_FRAGMENT}
    query SubscribedIssues {
      issues(
        first: 50,
        filter: {
          and: [
            { subscribers: { some: { isMe: { eq: true } } } },
            { assignee: { isMe: { eq: false } } },
            { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }
          ]
        },
        orderBy: updatedAt
      ) {
        nodes { ...IssueFields }
      }
    }
  `;
  const res = await getRawClient(client).rawRequest<{
    issues: { nodes: IssueFieldsGraphQL[] };
  }>(query);
  return (res.data?.issues.nodes ?? []).map(mapIssue);
}

export async function fetchRawCompletedIssues(
  apiKey: string
): Promise<RawLinearResult> {
  const client = new LinearClient({ apiKey });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const query = `
    ${ISSUE_FIELDS_FRAGMENT}
    query CompletedIssues($cutoff: DateTimeOrDuration!) {
      viewer {
        assignedIssues(
          first: 100,
          filter: {
            and: [
              { or: [
                { state: { type: { eq: "completed" } } },
                { state: { name: { eq: "Verify" } } }
              ] },
              { updatedAt: { gte: $cutoff } }
            ]
          },
          orderBy: updatedAt
        ) {
          nodes { ...IssueFields }
        }
      }
      ${RATE_LIMIT_FRAGMENT}
    }
  `;
  const res = await getRawClient(client).rawRequest<{
    viewer: { assignedIssues: { nodes: IssueFieldsGraphQL[] } };
    rateLimitStatus: RateLimitGraphQL | null;
  }>(query, { cutoff });
  const nodes = res.data?.viewer.assignedIssues.nodes ?? [];
  return {
    issues: nodes.map(mapIssue),
    rateLimit: pickRateLimit(res.data?.rateLimitStatus),
  };
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

export async function updateIssuePriority(
  apiKey: string,
  issueId: string,
  priority: number
): Promise<{ success: boolean; priority: number }> {
  const client = new LinearClient({ apiKey });
  const payload = await client.updateIssue(issueId, { priority });
  if (!payload.success) throw new Error("Failed to update issue");
  const updated = await payload.issue;
  if (!updated) throw new Error("Issue not found after update");
  return { success: true, priority: updated.priority };
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
