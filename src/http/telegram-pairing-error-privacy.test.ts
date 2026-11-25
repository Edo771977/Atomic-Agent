import { afterEach, expect, it, vi } from "vitest";
import type { StartPairingOptions } from "../channels/telegram/index.js";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";
let h: HttpServerHandle | undefined;
afterEach(async () => { await h?.close(); });
async function fixture(role: "viewer" | "member" | "operator" | "admin") {
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(), namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken("named"), createdAt: "" }], runtime: {
    completePlain: async () => ({ ok: false, reason: "provider SYNTHETIC-SECRET", kind: "failed" }),
    telegramChannel: { state: () => "down", lastError: () => "bot SYNTHETIC-SECRET for user 123456789" },
  } as never });
  return (path: string, token = "named") => fetch(`http://127.0.0.1:${h!.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
}
it.each(["viewer", "member", "operator", "admin"] as const)("keeps Telegram pairing errors fixed for %s", async role => {
  const post = await fixture(role);
  const response = await post("/api/telegram/pairing");
  expect(response.status).toBe(role === "admin" ? 409 : 403);
  const text = await response.text();
  expect(text).not.toContain("SYNTHETIC-SECRET");
  expect(text).not.toContain("123456789");
  if (role === "admin") expect(JSON.parse(text).error).toMatchObject({ code: "telegram_not_running", message: "Telegram is not running" });
});

it.each(["setOwnerUserId", "bot API"])("keeps a failed %s pairing out of admin status and cancel responses", async source => {
  let active = false;
  let reject!: (error: unknown) => void;
  const warn = vi.fn();
  const failure = new Error(`${source}: SYNTHETIC-SECRET user 123456789`);
  const setOwnerUserId = vi.fn(async () => { throw failure; });
  const botApi = vi.fn(async () => { throw failure; });
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(), namedTokens: () => [{ name: "admin", role: "admin", sha256: hashHttpToken("named"), createdAt: "" }], runtime: {
    logger: { warn },
    telegramChannel: { state: () => "up", lastError: () => null, getOwnerUserId: () => null, getBotIdentity: () => null,
      pairingState: () => ({ active, expiresAt: null }), cancelPairing: () => { active = false; },
      startPairing: (_timeout: unknown, options: StartPairingOptions) => {
        active = true; options.onOpened?.({ code: "123456", expiresAt: Date.now() + 1000 });
        return new Promise((_resolve, fail) => { reject = fail; });
      },
    },
  } as never });
  const request = (method: string) => fetch(`http://127.0.0.1:${h!.port}/api/telegram/pairing`, { method, headers: { authorization: "Bearer named", "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
  expect((await request("POST")).status).toBe(200);
  try { await (source === "setOwnerUserId" ? setOwnerUserId() : botApi()); } catch (error) { active = false; reject(error); }
  for (const method of ["GET", "DELETE"]) {
    const response = await request(method);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ status: "failed", error: "pairing_failed" });
    expect(text).not.toContain("SYNTHETIC-SECRET");
    expect(text).not.toContain("123456789");
  }
  expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: failure.message }));
});

it("returns a fixed HTTP 500 if the bot API fails before opening a pairing window", async () => {
  const warn = vi.fn();
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(), namedTokens: () => [{ name: "admin", role: "admin", sha256: hashHttpToken("named"), createdAt: "" }], runtime: { logger: { warn }, telegramChannel: {
    state: () => "up", getOwnerUserId: () => null, startPairing: async () => { throw new Error("bot API SYNTHETIC-SECRET"); },
  } } as never });
  const response = await fetch(`http://127.0.0.1:${h.port}/api/telegram/pairing`, { method: "POST", headers: { authorization: "Bearer named", "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "pairing_failed", message: "Telegram pairing failed" } });
  expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: "bot API SYNTHETIC-SECRET" }));
});
