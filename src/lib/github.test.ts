import { describe, expect, it, vi } from "vitest";

// Keep the module import free of better-sqlite3 side effects.
vi.mock("@/lib/cache", () => ({
  getCached: () => null,
  setCache: () => {},
}));

import { transformPR, type RawGitHubPR } from "./github";

function makeRaw(overrides: Partial<RawGitHubPR> = {}): RawGitHubPR {
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
    url: "https://github.com/descriptinc/descript/pull/36752",
    updatedAt: "2026-07-14T00:00:00Z",
    mergedAt: null,
    body: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviews: [],
    ...overrides,
  };
}

describe("transformPR bot approval gate", () => {
  it("keeps APPROVED for a human-authored PR with a single approval", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "marcello3d",
        reviewDecision: "APPROVED",
        reviews: [{ login: "someone", state: "APPROVED" }],
      })
    );
    expect(pr.reviewDecision).toBe("APPROVED");
  });

  it("downgrades a bot PR with only one human approval to REVIEW_REQUIRED", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "claude[bot]",
        reviewDecision: "APPROVED",
        reviews: [{ login: "human-a", state: "APPROVED" }],
      })
    );
    expect(pr.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("keeps APPROVED for a bot PR once two distinct humans approve", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "claude[bot]",
        reviewDecision: "APPROVED",
        reviews: [
          { login: "human-a", state: "APPROVED" },
          { login: "human-b", state: "APPROVED" },
        ],
      })
    );
    expect(pr.reviewDecision).toBe("APPROVED");
  });

  it("does not count bot approvals toward the two-human requirement", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "claude[bot]",
        reviewDecision: "APPROVED",
        reviews: [
          { login: "human-a", state: "APPROVED" },
          { login: "cursor[bot]", state: "APPROVED" },
        ],
      })
    );
    expect(pr.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("counts a reviewer only once even if they approve multiple times", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "claude[bot]",
        reviewDecision: "APPROVED",
        reviews: [
          { login: "human-a", state: "APPROVED" },
          { login: "human-a", state: "APPROVED" },
        ],
      })
    );
    expect(pr.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("uses each reviewer's latest state (a later re-approval counts)", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "claude[bot]",
        reviewDecision: "APPROVED",
        reviews: [
          { login: "human-a", state: "APPROVED" },
          { login: "human-b", state: "CHANGES_REQUESTED" },
          { login: "human-b", state: "APPROVED" },
        ],
      })
    );
    expect(pr.reviewDecision).toBe("APPROVED");
  });

  it("leaves CHANGES_REQUESTED on a bot PR untouched", () => {
    const pr = transformPR(
      makeRaw({
        userLogin: "claude[bot]",
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [{ login: "human-a", state: "CHANGES_REQUESTED" }],
      })
    );
    expect(pr.reviewDecision).toBe("CHANGES_REQUESTED");
  });
});
