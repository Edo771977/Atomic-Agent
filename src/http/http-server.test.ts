import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHttpServer } from "./http-server.js";
import { sendJson } from "./request-context.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("http-server", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("returns 404 with an OpenAI-shaped error for unknown routes", async () => {
    const response = await fetch(`${harness.baseUrl}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/no route/i);
  });

  it("requires a key for the model catalog and operator API", async () => {
    const secured = await startTestHarness({ apiKey: "secret" });
    try {
      for (const [method, path] of [
        ["GET", "/v1/models"],
        ["GET", "/api/sessions"],
        ["GET", "/api/events"],
        ["GET", "/api/memory/changes"],
        ["POST", "/api/project/decision"],
        ["POST", "/api/project/backlog"],
        ["POST", "/api/project/lessons"],
        ["POST", "/api/approval/resolve"],
        ["PATCH", "/api/config"],
        ["POST", "/api/project-trust"],
        ["POST", "/api/skills/install"],
        ["POST", "/api/question/answer"],
        ["POST", "/api/tasks"],
        ["POST", "/api/webhooks/example"],
      ]) {
        const response = await fetch(`${secured.baseUrl}${path}`, { method });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
      const response = await fetch(`${secured.baseUrl}/v1/models`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      expect(body.data[0]?.id).toBe("atomic-agent");
    } finally {
      await secured.cleanup();
    }
  });

  it("refuses to build a server with no key unless told it is meant to have none", async () => {
    const base = {
      runtime: harness.runtime,
      host: "127.0.0.1",
      port: 0,
      routes: [],
    };
    await expect(createHttpServer({ ...base, apiKey: null })).rejects.toThrow(/API key is required/);
    await expect(createHttpServer({ ...base, apiKey: "   " })).rejects.toThrow(/empty/);
  });

  it("close() stops accepting new connections", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/models`);
    expect(response.status).toBe(200);
    await response.body?.cancel();
    await harness.handle.close();
    expect(harness.handle.server.listening).toBe(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    await expect(
      fetch(`${harness.baseUrl}/v1/models`, { signal: controller.signal }),
    ).rejects.toThrow();
    clearTimeout(timer);
  });
});

describe("http-server networkServe (issue #33)", () => {
  async function probe(options: { host: string; networkServe?: boolean }): Promise<boolean> {
    const handle = await createHttpServer({
      runtime: {} as never,
      host: options.host,
      port: 0,
      apiKey: null,
      unauthenticated: true,
      ...(options.networkServe === undefined ? {} : { networkServe: options.networkServe }),
      routes: [{ method: "GET", path: "/probe", handler: async (_req, res, ctx) => sendJson(res, 200, { networkServe: ctx.networkServe === true }) }],
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/probe`);
      return ((await response.json()) as { networkServe: boolean }).networkServe;
    } finally {
      await handle.close();
    }
  }

  it("treats a loopback listener as local unless the host says it is reachable from the network", async () => {
    expect(await probe({ host: "127.0.0.1" })).toBe(false);
    // The webhook tunnel gateway: loopback, but cloudflared exposes it to the internet.
    expect(await probe({ host: "127.0.0.1", networkServe: true })).toBe(true);
  });
});
