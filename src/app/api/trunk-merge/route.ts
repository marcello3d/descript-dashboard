import { Octokit } from "@octokit/rest";
import { resetSyncStatus } from "@/lib/db";
import { errorMessage } from "@/lib/errors";
import { getEnv } from "@/lib/env";

// Posts a `/trunk merge` comment on a PR, submitting it to the Trunk merge queue.
export async function POST(request: Request) {
  const token = getEnv("GITHUB_TOKEN");
  if (!token) {
    return Response.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const prUrl: unknown = body?.prUrl;
  const match =
    typeof prUrl === "string"
      ? prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
      : null;
  if (!match) {
    return Response.json({ error: "Valid prUrl required" }, { status: 400 });
  }

  const [, owner, repo, number] = match;
  try {
    const octokit = new Octokit({ auth: token });
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: Number(number),
      body: "/trunk merge",
    });
    // Force the next work-items sync to re-fetch GitHub so the new queue state shows.
    resetSyncStatus("github");
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 502 });
  }
}
