import { describe, expect, it, vi } from "vitest";

// Keep the module import free of better-sqlite3 side effects.
vi.mock("@/lib/cache", () => ({
  getCached: () => null,
  setCache: () => {},
}));

import type { Octokit } from "@octokit/rest";
import {
  computeMergeReadiness,
  enrichMergeReadiness,
  graphqlErrorData,
  type BranchRules,
  type CheckContextNode,
  type PullRequestReadinessData,
} from "./github-merge-readiness";
import type { RawGitHubPR } from "./github";

// octokit.graphql throws this shape when the response carries errors — the
// partial `data` payload rides along on the error object.
class FakeGraphqlResponseError extends Error {
  name = "GraphqlResponseError";
  data: unknown;
  constructor(data: unknown) {
    super("Request failed due to following response errors");
    this.data = data;
  }
}

const TRUNK_AWAITING_COMMENT = `<!-- Trunk Merge -->
Merging to \`main\` in this repository is managed by Trunk.

<!-- Start PR Submit Checkbox -->
- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`;

function makePr(overrides: Partial<RawGitHubPR> = {}): RawGitHubPR {
  return {
    id: 1,
    title: "Test PR",
    userLogin: "marcello3d",
    owner: "descriptinc",
    repo: "descript",
    branch: "feature",
    baseBranch: "main",
    draft: false,
    merged: false,
    state: "open",
    url: "https://github.com/descriptinc/descript/pull/36048",
    updatedAt: "2026-07-09T00:00:00Z",
    mergedAt: null,
    body: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviews: [],
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<PullRequestReadinessData> = {}): PullRequestReadinessData {
  return {
    headRefOid: "abc123",
    isDraft: false,
    merged: false,
    closed: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [] },
    ...overrides,
  };
}

const RULES: BranchRules = {
  requiredStatusChecks: [{ context: "test" }, { context: "lint" }],
  requiredApprovingReviewCount: 1,
  requiresCodeOwnerReview: false,
  requiresReviewThreadResolution: true,
};

describe("graphqlErrorData", () => {
  it("salvages partial data from a GraphqlResponseError", () => {
    const data = { repository: { pullRequest: null } };
    expect(graphqlErrorData(new FakeGraphqlResponseError(data))).toBe(data);
  });

  it("returns null for plain errors", () => {
    expect(graphqlErrorData(new Error("boom"))).toBeNull();
  });

  it("returns null when the error carries no data", () => {
    expect(graphqlErrorData(new FakeGraphqlResponseError(null))).toBeNull();
    expect(graphqlErrorData(null)).toBeNull();
  });
});

describe("computeMergeReadiness", () => {
  it("treats CLEAN merge state as required-checks-passing when per-check data is unavailable", () => {
    // No contexts at all — the check-runs API 403'd (fine-grained PAT without Checks: read).
    const readiness = computeMergeReadiness(makePr(), makePullRequest(), RULES, []);
    expect(readiness.requiredChecksState).toBe("SUCCESS");
    expect(readiness.ready).toBe(true);
    expect(readiness.reasons).toEqual([]);
  });

  it("keeps required checks pending for BLOCKED merge state", () => {
    const readiness = computeMergeReadiness(
      makePr(),
      makePullRequest({ mergeStateStatus: "BLOCKED" }),
      RULES,
      []
    );
    expect(readiness.requiredChecksState).toBe("PENDING");
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain("required checks pending");
  });

  it("does not let CLEAN override an observed check failure", () => {
    const failing: CheckContextNode[] = [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", checkSuite: null },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: null },
    ];
    const readiness = computeMergeReadiness(makePr(), makePullRequest(), RULES, failing);
    expect(readiness.requiredChecksState).toBe("FAILURE");
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain("required checks failing");
  });

  it("survives null reviewThreads from a partial GraphQL payload", () => {
    const readiness = computeMergeReadiness(
      makePr(),
      makePullRequest({ reviewThreads: null }),
      RULES,
      []
    );
    expect(readiness.ready).toBe(true);
  });

  it("still requires review approval", () => {
    const readiness = computeMergeReadiness(
      makePr(),
      makePullRequest({ reviewDecision: "REVIEW_REQUIRED" }),
      RULES,
      []
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain("review required");
  });
});

describe("enrichMergeReadiness with a partial GraphQL response", () => {
  // Simulates the exact production failure: the readiness query throws with
  // FORBIDDEN errors on check-run nodes but full data otherwise, and the REST
  // check-runs endpoint 403s. Trunk status and readiness must both survive.
  it("salvages trunk status and readiness when check data is forbidden", async () => {
    const partialData = {
      repository: {
        pullRequest: makePullRequest({
          comments: {
            nodes: [{ author: { login: "trunk-io" }, body: TRUNK_AWAITING_COMMENT }],
          },
        }),
      },
    };
    const rulesPayload = [
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } },
      { type: "pull_request", parameters: { required_approving_review_count: 1 } },
    ];
    const fakeOctokit = {
      graphql: async () => {
        throw new FakeGraphqlResponseError(partialData);
      },
      request: async (route: string) => {
        if (route.includes("/rules/branches/")) return { data: rulesPayload };
        if (route.includes("check-runs")) {
          const error = new Error("Resource not accessible by personal access token") as Error & { status: number };
          error.status = 403;
          throw error;
        }
        if (route.includes("/status")) return { data: { statuses: [] } };
        throw new Error(`unexpected route: ${route}`);
      },
    } as unknown as Octokit;

    const pr = makePr({ reviewDecision: null });
    await enrichMergeReadiness(fakeOctokit, [pr]);

    expect(pr.trunk?.state).toBe("awaiting");
    expect(pr.trunk?.canSubmit).toBe(true);
    expect(pr.reviewDecision).toBe("APPROVED");
    expect(pr.mergeReadiness?.ready).toBe(true);
    expect(pr.checksState).toBe("SUCCESS");
  });
});
