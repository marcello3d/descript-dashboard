import { describe, expect, it } from "vitest";
import type { CursorAgent, GitHubPR, LinearIssue, WorkItem } from "@/types";
import {
  buildReviewItems,
  buildWorkItems,
  findMissingCursorAgentIds,
  findMissingLinearIds,
  findMissingPrUrls,
  getLastUpdated,
  getLastUpdatedSource,
} from "./work-items";

// All identifiers/URLs below belong to the fictional "Aurora Labs"
// analytics SaaS; see tests/fixtures/aurora.ts for the longer story.
const ORG = "aurora-labs";
const REPO = "aurora";
const ghPr = (n: number) => `https://github.com/${ORG}/${REPO}/pull/${n}`;
const cursorUrl = (id: string) => `https://cursor.com/agents/${id}`;

function makeIssue(over: Partial<LinearIssue> = {}): LinearIssue {
  const identifier = over.identifier ?? "DASH-412";
  return {
    id: `linear-${identifier}`,
    title: "Add CSV export to revenue dashboard",
    identifier,
    status: "In Progress",
    statusType: "started",
    priority: 2,
    url: `https://linear.app/aurora/issue/${identifier}`,
    updatedAt: "2026-04-22T19:51:25.703Z",
    prUrls: [],
    cursorAgentUrls: [],
    ...over,
  };
}

function makePr(over: Partial<GitHubPR> = {}): GitHubPR {
  const id = over.id ?? 1421;
  return {
    id,
    title: "Add CSV export to revenue dashboard",
    author: "alex.chen",
    authorLogin: "alex-chen",
    repo: `${ORG}/${REPO}`,
    branch: "alex-cursor/csv-export-7f31",
    baseBranch: "main",
    draft: false,
    merged: false,
    closed: false,
    url: ghPr(id),
    updatedAt: "2026-04-27T18:29:57Z",
    mergedAt: null,
    additions: 134,
    deletions: 0,
    changedFiles: 12,
    reviewDecision: null,
    checksState: null,
    requestedReviewers: [],
    requestedTeams: [],
    bugBotThreadCount: 0,
    bugBotThreadUrls: [],
    slackThreadUrl: null,
    claudeSessionUrl: null,
    mergeReadiness: {
      ready: false,
      state: "unknown",
      reasons: [],
      mergeable: null,
      mergeStateStatus: null,
      requiredChecksState: null,
      requiredChecks: [],
    },
    ...over,
  };
}

function makeAgent(over: Partial<CursorAgent> = {}): CursorAgent {
  const id = over.id ?? "bc-csv-dash412-7f31";
  return {
    id,
    name: "CSV export for revenue dashboard",
    status: "FINISHED",
    repo: `${ORG}/${REPO}`,
    branch: "alex-cursor/csv-export-7f31",
    url: cursorUrl(id),
    prUrl: null,
    createdAt: "2026-04-19T14:02:33Z",
    linesAdded: 134,
    linesRemoved: 0,
    filesChanged: 12,
    ...over,
  };
}

describe("buildWorkItems — PR matching", () => {
  it("links a PR to an issue via Linear's prUrls", () => {
    const issue = makeIssue({ identifier: "API-89", prUrls: [ghPr(1430)] });
    const pr = makePr({
      id: 1430,
      title: "per-workspace event rate limiting",
      branch: "alex/rate-limit",
    });
    const items = buildWorkItems([issue], [pr], []);
    expect(items).toHaveLength(1);
    expect(items[0].linear?.identifier).toBe("API-89");
    expect(items[0].prs.map((p) => p.id)).toEqual([1430]);
  });

  it("links a PR to an issue via identifier in PR title/branch", () => {
    const issue = makeIssue({ identifier: "ETL-203" });
    const pr = makePr({
      id: 1418,
      title: "ETL-203 backfill user_id on legacy events table",
      branch: "alex/etl-203-backfill",
    });
    const items = buildWorkItems([issue], [pr], []);
    expect(items[0].prs).toHaveLength(1);
  });

  it("links a PR via a bridging Cursor agent referenced in Linear comments", () => {
    const issue = makeIssue({
      identifier: "DASH-412",
      cursorAgentUrls: [cursorUrl("bc-csv-dash412-7f31")],
    });
    const pr = makePr({
      id: 1421,
      title: "Add CSV export to revenue dashboard",
      branch: "alex-cursor/csv-export-7f31",
    });
    const agent = makeAgent({
      id: "bc-csv-dash412-7f31",
      prUrl: ghPr(1421),
      branch: "alex-cursor/csv-export-7f31",
    });
    const items = buildWorkItems([issue], [pr], [agent]);
    const linked = items.find((i) => i.linear?.identifier === "DASH-412");
    expect(linked).toBeDefined();
    expect(linked!.prs.map((p) => p.id)).toEqual([1421]);
    expect(linked!.agents.map((a) => a.id)).toEqual(["bc-csv-dash412-7f31"]);
  });

  it("links a PR via a bridging agent whose branch contains the issue identifier", () => {
    const issue = makeIssue({ identifier: "DASH-412" });
    const pr = makePr({
      id: 1421,
      title: "csv export work",
      branch: "alex/no-id-branch",
    });
    const agent = makeAgent({
      id: "bc-csv-dash412-7f31",
      prUrl: ghPr(1421),
      branch: "agent/dash-412-csv-export",
    });
    const items = buildWorkItems([issue], [pr], [agent]);
    const linked = items.find((i) => i.linear?.identifier === "DASH-412");
    expect(linked!.prs.map((p) => p.id)).toEqual([1421]);
  });

  it("does not link via agent when neither attachment nor identifier match", () => {
    const issue = makeIssue({ identifier: "DASH-412" });
    const pr = makePr({ id: 1421, title: "no identifier", branch: "no-id" });
    const agent = makeAgent({ prUrl: ghPr(1421), branch: "no-id" });
    const items = buildWorkItems([issue], [pr], [agent]);
    const orphan = items.find((i) => !i.linear && i.prs[0]?.id === 1421);
    expect(orphan).toBeDefined();
  });

  it("creates an orphan work item for a PR that matches nothing", () => {
    const pr = makePr({ id: 1442, title: "Bump postgres client to 8.11", branch: "alex/bump-pg" });
    const items = buildWorkItems([], [pr], []);
    expect(items).toHaveLength(1);
    expect(items[0].linear).toBeUndefined();
    expect(items[0].prs.map((p) => p.id)).toEqual([1442]);
  });

  it("strategy-3 PR-via-agent skips orphan items and ignores agents whose prUrl doesn't match", () => {
    // Issue is present but won't match either PR. Two unmatched PRs, each
    // with a bridging agent — for the second PR, strategy 3 has to iterate
    // past the first PR's orphan entry (testing the !item.linear continue).
    const issue = makeIssue({ identifier: "DASH-412" });
    const prA = makePr({ id: 1421, title: "no id A", branch: "no-id-a" });
    const prB = makePr({ id: 1430, title: "no id B", branch: "no-id-b" });
    const agentForA = makeAgent({ id: "agent-a", prUrl: ghPr(1421), branch: "noise-a" });
    const agentForB = makeAgent({ id: "agent-b", prUrl: ghPr(1430), branch: "noise-b" });
    const items = buildWorkItems([issue], [prA, prB], [agentForA, agentForB]);

    const issueItem = items.find((i) => i.linear?.identifier === "DASH-412");
    expect(issueItem!.prs).toHaveLength(0);
    expect(items.some((i) => !i.linear && i.prs[0]?.id === 1421)).toBe(true);
    expect(items.some((i) => !i.linear && i.prs[0]?.id === 1430)).toBe(true);
  });

  it("only links a PR once even when multiple strategies could match", () => {
    const issue = makeIssue({ identifier: "API-89", prUrls: [ghPr(1430)] });
    const pr = makePr({
      id: 1430,
      title: "API-89: per-workspace event rate limiting",
      branch: "alex/api-89-rate-limit",
    });
    const items = buildWorkItems([issue], [pr], []);
    expect(items[0].prs).toHaveLength(1);
  });
});

describe("buildWorkItems — agent matching", () => {
  it("attaches an agent to an issue via its already-matched PR", () => {
    const issue = makeIssue({ identifier: "API-89", prUrls: [ghPr(1430)] });
    const pr = makePr({ id: 1430 });
    const agent = makeAgent({
      id: "bc-rl-api89-2a90",
      prUrl: ghPr(1430),
      branch: "no-id",
    });
    const items = buildWorkItems([issue], [pr], [agent]);
    const linked = items.find((i) => i.linear?.identifier === "API-89");
    expect(linked!.agents.map((a) => a.id)).toEqual(["bc-rl-api89-2a90"]);
  });

  it("attaches an agent to an issue via Linear cursorAgentUrls when no PR exists yet", () => {
    const issue = makeIssue({
      identifier: "DASH-412",
      cursorAgentUrls: [cursorUrl("bc-csv-dash412-7f31")],
    });
    const agent = makeAgent({
      id: "bc-csv-dash412-7f31",
      prUrl: null,
      branch: "no-id",
    });
    const items = buildWorkItems([issue], [], [agent]);
    const linked = items.find((i) => i.linear?.identifier === "DASH-412");
    expect(linked!.agents.map((a) => a.id)).toEqual(["bc-csv-dash412-7f31"]);
  });

  it("matches a Cursor URL even when stored as www.cursor.com (id-based match)", () => {
    const issue = makeIssue({
      identifier: "DASH-412",
      cursorAgentUrls: ["https://www.cursor.com/agents/bc-csv-dash412-7f31"],
    });
    const agent = makeAgent({ id: "bc-csv-dash412-7f31", prUrl: null });
    const items = buildWorkItems([issue], [], [agent]);
    const linked = items.find((i) => i.linear?.identifier === "DASH-412");
    expect(linked!.agents.map((a) => a.id)).toEqual(["bc-csv-dash412-7f31"]);
  });

  it("attaches an agent to an issue via identifier in branch/name", () => {
    const issue = makeIssue({ identifier: "DASH-412" });
    const agent = makeAgent({
      id: "agent-1",
      prUrl: null,
      branch: "feature/dash-412-csv",
    });
    const items = buildWorkItems([issue], [], [agent]);
    const linked = items.find((i) => i.linear?.identifier === "DASH-412");
    expect(linked!.agents.map((a) => a.id)).toEqual(["agent-1"]);
  });

  it("creates an orphan work item for an agent that matches nothing", () => {
    const agent = makeAgent({
      id: "agent-1",
      name: "explore pricing-page experiment hooks",
      branch: "alex-cursor/pricing-experiments",
    });
    const items = buildWorkItems([], [], [agent]);
    expect(items).toHaveLength(1);
    expect(items[0].agents.map((a) => a.id)).toEqual(["agent-1"]);
    expect(items[0].title).toBe("explore pricing-page experiment hooks");
  });

  it("falls back to agent id when name is empty for orphan title", () => {
    const agent = makeAgent({ id: "agent-1", name: "" });
    const items = buildWorkItems([], [], [agent]);
    expect(items[0].title).toBe("agent-1");
  });

  it("does not match agent.prUrl null to existing PRs", () => {
    const issue = makeIssue({ identifier: "API-89", prUrls: [ghPr(1430)] });
    const pr = makePr({ id: 1430 });
    const agent = makeAgent({
      id: "agent-1",
      prUrl: null,
      branch: "unrelated",
    });
    const items = buildWorkItems([issue], [pr], [agent]);
    const issueItem = items.find((i) => i.linear?.identifier === "API-89");
    expect(issueItem!.agents).toHaveLength(0);
    const orphanAgent = items.find((i) => !i.linear && i.agents.some((a) => a.id === "agent-1"));
    expect(orphanAgent).toBeDefined();
  });
});

describe("buildWorkItems — sort order", () => {
  it("sorts by most recent activity descending", () => {
    const oldIssue = makeIssue({
      identifier: "ETL-203",
      updatedAt: "2025-12-01T00:00:00.000Z",
    });
    const recentIssue = makeIssue({
      identifier: "DASH-412",
      updatedAt: "2026-04-22T00:00:00.000Z",
    });
    const items = buildWorkItems([oldIssue, recentIssue], [], []);
    expect(items.map((i) => i.linear?.identifier)).toEqual(["DASH-412", "ETL-203"]);
  });
});

describe("getLastUpdated", () => {
  it("returns the latest date among linear/prs/agents", () => {
    const item: WorkItem = {
      id: "x",
      title: "t",
      linear: makeIssue({ updatedAt: "2026-04-22T00:00:00.000Z" }),
      prs: [makePr({ updatedAt: "2026-04-27T00:00:00.000Z" })],
      agents: [makeAgent({ createdAt: "2026-04-19T00:00:00.000Z" })],
      tags: [],
    };
    expect(getLastUpdated(item)).toBe("2026-04-27T00:00:00.000Z");
  });

  it("returns empty string when no sources have dates", () => {
    const item: WorkItem = { id: "x", title: "t", prs: [], agents: [], tags: [] };
    expect(getLastUpdated(item)).toBe("");
  });
});

describe("getLastUpdatedSource", () => {
  it("returns the source with the latest date", () => {
    const item: WorkItem = {
      id: "x",
      title: "t",
      linear: makeIssue({ updatedAt: "2026-04-22T00:00:00.000Z" }),
      prs: [makePr({ updatedAt: "2026-04-27T00:00:00.000Z" })],
      agents: [makeAgent({ createdAt: "2026-04-19T00:00:00.000Z" })],
      tags: [],
    };
    expect(getLastUpdatedSource(item)).toEqual({
      date: "2026-04-27T00:00:00.000Z",
      source: "GitHub",
    });
  });

  it("returns Linear when only the issue has a date", () => {
    const item: WorkItem = {
      id: "x",
      title: "t",
      linear: makeIssue({ updatedAt: "2026-04-22T00:00:00.000Z" }),
      prs: [],
      agents: [],
      tags: [],
    };
    expect(getLastUpdatedSource(item)?.source).toBe("Linear");
  });

  it("returns Cursor when only an agent has a date", () => {
    const item: WorkItem = {
      id: "x",
      title: "t",
      prs: [],
      agents: [makeAgent({ createdAt: "2026-04-19T00:00:00.000Z" })],
      tags: [],
    };
    expect(getLastUpdatedSource(item)?.source).toBe("Cursor");
  });

  it("ignores PRs/agents with empty dates", () => {
    const item: WorkItem = {
      id: "x",
      title: "t",
      prs: [makePr({ updatedAt: "" })],
      agents: [makeAgent({ createdAt: "" })],
      tags: [],
    };
    expect(getLastUpdatedSource(item)).toBeNull();
  });
});

describe("findMissingPrUrls", () => {
  it("returns Linear-referenced PR URLs that aren't already known", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        linear: makeIssue({ prUrls: [ghPr(1421), ghPr(1430)] }),
        prs: [],
        agents: [],
        tags: [],
      },
    ];
    const missing = findMissingPrUrls(items, new Set([ghPr(1421)]));
    expect(missing).toEqual([ghPr(1430)]);
  });

  it("skips items that already have PRs attached", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        linear: makeIssue({ prUrls: [ghPr(1421)] }),
        prs: [makePr({ id: 1421 })],
        agents: [],
        tags: [],
      },
    ];
    expect(findMissingPrUrls(items, new Set())).toEqual([]);
  });

  it("returns an empty list when there is no Linear issue", () => {
    const items: WorkItem[] = [{ id: "a", title: "t", prs: [], agents: [], tags: [] }];
    expect(findMissingPrUrls(items, new Set())).toEqual([]);
  });
});

describe("findMissingCursorAgentIds", () => {
  it("returns agent IDs referenced in Linear but missing from the known set", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        linear: makeIssue({
          cursorAgentUrls: [
            cursorUrl("bc-rl-api89-2a90"),
            "https://www.cursor.com/agents/bc-csv-dash412-7f31",
          ],
        }),
        prs: [],
        agents: [],
        tags: [],
      },
    ];
    const missing = findMissingCursorAgentIds(
      items,
      new Set(["bc-rl-api89-2a90"]),
    );
    expect(missing).toEqual(["bc-csv-dash412-7f31"]);
  });

  it("ignores items without a Linear issue", () => {
    const items: WorkItem[] = [{ id: "a", title: "t", prs: [], agents: [], tags: [] }];
    expect(findMissingCursorAgentIds(items, new Set())).toEqual([]);
  });

  it("ignores Linear cursor URLs that don't parse to an agent id", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        linear: makeIssue({ cursorAgentUrls: ["https://cursor.com/dashboard"] }),
        prs: [],
        agents: [],
        tags: [],
      },
    ];
    expect(findMissingCursorAgentIds(items, new Set())).toEqual([]);
  });

  it("dedupes ids referenced by multiple issues", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        linear: makeIssue({
          identifier: "DASH-412",
          cursorAgentUrls: [cursorUrl("bc-csv-dash412-7f31")],
        }),
        prs: [],
        agents: [],
        tags: [],
      },
      {
        id: "b",
        title: "t",
        linear: makeIssue({
          identifier: "DASH-413",
          cursorAgentUrls: [cursorUrl("bc-csv-dash412-7f31")],
        }),
        prs: [],
        agents: [],
        tags: [],
      },
    ];
    expect(findMissingCursorAgentIds(items, new Set())).toEqual(["bc-csv-dash412-7f31"]);
  });
});

describe("findMissingLinearIds", () => {
  it("collects identifiers referenced in PR/agent text but not in known issues", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        prs: [
          makePr({
            id: 1418,
            title: "ETL-203 backfill",
            branch: "alex/etl-203-backfill",
          }),
        ],
        agents: [
          makeAgent({
            id: "agent-x",
            branch: "agent/api-89-fix",
            name: "API-89 patch",
          }),
        ],
        tags: [],
      },
    ];
    const missing = findMissingLinearIds(items, new Set(["etl-203"]));
    expect(missing.sort()).toEqual(["API-89"]);
  });

  it("skips items that already have a Linear issue attached", () => {
    const items: WorkItem[] = [
      {
        id: "a",
        title: "t",
        linear: makeIssue({ identifier: "DASH-412" }),
        prs: [makePr({ title: "Refs API-89 in body" })],
        agents: [],
        tags: [],
      },
    ];
    expect(findMissingLinearIds(items, new Set())).toEqual([]);
  });
});

describe("buildReviewItems", () => {
  it("matches a review PR to an issue via Linear prUrls", () => {
    const pr = makePr({ id: 1430 });
    const issue = makeIssue({ identifier: "API-89", prUrls: [ghPr(1430)] });
    const items = buildReviewItems([pr], [issue], "alex-chen");
    expect(items[0].linear?.identifier).toBe("API-89");
  });

  it("falls back to identifier match in PR text", () => {
    const pr = makePr({
      id: 1430,
      title: "API-89 fix",
      branch: "alex/api-89-rate-limit",
    });
    const issue = makeIssue({ identifier: "API-89" });
    const items = buildReviewItems([pr], [issue], "alex-chen");
    expect(items[0].linear?.identifier).toBe("API-89");
  });

  it("classifies as individual when viewer is a requested reviewer", () => {
    const pr = makePr({ id: 1430, requestedReviewers: ["alex-chen"] });
    const items = buildReviewItems([pr], [], "alex-chen");
    expect(items[0].requestType).toBe("individual");
    expect(items[0].linear).toBeUndefined();
  });

  it("classifies as team when viewer is not directly requested", () => {
    const pr = makePr({ id: 1430, requestedReviewers: ["priya-shah"] });
    const items = buildReviewItems([pr], [], "alex-chen");
    expect(items[0].requestType).toBe("team");
  });

  it("classifies as team when viewerLogin is empty", () => {
    const pr = makePr({ id: 1430, requestedReviewers: ["alex-chen"] });
    const items = buildReviewItems([pr], [], "");
    expect(items[0].requestType).toBe("team");
  });
});
