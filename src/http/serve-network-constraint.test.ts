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

  it("lists no idea built from a restricted session on GET /api/ideas or its refresh", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save(session);
    const store = harness.runtime.taskStore;
    const t = store.create({ userMessage: "send the acme figures", origin: "cli", maxAttempts: 1, sessionId: session.id });
    store.markRunning(t.id);
    store.markFailed(t.id, { category: "transport", message: "provider timed out" });
    const refreshed = await fetch(`${harness.baseUrl}/api/ideas/refresh`, { method: "POST" });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).not.toContain("acme");
    const listed = await fetch(`${harness.baseUrl}/api/ideas`);
    expect(await listed.text()).not.toContain("acme");
  });

  // Issue #74 item 9: task prompts and errors are the session's content.
  it("withholds a restricted session's tasks on /api/tasks, /api/tasks/{id} and /runs", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save(session);
    const store = harness.runtime.taskStore;
    const t = store.create({ userMessage: "send the acme figures", origin: "cli", maxAttempts: 1, sessionId: session.id });
    store.markRunning(t.id);
    store.markFailed(t.id, { category: "transport", message: "acme provider timed out" });
    const orphan = store.create({ userMessage: "acme orphan task", origin: "cli", maxAttempts: 1 });
    const list = await fetch(`${harness.baseUrl}/api/tasks`);
    expect(list.status).toBe(200);
    expect(await list.text()).not.toContain("acme");
    const bySession = await fetch(`${harness.baseUrl}/api/tasks?session=${session.id}`);
    expect(await bySession.text()).not.toContain("acme");
    for (const id of [t.id, orphan.id]) {
      for (const path of [`/api/tasks/${id}`, `/api/tasks/${id}/runs`]) {
        const res = await fetch(`${harness.baseUrl}${path}`);
        expect(res.status, path).toBe(403);
        expect(await res.text(), path).not.toContain("acme");
      }
      for (const path of [`/api/tasks/${id}/pause`, `/api/tasks/${id}/run`]) {
        const res = await fetch(`${harness.baseUrl}${path}`, { method: "POST" });
        expect(res.status, path).toBe(403);
      }
      expect((await fetch(`${harness.baseUrl}/api/tasks/${id}`, { method: "DELETE" })).status).toBe(403);
    }
    const created = await fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, userMessage: "more acme" }),
    });
    expect(created.status).toBe(403);
  });

  it("still lists tasks with \"serve\" in allowedEgress", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"], allowedEgress: ["serve"] } } });
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save(session);
    const t = harness.runtime.taskStore.create({ userMessage: "acme ok", origin: "cli", maxAttempts: 1, sessionId: session.id });
    expect(await (await fetch(`${harness.baseUrl}/api/tasks`)).text()).toContain("acme ok");
    expect((await fetch(`${harness.baseUrl}/api/tasks/${t.id}`)).status).toBe(200);
  });

  it("blanks a restricted session's title, error, goal and next step on GET /api/sessions", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save({ ...session, lastError: "acme error", metadata: { ...session.metadata, title: "Acme figures" } });
    const res = await fetch(`${harness.baseUrl}/api/sessions?scope=all`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(session.id);
    expect(text.toLowerCase()).not.toContain("acme");
    const row = ((JSON.parse(text) as { sessions: Array<Record<string, unknown>> }).sessions).find((s) => s.id === session.id);
    expect(row?.restricted).toBe(true);
  });

  // Issue #74 review: a task with no session runs in the server's folder; only that folder's policy hides it.
  it("shows a session-less task when only another folder is constrained", async () => {
    harness = await startTestHarness({ host: "0.0.0.0", constraints: { "/elsewhere-constrained": { allowedProviders: ["local-llama"] } } });
    const t = harness.runtime.taskStore.create({ userMessage: "acme orphan task", origin: "cli", maxAttempts: 1 });
    expect(await (await fetch(`${harness.baseUrl}/api/tasks`)).text()).toContain("acme orphan task");
    expect((await fetch(`${harness.baseUrl}/api/tasks/${t.id}`)).status).toBe(200);
  });
});
