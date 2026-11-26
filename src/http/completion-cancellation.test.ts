import { afterEach, expect, it } from "vitest";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";
let h: HttpServerHandle | undefined;
afterEach(async () => { await h?.close(); });
it.each(["owner", "member", "operator", "admin"] as const)("aligns runtime cancellation for complete and btw for %s", async role => {
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(), namedTokens: () => [{ name: "fixture", role: role === "owner" ? "member" : role, sha256: hashHttpToken("named"), createdAt: "" }], runtime: {
    completePlain: async () => ({ ok: false, kind: "cancelled", reason: "cancelled" }),
    askSideQuestion: async () => ({ ok: false, kind: "cancelled", reason: "cancelled" }),
  } as never });
  for (const route of ["complete", "btw"]) {
    const response = await fetch(`http://127.0.0.1:${h.port}/api/${route}`, { method: "POST", headers: { authorization: `Bearer ${role === "owner" ? "owner" : "named"}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello", question: "hello" }) });
    expect(response.status, route).toBe(503);
    expect(await response.json()).toEqual({ error: { message: "The completion was cancelled", type: "server_error", param: null, code: "completion_cancelled" } });
  }
});

it.each(["owner", "member", "operator", "admin"] as const)("keeps provider error text cancelled distinct from cancellation for %s", async role => {
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(),
    namedTokens: () => [{ name: "fixture", role: role === "owner" ? "member" : role, sha256: hashHttpToken("named"), createdAt: "" }],
    runtime: { askSideQuestion: async () => ({ ok: false, kind: "failed", reason: "cancelled" }) } as never,
  });
  const response = await fetch(`http://127.0.0.1:${h.port}/api/btw`, { method: "POST",
    headers: { authorization: `Bearer ${role === "owner" ? "owner" : "named"}`, "content-type": "application/json" },
    body: JSON.stringify({ question: "hello" }),
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { type: "server_error",
    message: role === "owner" ? "cancelled" : "The model could not answer the side question",
  } });
});
