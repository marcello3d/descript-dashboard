import { describe, expect, it } from "vitest";
import {
  createAgent,
  fetchRawAgentById,
  fetchRawAgents,
  fetchRawAgentsByIds,
  transformAgent,
} from "@/lib/cursor";
import {
  auroraActiveAgents,
  auroraInactiveAgent,
  FIXTURES,
} from "../fixtures/aurora";
import { http, HttpResponse, server } from "../msw";

const API = "https://api.cursor.com";

describe("Cursor API (HTTP-level via MSW)", () => {
  it("fetchRawAgents returns the active agents list from /v0/agents", async () => {
    server.use(
      http.get(`${API}/v0/agents`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        return HttpResponse.json({ agents: auroraActiveAgents });
      }),
    );

    const agents = await fetchRawAgents("test-key");
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(FIXTURES.agents.rateLimit);
  });

  it("fetchRawAgents returns [] when the response omits the agents field", async () => {
    server.use(
      http.get(`${API}/v0/agents`, () => HttpResponse.json({})),
    );

    expect(await fetchRawAgents("test-key")).toEqual([]);
  });

  it("fetchRawAgents throws on non-OK responses", async () => {
    server.use(
      http.get(`${API}/v0/agents`, () =>
        new HttpResponse(null, { status: 500, statusText: "Internal Server Error" }),
      ),
    );

    await expect(fetchRawAgents("test-key")).rejects.toThrow(/500/);
  });

  it("fetchRawAgentById returns the agent fetched by id", async () => {
    server.use(
      http.get(`${API}/v0/agents/:id`, ({ params }) => {
        expect(params.id).toBe(FIXTURES.agents.csvExport);
        return HttpResponse.json(auroraInactiveAgent);
      }),
    );

    const agent = await fetchRawAgentById("test-key", FIXTURES.agents.csvExport);
    expect(agent?.id).toBe(FIXTURES.agents.csvExport);
    expect(agent?.target?.prUrl).toContain(`/pull/${FIXTURES.prs.csvExport}`);
  });

  it("fetchRawAgentById returns null on 404", async () => {
    server.use(
      http.get(`${API}/v0/agents/:id`, () =>
        new HttpResponse(null, { status: 404, statusText: "Not Found" }),
      ),
    );

    expect(await fetchRawAgentById("test-key", "missing")).toBeNull();
  });

  it("fetchRawAgentById throws on other non-OK responses", async () => {
    server.use(
      http.get(`${API}/v0/agents/:id`, () =>
        new HttpResponse(null, { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expect(fetchRawAgentById("test-key", "any")).rejects.toThrow(/502/);
  });

  it("fetchRawAgentsByIds returns [] for an empty input without making any HTTP call", async () => {
    server.use(
      http.get(`${API}/v0/agents/:id`, () => {
        throw new Error("should not be called");
      }),
    );

    expect(await fetchRawAgentsByIds("test-key", [])).toEqual([]);
  });

  it("createAgent posts the prompt + repo to /v0/agents and returns the new agent", async () => {
    server.use(
      http.post(`${API}/v0/agents`, async ({ request }) => {
        const body = (await request.json()) as {
          prompt: { text: string };
          source: { repository: string; ref: string };
        };
        expect(body.prompt.text).toBe("Backfill user_id on legacy events");
        expect(body.source.repository).toBe("https://github.com/aurora-labs/aurora");
        expect(body.source.ref).toBe("main");
        return HttpResponse.json(auroraInactiveAgent);
      }),
    );

    const created = await createAgent(
      "test-key",
      "aurora-labs/aurora",
      "main",
      "Backfill user_id on legacy events",
    );
    expect(created.id).toBe(FIXTURES.agents.csvExport);
  });

  it("createAgent surfaces error bodies in the thrown message", async () => {
    server.use(
      http.post(`${API}/v0/agents`, () =>
        new HttpResponse("rate limited", { status: 429, statusText: "Too Many Requests" }),
      ),
    );

    await expect(
      createAgent("test-key", "aurora-labs/aurora", "main", "anything"),
    ).rejects.toThrow(/429.*rate limited/);
  });

  it("createAgent reports a clean error when the body can't be read", async () => {
    server.use(
      http.post(`${API}/v0/agents`, () =>
        new HttpResponse(null, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expect(
      createAgent("test-key", "aurora-labs/aurora", "main", "anything"),
    ).rejects.toThrow(/503/);
  });

  it("fetchRawAgentsByIds skips ids whose lookup fails and keeps the rest", async () => {
    server.use(
      http.get(`${API}/v0/agents/:id`, ({ params }) => {
        if (params.id === FIXTURES.agents.csvExport) {
          return HttpResponse.json(auroraInactiveAgent);
        }
        return new HttpResponse(null, { status: 500, statusText: "boom" });
      }),
    );

    const agents = await fetchRawAgentsByIds("test-key", [
      FIXTURES.agents.csvExport,
      "doesnt-exist",
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(FIXTURES.agents.csvExport);
  });
});

describe("transformAgent defaults", () => {
  it("supplies sane defaults when optional fields are missing", () => {
    const out = transformAgent({ id: "agent-only" });
    expect(out).toEqual({
      id: "agent-only",
      name: "",
      status: "unknown",
      repo: "",
      branch: "",
      url: "https://cursor.com/agents/agent-only",
      prUrl: null,
      createdAt: "",
      linesAdded: 0,
      linesRemoved: 0,
      filesChanged: 0,
    });
  });
});
