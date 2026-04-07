import { Octokit } from "@octokit/rest";
import type { GitHubPR } from "@/types";

const PR_FRAGMENT = `
  ... on PullRequest {
    id
    databaseId
    title
    isDraft
    merged
    url
    updatedAt
    reviewDecision
    additions
    deletions
    changedFiles
    headRefName
    repository {
      nameWithOwner
    }
  }
`;

const QUERY = `
  query {
    open: search(query: "is:open is:pr author:@me", type: ISSUE, first: 50) {
      nodes { ${PR_FRAGMENT} }
    }
    merged: search(query: "is:merged is:pr author:@me sort:updated", type: ISSUE, first: 20) {
      nodes { ${PR_FRAGMENT} }
    }
  }
`;


export interface GitHubResult {
  prs: GitHubPR[];
  rateLimit?: { remaining: number; limit: number; resetAt: string };
}

export async function fetchAuthoredPRs(
  accessToken: string
): Promise<GitHubResult> {
  const octokit = new Octokit({ auth: accessToken });

  const result: any = await octokit.graphql(QUERY);

  // Fetch rate limit info
  let rateLimit: GitHubResult["rateLimit"];
  try {
    const rl = await octokit.rest.rateLimit.get();
    const graphql = rl.data.resources.graphql;
    if (graphql) {
      const resetDate = new Date(graphql.reset * 1000);
      rateLimit = { remaining: graphql.remaining, limit: graphql.limit, resetAt: resetDate.toISOString() };
      console.log(`[GitHub] Rate limit: ${graphql.remaining}/${graphql.limit} remaining, resets at ${resetDate.toLocaleTimeString()}`);
    }
  } catch {
    // ignore
  }

  const all = [...result.open.nodes, ...result.merged.nodes];

  // Deduplicate by id
  const seen = new Set<number>();
  const prs: GitHubPR[] = all
    .filter((node: any) => node.id)
    .filter((pr: any) => {
      if (seen.has(pr.databaseId)) return false;
      seen.add(pr.databaseId);
      return true;
    })
    .map((pr: any) => ({
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
    }));

  return { prs, rateLimit };
}
