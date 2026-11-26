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
it.each(["member", "operator", "admin"] as const)("redacts complete provider failures for %s", async role => {
  const post = await fixture(role);
  const response = await post("/api/complete");
  expect(response.status).toBe(502);
  expect((await response.json() as { error: { message: string } }).error.message).toBe("The model could not complete the request");
  expect(await (await post("/api/complete", "owner")).text()).toContain("SYNTHETIC-SECRET");
});

it("reports runtime cancellation with 503 and a fixed cancellation code", async () => {
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(), runtime: { completePlain: async () => ({ ok: false, kind: "cancelled", reason: "cancelled" }) } as never });
  const response = await fetch(`http://127.0.0.1:${h.port}/api/complete`, { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "completion_cancelled", message: "The completion was cancelled" } });
});
