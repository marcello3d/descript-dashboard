import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { sync } from "@/lib/sync";
import {
  getWorkItems,
  getReviewItems,
  addWorkItemTag,
  removeWorkItemTag,
  resetSyncStatus,
} from "@/lib/db";
import { invalidateCache } from "@/lib/cache";
import { errorMessage } from "@/lib/errors";
import { fetchWorkflowStatesForIssue, updateIssueStatus } from "@/lib/linear";
import { createAgent, transformAgent } from "@/lib/cursor";

// ---------------------------------------------------------------------------
// Per-request MCP server factory (SDK requires one McpServer per transport)
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "descript-dashboard", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.registerTool("get_work_items", {
    description:
      "Fetch work items (Linear issues, GitHub PRs, Cursor agents). Set fresh=true to bypass caches and re-fetch from all APIs.",
    inputSchema: {
      fresh: z.boolean().optional().default(false),
    },
  }, async (args) => {
    const errors: string[] = [];
    try {
      const result = await sync({ force: args.fresh });
      errors.push(...result.errors);
    } catch (e) {
      errors.push(`sync: ${errorMessage(e)}`);
    }
    const items = getWorkItems();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ items, errors }) }],
    };
  });

  server.registerTool("get_reviews", {
    description:
      "Fetch PRs you've been asked to review. Set fresh=true to bypass caches and re-fetch from APIs.",
    inputSchema: {
      fresh: z.boolean().optional().default(false),
    },
  }, async (args) => {
    const errors: string[] = [];
    try {
      const result = await sync({ force: args.fresh });
      errors.push(...result.errors);
    } catch (e) {
      errors.push(`sync: ${errorMessage(e)}`);
    }
    const reviewItems = getReviewItems();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ reviewItems, errors }) }],
    };
  });

  server.registerTool("add_tag", {
    description: "Add a tag to a work item.",
    inputSchema: {
      workItemId: z.string().describe("UUID of the work item"),
      tag: z.string().describe("Tag to add"),
    },
  }, async (args) => {
    const tags = addWorkItemTag(args.workItemId, args.tag);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ tags }) }],
    };
  });

  server.registerTool("remove_tag", {
    description: "Remove a tag from a work item.",
    inputSchema: {
      workItemId: z.string().describe("UUID of the work item"),
      tag: z.string().describe("Tag to remove"),
    },
  }, async (args) => {
    const tags = removeWorkItemTag(args.workItemId, args.tag);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ tags }) }],
    };
  });

  server.registerTool("update_issue_status", {
    description: "Change a Linear issue's workflow state.",
    inputSchema: {
      issueId: z.string().describe("Linear issue UUID (internal ID, not the identifier like MM-123)"),
      stateId: z.string().describe("Target workflow state UUID (get options from get_workflow_states)"),
    },
  }, async (args) => {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "LINEAR_API_KEY not configured" }) }],
        isError: true,
      };
    }
    try {
      const result = await updateIssueStatus(apiKey, args.issueId, args.stateId);
      invalidateCache("linear:raw:issues");
      invalidateCache("linear:raw:reviews");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: errorMessage(e) }) }],
        isError: true,
      };
    }
  });

  server.registerTool("get_workflow_states", {
    description: "List available workflow states for a Linear issue. Use to get stateId values for update_issue_status.",
    inputSchema: {
      issueId: z.string().describe("Linear issue UUID"),
    },
  }, async (args) => {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "LINEAR_API_KEY not configured" }) }],
        isError: true,
      };
    }
    try {
      const states = await fetchWorkflowStatesForIssue(apiKey, args.issueId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ states }) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: errorMessage(e) }) }],
        isError: true,
      };
    }
  });

  server.registerTool("create_cursor_agent", {
    description: "Spawn a new Cursor background agent.",
    inputSchema: {
      repository: z.string().describe("GitHub repo in owner/repo format"),
      ref: z.string().describe("Git ref (branch name or SHA)"),
      prompt: z.string().describe("Task prompt for the agent"),
    },
  }, async (args) => {
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "CURSOR_API_KEY not configured" }) }],
        isError: true,
      };
    }
    try {
      const raw = await createAgent(apiKey, args.repository, args.ref, args.prompt);
      resetSyncStatus("cursor");
      const agent = transformAgent(raw);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ agent }) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: errorMessage(e) }) }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Stateless HTTP Transport — new server + transport per request
// ---------------------------------------------------------------------------

async function handleMcpRequest(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}
