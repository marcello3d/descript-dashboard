import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
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
import { fetchWorkflowStatesForIssue, updateIssueStatus } from "@/lib/linear";
import { createAgent, transformAgent } from "@/lib/cursor";

const PORT = 4081;

// ---------------------------------------------------------------------------
// Per-session MCP server factory (SDK requires one McpServer per transport)
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
    } catch (e: any) {
      errors.push(`sync: ${e.message}`);
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
    } catch (e: any) {
      errors.push(`sync: ${e.message}`);
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
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }],
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
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }],
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
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Transport + Session Management
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
    onsessionclosed: (id) => {
      transports.delete(id);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
});
