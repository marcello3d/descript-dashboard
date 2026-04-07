import { Octokit } from "@octokit/rest";
import type { GitHubPR } from "@/types";

export interface GitHubResult {
  prs: GitHubPR[];
  rateLimit?: { cost: number; remaining: number; limit: number; resetAt: string };
}

// Two-phase approach to minimize GraphQL rate limit cost:
// 1. Cheap search query to get node IDs only (~1 point)
// 2. Batch node() lookups for full PR details (~1 point per 100 nodes)
// Total: ~7 points for 70 PRs vs ~450 with the original single query
export async function fetchAuthoredPRs(
  accessToken: string
): Promise<GitHubResult> {
  const octokit = new Octokit({ auth: accessToken });

  // Phase 1: Get node IDs via search (minimal fields = low cost)
  const searchResult: any = await octokit.graphql(`
    query {
      open: search(query: "is:open is:pr author:@me", type: ISSUE, first: 50) {
        nodes { ... on PullRequest { id } }
      }
      merged: search(query: "is:merged is:pr author:@me sort:updated", type: ISSUE, first: 20) {
        nodes { ... on PullRequest { id } }
      }
      rateLimit { cost remaining limit resetAt }
    }
  `);

  const seen = new Set<string>();
  const allIds: string[] = [];
  for (const node of [...searchResult.open.nodes, ...searchResult.merged.nodes]) {
    if (node.id && !seen.has(node.id)) {
      seen.add(node.id);
      allIds.push(node.id);
    }
  }

  let totalCost = searchResult.rateLimit?.cost ?? 0;
  let lastRl = searchResult.rateLimit;

  // Phase 2: Fetch full details via node() lookups in batches
  // node() is a top-level scalar lookup, not a connection — costs 1 per batch
  const BATCH_SIZE = 20;
  const allPrs: GitHubPR[] = [];

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const fields = batch.map((id, idx) =>
      `pr${idx}: node(id: "${id}") { ... on PullRequest {
        databaseId title isDraft merged url updatedAt reviewDecision
        additions deletions changedFiles headRefName
        repository { nameWithOwner }
      }}`
    ).join("\n");

    const result: any = await octokit.graphql(
      `query { ${fields} rateLimit { cost remaining limit resetAt } }`
    );
    totalCost += result.rateLimit?.cost ?? 0;
    lastRl = result.rateLimit ?? lastRl;

    for (let j = 0; j < batch.length; j++) {
      const pr = result[`pr${j}`];
      if (!pr?.databaseId) continue;
      allPrs.push({
        id: pr.databaseId,
        title: pr.title,
        repo: pr.repository.nameWithOwner,
        branch: pr.headRefName,
        draft: pr.isDraft,
        merged: pr.merged,
        url: pr.url,
        updatedAt: pr.updatedAt,
        reviewDecision: pr.reviewDecision,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changedFiles ?? 0,
        checksState: null,
      });
    }
  }

  let rateLimit: GitHubResult["rateLimit"];
  if (lastRl) {
    rateLimit = {
      cost: totalCost,
      remaining: lastRl.remaining,
      limit: lastRl.limit,
      resetAt: lastRl.resetAt,
    };
    console.log(`[GitHub] Total cost: ${totalCost} (1 search + ${Math.ceil(allIds.length / BATCH_SIZE)} node batches) | ${lastRl.remaining}/${lastRl.limit} remaining`);
  }

  return { prs: allPrs, rateLimit };
}
