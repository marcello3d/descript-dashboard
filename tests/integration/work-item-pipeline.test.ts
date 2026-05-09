import { describe, expect, it } from "vitest";
import { transformIssues } from "@/lib/linear";
import { transformPRs } from "@/lib/github";
import { transformAgents } from "@/lib/cursor";
import {
  buildWorkItems,
  findMissingCursorAgentIds,
  findMissingLinearIds,
  findMissingPrUrls,
} from "@/lib/work-items";
import {
  auroraActiveAgents,
  auroraInactiveAgent,
  auroraIssues,
  auroraPrs,
  FIXTURES,
} from "../fixtures/aurora";

// Drives the Linear/GitHub/Cursor raw responses through the same transform
// + buildWorkItems pipeline that sync.ts runs, and asserts the linkages a
// user would see in the dashboard. Fixtures are JSON-shaped Raw* records,
// the same shape we'd cache from the live APIs (see RawLinearIssue,
// RawGitHubPR, RawCursorAgent).
describe("work-item pipeline (Aurora Labs scenario)", () => {
  it("links all three issues correctly after the missing-agent backfill phase", () => {
    const issues = transformIssues(auroraIssues);
    const prs = transformPRs(auroraPrs);
    let agents = transformAgents(auroraActiveAgents);

    // First build — the CSV-export agent isn't in the active list yet, so
    // PR #1421 can't be bridged to DASH-412 from agent data alone.
    let items = buildWorkItems(issues, prs, agents);
    const dashFirst = items.find((i) => i.linear?.identifier === FIXTURES.issues.dash);
    expect(dashFirst).toBeDefined();
    expect(dashFirst!.prs).toHaveLength(0);
    expect(dashFirst!.agents).toHaveLength(0);

    // Sync would now compute missing cursor-agent ids from Linear comments.
    const knownAgentIds = new Set(agents.map((a) => a.id));
    const missingIds = findMissingCursorAgentIds(items, knownAgentIds);
    expect(missingIds).toEqual([FIXTURES.agents.csvExport]);

    // Backfill the missing agent (this is the /v0/agents/{id} lookup).
    agents = transformAgents([...auroraActiveAgents, auroraInactiveAgent]);
    items = buildWorkItems(issues, prs, agents);

    const dash = items.find((i) => i.linear?.identifier === FIXTURES.issues.dash)!;
    expect(dash.prs.map((p) => p.id)).toEqual([9001]);
    expect(dash.agents.map((a) => a.id)).toEqual([FIXTURES.agents.csvExport]);

    const api = items.find((i) => i.linear?.identifier === FIXTURES.issues.api)!;
    expect(api.prs.map((p) => p.id)).toEqual([9002]);
    expect(api.agents.map((a) => a.id)).toEqual([FIXTURES.agents.rateLimit]);

    const etl = items.find((i) => i.linear?.identifier === FIXTURES.issues.etl)!;
    expect(etl.prs.map((p) => p.id)).toEqual([9003]);

    // PR 9004 has no linkage to any issue and stays as an orphan item.
    const orphan = items.find((i) => !i.linear && i.prs.some((p) => p.id === 9004));
    expect(orphan).toBeDefined();

    // Each PR appears under exactly one work item — no duplicates.
    const prAppearances = new Map<number, number>();
    for (const item of items) {
      for (const pr of item.prs) {
        prAppearances.set(pr.id, (prAppearances.get(pr.id) ?? 0) + 1);
      }
    }
    for (const [, count] of prAppearances) expect(count).toBe(1);
  });

  it("findMissingPrUrls reports Linear-attached PRs that we haven't fetched yet", () => {
    const issues = transformIssues(auroraIssues);
    // Pretend GitHub returned only #1418 (the ETL backfill PR). API-89
    // has its PR attached in Linear, so #1430 should surface as missing.
    const prs = transformPRs(auroraPrs.filter((p) => p.id === 9003));
    const items = buildWorkItems(issues, prs, []);
    const known = new Set(prs.map((p) => p.url));
    expect(findMissingPrUrls(items, known)).toEqual([
      `https://github.com/aurora-labs/aurora/pull/${FIXTURES.prs.rateLimit}`,
    ]);
  });

  it("findMissingLinearIds extracts identifiers from PR titles when no Linear issue is attached", () => {
    const items = buildWorkItems(
      [],
      transformPRs(auroraPrs.filter((p) => p.id === 9003)),
      [],
    );
    const missing = findMissingLinearIds(items, new Set());
    expect(missing).toContain(FIXTURES.issues.etl);
  });
});
