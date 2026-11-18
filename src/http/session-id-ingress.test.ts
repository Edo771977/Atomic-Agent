import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Issue #74 item 8: a client-chosen session id becomes a file name
 * (trace, archived turns), so every ingress refuses one that is not a
 * plain token before anything runs.
 */
describe("session id ingress validation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startTestHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${h.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("chat completions refuses a traversing session_id with 400 and the param", async () => {
    const r = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "hello" }],
      session_id: "../../escape",
    });
    expect(r.status).toBe(400);
    const json = (await r.json()) as { error: { param: string | null } };
    expect(json.error.param).toBe("session_id");
    expect(readdirSync(h.stateDir)).not.toContain("escape.ndjson");
    expect(existsSync(join(h.stateDir, "..", "escape.ndjson"))).toBe(false);
  });

  it("chat completions refuses a traversing session id header", async () => {
    const r = await post(
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "hello" }] },
      { "x-atomic-session-id": "../y" },
    );
    expect(r.status).toBe(400);
  });

  it("chat completions still accepts a plain id", async () => {
    const r = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "hello" }],
      session_id: "my-chat_1",
    });
    expect(r.status).toBe(200);
  });

  it("AG-UI refuses a traversing threadId", async () => {
    const r = await post("/api/ag-ui", {
      threadId: "../t",
      runId: "r1",
      messages: [{ id: "m", role: "user", content: "hi" }],
    });
    expect(r.status).toBe(400);
  });

  it("/api/sessions/{id} routes refuse an unsafe id with 400", async () => {
    const r = await fetch(`${h.baseUrl}/api/sessions/..%2F..%2Fx`);
    expect(r.status).toBe(400);
    const json = (await r.json()) as { error: { param: string | null } };
    expect(json.error.param).toBe("id");
    const r2 = await fetch(`${h.baseUrl}/api/sessions/s-unknown`);
    expect(r2.status).toBe(404);
  });

  it("opens an imported chat whose id has a colon, on its routes and as a session_id", async () => {
    const id = "claude-code:6f1d0c3a-9b7e-4a52-8c1d-2e3f4a5b6c7d";
    h.runtime.sessionStore.save({ ...h.runtime.createSession({ persist: false }), id });
    const r = await fetch(`${h.baseUrl}/api/sessions/${encodeURIComponent(id)}`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { id: string }).id).toBe(id);
    const chat = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hello" }], session_id: id });
    expect(chat.status).toBe(200);
  });
});
