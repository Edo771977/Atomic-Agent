import { afterEach, expect, it } from "vitest";
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
