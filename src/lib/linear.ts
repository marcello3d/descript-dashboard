import { LinearClient } from "@linear/sdk";
import type { LinearIssue } from "@/types";

export async function fetchAssignedIssues(
  apiKey: string
): Promise<LinearIssue[]> {
  const client = new LinearClient({ apiKey });
  const viewer = await client.viewer;
  const issues = await viewer.assignedIssues({
    first: 50,
    filter: {
      state: {
        type: { nin: ["completed", "canceled"] },
      },
    },
  });

  const result: LinearIssue[] = [];
  for (const issue of issues.nodes) {
    const state = await issue.state;

    // Fetch attachments to find linked GitHub PRs
    const attachments = await issue.attachments();
    const prUrls: string[] = [];
    for (const att of attachments.nodes) {
      if (att.url && att.url.includes("github.com") && att.url.includes("/pull/")) {
        prUrls.push(att.url);
      }
    }

    result.push({
      id: issue.id,
      title: issue.title,
      identifier: issue.identifier,
      status: state?.name ?? "Unknown",
      priority: issue.priority,
      url: issue.url,
      updatedAt: issue.updatedAt.toISOString(),
      prUrls,
    });
  }
  return result;
}
