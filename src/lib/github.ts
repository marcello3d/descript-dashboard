import { Octokit } from "@octokit/rest";
import type { GitHubPR } from "@/types";

const QUERY = `
  query {
    search(query: "is:open is:pr author:@me", type: ISSUE, first: 50) {
      nodes {
        ... on PullRequest {
          id
          databaseId
          title
          isDraft
          url
          updatedAt
          reviewDecision
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

export async function fetchAuthoredPRs(
  accessToken: string
): Promise<GitHubPR[]> {
  const octokit = new Octokit({ auth: accessToken });

  const result: any = await octokit.graphql(QUERY);

  return result.search.nodes
    .filter((node: any) => node.id) // filter empty nodes
    .map((pr: any) => ({
      id: pr.databaseId,
      title: pr.title,
      repo: pr.repository.nameWithOwner,
      draft: pr.isDraft,
      url: pr.url,
      updatedAt: pr.updatedAt,
      reviewDecision: pr.reviewDecision,
    }));
}
