import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Issue #33: `serve --host <network address>` sends replies off this
 * machine. A session in a constrained folder whose allowedEgress lacks
 * "serve" is refused over such a server; a loopback server is unchanged.
 */
describe("serve on a network host with per-folder constraints", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const chat = (h: Harness, stream = false) =>
    fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local", stream, messages: [{ role: "user", content: "acme figures?" }] }),
    });

  it("refuses a chat turn and the session's routes for a constrained folder without \"serve\"", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    for (const stream of [false, true]) {
      const res = await chat(harness, stream);
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain("serve");
      expect(body).not.toContain("hi back");
    }
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save(session);
    const read = await fetch(`${harness.baseUrl}/api/sessions/${session.id}`);
    expect(read.status).toBe(403);
    const exported = await fetch(`${harness.baseUrl}/api/sessions/${session.id}/export`);
    expect(exported.status).toBe(403);
  });

  it("serves it with \"serve\" in allowedEgress, and on a loopback host", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"], allowedEgress: ["serve"] } } });
    expect((await chat(harness)).status).not.toBe(403);
    await harness.cleanup();
    harness = await startTestHarness({ constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    expect((await chat(harness)).status).not.toBe(403);
  });

  it("refuses an AG-UI run for a constrained folder without \"serve\" before the turn", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const res = await fetch(`${harness.baseUrl}/api/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "agui-x", runId: "r1", messages: [{ id: "u", role: "user", content: "acme figures?" }] }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("serve");
    expect(harness.runtime.sessionStore.load("agui-x")?.turns ?? []).toEqual([]);
  });

  it("leaves a restricted session's lines out of GET /api/sessions/search", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save({
      ...session,
      turns: [
        { kind: "user", text: "what are the acme figures for march?", at: 1 },
        { kind: "assistant_reply", text: "Acme made 4M in march.", at: 2 },
      ],
      updatedAt: session.updatedAt + 1,
    });
    const res = await fetch(`${harness.baseUrl}/api/sessions/search?q=acme%20march&scope=all`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ sessionId: string }> };
    expect(body.hits.map((h) => h.sessionId)).not.toContain(session.id);
  });
});

