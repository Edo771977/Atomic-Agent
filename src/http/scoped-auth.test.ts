import { approvalActors } from "../approval/approval-actors.js";
import { approvalEventPayload } from "./route-approval.js";
import { startTestHarness } from "./test-harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpServer, type HttpServerHandle, type RouteDefinition } from "./http-server.js";
import type { HttpRole } from "./http-scopes.js";
import { AuthThrottle } from "./auth-throttle.js";
import { buildRouteTable } from "./route-table.js";
import { addHttpToken, createHttpTokenSource, removeHttpToken, hashHttpToken, type StoredHttpToken } from "./http-token-store.js";
import { sendJson } from "./request-context.js";
import { authorizeRequest, identifyCaller } from "./scoped-auth.js";

/**
 * ATO-583: the 401 / 403 matrix on a real server with stub routes. The
 * runtime is never touched by these handlers.
 */
const KEY = "k".repeat(32);
const TOKENS: Record<HttpRole, string> = {
  admin: "atag_admin-token-0000000000000000",
  operator: "atag_operator-token-000000000000",
  member: "atag_member-token-000000000000000",
  viewer: "atag_viewer-token-000000000000000",
};

function stored(role: HttpRole): StoredHttpToken {
  return { name: `${role}-laptop`, role, sha256: hashHttpToken(TOKENS[role]), createdAt: "2026-11-18T00:00:00.000Z" };
}

const ok = (_req: unknown, res: Parameters<RouteDefinition["handler"]>[1]): void => sendJson(res, 200, { ok: true });
const ROUTES: RouteDefinition[] = [
  { method: "GET", path: "/open", handler: ok, requiresAuth: false },
  { method: "GET", path: "/read", handler: ok, scope: "read" },
  { method: "POST", path: "/chat", handler: ok, scope: "chat" },
  { method: "POST", path: "/admin", handler: ok, scope: "admin" },
  { method: "POST", path: "/decide", handler: ok, scope: "decide" },
  // An unclassified route is owner-only.
  { method: "POST", path: "/untagged", handler: ok },
];

const servers: HttpServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(apiKey: string | null, named: StoredHttpToken[]): Promise<string> {
  const handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey,
    routes: ROUTES,
    namedTokens: () => named,
  });
  servers.push(handle);
  return `http://127.0.0.1:${handle.port}`;
}

async function call(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; code: string | null; message: string }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (method !== "GET") {
    init.body = "{}";
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(`${base}${path}`, init);
  const body = (await res.json()) as { error?: { code: string | null; message: string } };
  return { status: res.status, code: body.error?.code ?? null, message: body.error?.message ?? "" };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const ALL = [stored("admin"), stored("operator"), stored("member"), stored("viewer")];

describe("scoped auth: roles against route scopes", () => {
  const matrix: Array<[HttpRole | "key", string, string, number]> = [
    ["key", "GET", "/read", 200],
    ["key", "POST", "/chat", 200],
    ["key", "POST", "/admin", 200],
    ["key", "POST", "/untagged", 200],
    ["admin", "GET", "/read", 200],
    ["admin", "POST", "/chat", 200],
    ["admin", "POST", "/admin", 200],
    ["admin", "POST", "/untagged", 403],
    ["admin", "POST", "/decide", 200],
    ["operator", "POST", "/decide", 200],
    ["operator", "POST", "/admin", 403],
    ["member", "POST", "/decide", 403],
    ["viewer", "POST", "/decide", 403],
    ["member", "GET", "/read", 200],
    ["member", "POST", "/chat", 200],
    ["member", "POST", "/admin", 403],
    ["member", "POST", "/untagged", 403],
    ["viewer", "GET", "/read", 200],
    ["viewer", "POST", "/chat", 403],
    ["viewer", "POST", "/admin", 403],
    ["viewer", "POST", "/untagged", 403],
  ];

  it.each(matrix)("%s on %s %s answers %i", async (who, method, path, status) => {
    const base = await start(KEY, ALL);
    const token = who === "key" ? KEY : TOKENS[who];
    expect((await call(base, method, path, bearer(token))).status).toBe(status);
  });

  it("a 403 describes the role, route and missing scope", async () => {
    const base = await start(KEY, ALL);
    const out = await call(base, "POST", "/admin", bearer(TOKENS.viewer));
    expect(out.status).toBe(403);
    expect(out.code).toBe("insufficient_scope");
    expect(out.message).toBe(
      'Token has the viewer role and cannot use POST /admin: it needs the admin scope',
    );
  });

  it("an unknown or missing token is 401, never 403", async () => {
    const base = await start(KEY, ALL);
    expect(await call(base, "GET", "/read", bearer("atag_nope"))).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect(await call(base, "GET", "/read")).toMatchObject({ status: 401, code: "invalid_api_key" });
  });

  it("accepts a named token as x-api-key, like the serve key", async () => {
    const base = await start(KEY, ALL);
    expect((await call(base, "POST", "/chat", { "x-api-key": TOKENS.member })).status).toBe(200);
    expect((await call(base, "POST", "/admin", { "x-api-key": TOKENS.member })).status).toBe(403);
  });

  it("an open route stays open with named tokens on", async () => {
    const base = await start(KEY, ALL);
    expect((await call(base, "GET", "/open")).status).toBe(200);
  });

  it("applies scope on registered routes and revokes the persisted token on the next request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atag-live-tokens-"));
    try {
      const viewer = addHttpToken(dir, "reader", "viewer");
      if (!viewer.ok) throw new Error(viewer.error);
      const handle = await createHttpServer({
        runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: KEY,
        routes: buildRouteTable().map(route => ({ ...route, handler: ok })),
        namedTokens: createHttpTokenSource(dir),
      });
      servers.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      expect((await call(base, "GET", "/v1/models", bearer(viewer.token))).status).toBe(200);
      expect((await call(base, "GET", "/v1/models")).status).toBe(401);
      expect((await call(base, "POST", "/api/project/backlog", bearer(viewer.token))).code).toBe("insufficient_scope");
      expect((await call(base, "POST", "/api/project/backlog", bearer(KEY))).status).toBe(200);
      expect(removeHttpToken(dir, "reader").ok).toBe(true);
      expect((await call(base, "GET", "/v1/models", bearer(viewer.token))).status).toBe(401);
      expect((await call(base, "GET", "/v1/models", bearer(KEY))).status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["read", "admin"] as const)("named authentication keeps failed attempts for %s routes", (scope) => {
    const throttle = new AuthThrottle({ maxFailures: 2 });
    const writeHead = vi.fn();
    const res = { writeHead, end: vi.fn() } as unknown as ServerResponse;
    const request = (token: string) => authorizeRequest({
      headers: bearer(token), socket: { remoteAddress: "192.0.2.8" },
    } as IncomingMessage, res, { apiKey: KEY, namedTokens: () => ALL, scope, route: "GET /test" }, throttle);
    request("unknown");
    request(TOKENS.viewer);
    request("unknown");
    request(TOKENS.viewer);
    expect(writeHead.mock.calls.at(-1)?.[0]).toBe(429);
  });

  it("counts unknown tokens against the network throttle before reading the registry", () => {
    const throttle = new AuthThrottle({ maxFailures: 1 });
    const req = {
      headers: bearer("atag_unknown"), socket: { remoteAddress: "192.0.2.4" },
    } as IncomingMessage;
    const namedTokens = vi.fn(() => ALL);
    const input = { apiKey: KEY, namedTokens, scope: "read" as const, route: "GET /read" };
    const writeHead = vi.fn();
    const res = { writeHead, end: vi.fn() } as unknown as ServerResponse;
    expect(authorizeRequest(req, res, input, throttle)).toBe(false);
    expect(writeHead.mock.calls.at(-1)?.[0]).toBe(401);
    expect(authorizeRequest(req, res, input, throttle)).toBe(false);
    expect(writeHead.mock.calls.at(-1)?.[0]).toBe(429);
    expect(namedTokens).toHaveBeenCalledTimes(1);
  });
});

describe("scoped auth: backward compatibility", () => {
  it("one key and no named tokens: the key opens every route, anything else is 401", async () => {
    const base = await start(KEY, []);
    for (const [method, path] of [["GET", "/read"], ["POST", "/chat"], ["POST", "/admin"], ["POST", "/untagged"]] as const) {
      expect((await call(base, method, path, bearer(KEY))).status).toBe(200);
      expect((await call(base, method, path, bearer(TOKENS.admin))).status).toBe(401);
      expect((await call(base, method, path)).status).toBe(401);
    }
  });

  it("rejects keyless production startup even when named tokens exist", async () => {
    await expect(start(null, ALL)).rejects.toThrow("an API key is required");
  });

  it("no namedTokens option at all behaves like an empty list", async () => {
    const handle = await createHttpServer({ runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: KEY, routes: ROUTES });
    servers.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await call(base, "POST", "/admin", bearer(KEY))).status).toBe(200);
    expect((await call(base, "POST", "/admin", bearer(TOKENS.admin))).status).toBe(401);
  });
});

describe("identifyCaller", () => {
  it("the serve key is the owner", () => {
    expect(identifyCaller(KEY, KEY, () => ALL)).toEqual({ name: "api-key", role: "owner" });
  });

  it("finds a named token by its hash and refuses empty or unknown values", () => {
    expect(identifyCaller(TOKENS.member, KEY, () => ALL)).toEqual({ name: "member-laptop", role: "member" });
    expect(identifyCaller("", KEY, () => ALL)).toBeNull();
    expect(identifyCaller(null, KEY, () => ALL)).toBeNull();
    expect(identifyCaller(hashHttpToken(TOKENS.member), KEY, () => ALL)).toBeNull();
  });
});

it("labels an approval emitted by a named turn without showing its credential", async () => {
  const h = await startTestHarness({ approvalLevel: 1 });
  try {
    const session = h.runtime.createSession();
    let observed: ReturnType<typeof approvalEventPayload> | undefined;
    h.approvalBus.subscribe(request => {
      observed = approvalEventPayload(request, h.runtime.approvals);
      h.runtime.approvals.resolve({ approvalId: request.approvalId, approved: false });
    });
    await approvalActors.run({
      sessionId: session.id, requestedByToken: "member-test", steeredByTokens: new Set(["steerer-test"]),
    }, () => h.runtime.approvals.request({ sessionId: session.id, tool: "test", category: "shell", reason: "confirmation" }));
    expect(observed).toMatchObject({ requestedByToken: "member-test", steeredByTokens: ["steerer-test"] });
    expect(observed?.reason).toContain("richiesto dal token member-test");
    expect(JSON.stringify(observed)).not.toContain(TOKENS.member);
  } finally {
    await h.cleanup();
  }
});

it("passes the named actor into both chat turns and accepted steers", async () => {
  const h = await startTestHarness({ apiKey: KEY, namedTokens: () => ALL });
  try {
    const chat = vi.spyOn(h.runtime, "runTurn");
    const headers = { ...bearer(TOKENS.member), "content-type": "application/json" };
    const response = await fetch(h.baseUrl + "/v1/chat/completions", {
      method: "POST", headers, body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    expect(chat.mock.calls[0]?.[2]).toMatchObject({ origin: "http", requestedByToken: "member-laptop" });
    const session = h.runtime.createSession({ persist: true });
    h.runtime.steeringInbox.open(session.id);
    const steer = vi.spyOn(h.runtime, "steer");
    expect((await fetch(h.baseUrl + `/api/sessions/${session.id}/steer`, {
      method: "POST", headers, body: JSON.stringify({ text: "change" }),
    })).status).toBe(200);
    expect(steer).toHaveBeenCalledWith(session.id, "change", "member-laptop");
  } finally {
    await h.cleanup();
  }
});

it("requires admin for persistent and trust-config approvals, without consuming them", async () => {
  const h = await startTestHarness({ apiKey: KEY, approvalLevel: 1, namedTokens: () => ALL });
  try {
    const session = h.runtime.createSession();
    for (const [category, decision] of [["shell", "allow-always"], ["trust_config", "allow-once"]] as const) {
      const pending = h.runtime.approvals.request({
        sessionId: session.id, tool: "os.shell.run", category, reason: "test",
        commandShape: "git", commandArgv: ["git", "status"], workdir: h.workingDir,
        approvalId: category,
      });
      const resolve = (role: HttpRole) => fetch(h.baseUrl + "/api/approval/resolve", {
        method: "POST", headers: { ...bearer(TOKENS[role]), "content-type": "application/json" },
        body: JSON.stringify({ approvalId: category, decision }),
      });
      expect((await resolve("operator")).status).toBe(403);
      expect(h.runtime.approvals.isPending(category)).toBe(true);
      expect((await resolve("admin")).status).toBe(200);
      expect((await pending).approved).toBe(true);
    }
  } finally {
    await h.cleanup();
  }
});
