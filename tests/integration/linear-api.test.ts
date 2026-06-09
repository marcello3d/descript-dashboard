import { describe, expect, it } from "vitest";
import {
  fetchRawAssignedIssues,
  fetchRawCompletedIssues,
  fetchRawIssuesByIdentifiers,
  fetchRawSubscribedIssues,
} from "@/lib/linear";
import { http, HttpResponse, server } from "../msw";

// Regression guard: if anyone reintroduces SDK lazy-loading (e.g. awaiting
// `issue.state` / `issue.attachments()` / `issue.comments()` per node), each
// fetch* will fan out into N+1 GraphQL roundtrips and tank our Linear rate
// limit. These tests assert that every batched fetch is exactly one request,
// regardless of how many issues come back.
const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

interface GraphQLBody {
  query: string;
  variables?: Record<string, unknown>;
}

function makeIssueNode(identifier: string) {
  return {
    id: `uuid-${identifier}`,
    title: `Issue ${identifier}`,
    identifier,
    priority: 0,
    url: `https://linear.app/aurora/issue/${identifier}`,
    updatedAt: "2026-04-22T00:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    assignee: { displayName: "Alex Chen" },
    attachments: { nodes: [] },
    comments: { nodes: [] },
  };
}

const RATE_LIMIT_RESPONSE = {
  limits: [
    {
      requestedAmount: 1,
      remainingAmount: 2499,
      allowedAmount: 2500,
      reset: Date.now() + 60 * 60 * 1000,
    },
  ],
};

describe("Linear fetch* — single GraphQL request per call", () => {
  it("fetchRawAssignedIssues issues exactly one request", async () => {
    let count = 0;
    const issues = Array.from({ length: 50 }, (_, i) => makeIssueNode(`DASH-${i + 1}`));

    server.use(
      http.post(LINEAR_GRAPHQL, async ({ request }) => {
        count += 1;
        const body = (await request.json()) as GraphQLBody;
        expect(body.query).toContain("AssignedIssues");
        return HttpResponse.json({
          data: {
            viewer: { assignedIssues: { nodes: issues } },
            rateLimitStatus: RATE_LIMIT_RESPONSE,
          },
        });
      }),
    );

    const result = await fetchRawAssignedIssues("test-key");
    expect(count).toBe(1);
    expect(result.issues).toHaveLength(50);
    expect(result.rateLimit?.remaining).toBe(2499);
  });

  it("fetchRawSubscribedIssues issues exactly one request", async () => {
    let count = 0;
    const issues = Array.from({ length: 50 }, (_, i) => makeIssueNode(`API-${i + 1}`));

    server.use(
      http.post(LINEAR_GRAPHQL, async ({ request }) => {
        count += 1;
        const body = (await request.json()) as GraphQLBody;
        expect(body.query).toContain("SubscribedIssues");
        return HttpResponse.json({
          data: { issues: { nodes: issues } },
        });
      }),
    );

    const result = await fetchRawSubscribedIssues("test-key");
    expect(count).toBe(1);
    expect(result).toHaveLength(50);
  });

  it("fetchRawCompletedIssues issues exactly one request", async () => {
    let count = 0;
    const issues = Array.from({ length: 100 }, (_, i) => makeIssueNode(`ETL-${i + 1}`));

    server.use(
      http.post(LINEAR_GRAPHQL, async ({ request }) => {
        count += 1;
        const body = (await request.json()) as GraphQLBody;
        expect(body.query).toContain("CompletedIssues");
        return HttpResponse.json({
          data: {
            viewer: { assignedIssues: { nodes: issues } },
            rateLimitStatus: RATE_LIMIT_RESPONSE,
          },
        });
      }),
    );

    const result = await fetchRawCompletedIssues("test-key");
    expect(count).toBe(1);
    expect(result.issues).toHaveLength(100);
  });

  it("fetchRawIssuesByIdentifiers batches N lookups into one request", async () => {
    let count = 0;
    const ids = ["DASH-412", "API-89", "ETL-203", "AUTH-58", "BILL-77"];

    server.use(
      http.post(LINEAR_GRAPHQL, async ({ request }) => {
        count += 1;
        const body = (await request.json()) as GraphQLBody;
        expect(body.query).toContain("IssuesByIdentifiers");
        // Must use a server-side filter (one request), NOT aliased issue(id:)
        // lookups — a single missing identifier in an alias batch nulls the
        // entire response and drops every valid result.
        expect(body.query).not.toContain("issue(id:");
        const filter = body.variables?.filter as { or?: unknown[] };
        expect(filter?.or).toHaveLength(ids.length);
        // Filtered `issues` query — return one node per requested identifier.
        return HttpResponse.json({
          data: { issues: { nodes: ids.map((id) => makeIssueNode(id)) } },
        });
      }),
    );

    const result = await fetchRawIssuesByIdentifiers("test-key", ids);
    expect(count).toBe(1);
    expect(result.map((r) => r.identifier).sort()).toEqual(ids.slice().sort());
  });

  it("fetchRawIssuesByIdentifiers makes zero requests when the identifier list is empty", async () => {
    let count = 0;
    server.use(
      http.post(LINEAR_GRAPHQL, () => {
        count += 1;
        return HttpResponse.json({ data: {} });
      }),
    );

    const result = await fetchRawIssuesByIdentifiers("test-key", []);
    expect(count).toBe(0);
    expect(result).toEqual([]);
  });
});
