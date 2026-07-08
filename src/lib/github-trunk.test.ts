import { describe, expect, it } from "vitest";
import { parseTrunkComment, trunkStatusFromComments } from "./github-trunk";

// Bodies below are trimmed from real trunk-io[bot] comments.
const DETAILS = "https://app.trunk.io/descript-inc/merge-queue/ee875a38-2b1c-4480-a1f6-692869aa4f0d";

const AWAITING = `<!-- Trunk Merge -->
Merging to \`main\` in this repository is managed by Trunk.

<!-- Start PR Submit Checkbox -->
- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.

After your PR is submitted to the merge queue, this comment will be automatically updated with its status.`;

const SUBMITTED = `✨ Submitted to Merge by @marcello3d. It will be added to the merge queue once all branch protection rules pass and there are no merge conflicts with the target branch. See more details [here](${DETAILS}/36048).`;

const WAITING_BATCH = `⏳ Waiting to start tests on this pull request - [details](${DETAILS}/35717). This PR is currently waiting to form a batch.`;

const TESTING = `🧪 Running tests on this pull request (testing on PR [#36072](https://www.github.com/descriptinc/descript/pull/36072)) - [details](${DETAILS}/36036).`;

const MERGED = `😎 Merged successfully - [details](${DETAILS}/36017).`;

const FAILED = `❌ This pull request failed tests. It has been removed from the merge queue. PR [#36071](https://www.github.com/descriptinc/descript/pull/36071) was used for testing. See more details [here](${DETAILS}/35975).
|Failed Required Status|Conclusion|
|-|-|
|ai-workers-required-tests|[Failure](https://github.com/descriptinc/descript/actions/runs/28960227284)|
<!-- Start PR Submit Checkbox -->
- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`;

const CANCELED = `🚫 This pull request was requested to be canceled by @yazan-descript, so it was removed from the merge queue. See more details [here](${DETAILS}/35536).
<!-- Start PR Submit Checkbox -->
- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`;

describe("parseTrunkComment", () => {
  it("parses the awaiting (submittable) state", () => {
    const s = parseTrunkComment(AWAITING);
    expect(s).toMatchObject({ state: "awaiting", canSubmit: true, detailsUrl: null });
  });

  it("parses the submitted (waiting for checks) state", () => {
    const s = parseTrunkComment(SUBMITTED);
    expect(s).toMatchObject({ state: "submitted", canSubmit: false });
    expect(s?.detailsUrl).toContain("app.trunk.io");
  });

  it("parses the waiting-for-a-batch state", () => {
    expect(parseTrunkComment(WAITING_BATCH)).toMatchObject({ state: "waiting_batch", canSubmit: false });
  });

  it("parses the testing state", () => {
    expect(parseTrunkComment(TESTING)).toMatchObject({ state: "testing", canSubmit: false });
  });

  it("parses the merged state", () => {
    expect(parseTrunkComment(MERGED)).toMatchObject({ state: "merged", canSubmit: false });
  });

  it("parses the failed state, which stays re-submittable", () => {
    expect(parseTrunkComment(FAILED)).toMatchObject({ state: "failed", canSubmit: true });
  });

  it("parses the canceled state, which stays re-submittable", () => {
    expect(parseTrunkComment(CANCELED)).toMatchObject({ state: "canceled", canSubmit: true });
  });

  it("returns null for non-trunk comments", () => {
    expect(parseTrunkComment("Looks good to me! 🚀")).toBeNull();
    expect(parseTrunkComment("")).toBeNull();
    expect(parseTrunkComment(null)).toBeNull();
  });
});

describe("trunkStatusFromComments", () => {
  it("finds the trunk-io comment among others", () => {
    const s = trunkStatusFromComments([
      { author: "descript-eng-bot", body: "CI summary" },
      { author: "linear-code", body: "linked issue" },
      { author: "trunk-io", body: TESTING },
    ]);
    expect(s).toMatchObject({ state: "testing" });
  });

  it("matches the REST [bot] login suffix too", () => {
    const s = trunkStatusFromComments([{ author: "trunk-io[bot]", body: MERGED }]);
    expect(s).toMatchObject({ state: "merged" });
  });

  it("returns null when no trunk comment is present", () => {
    expect(trunkStatusFromComments([{ author: "someone", body: "hi" }])).toBeNull();
  });
});
