import { afterEach, expect, it } from "vitest";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { scopeForRoute } from "./http-scopes.js";
import { hashHttpToken } from "./http-token-store.js";

let handle: HttpServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; });
it.each(["viewer", "member", "operator", "admin"] as const)("exposes only Discord status with read scope to %s", async role => {
  const secret = "DISCORD-TOKEN-DO-NOT-EXPOSE";
  const token = "named-discord-fixture";
  handle = await createHttpServer({ runtime: { discordChannel: {
    state: () => "down", hasToken: () => true,
    lastError: () => `Failed for user 123456789 with ${secret}: PRIVATE-MESSAGE`,
    getBotIdentity: () => ({ id: "987654321", username: "PRIVATE-USER" }),
  } } as never, host: "127.0.0.1", port: 0, apiKey: "owner-fixture", routes: buildRouteTable(),
    namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(token), createdAt: "" }],
  });
  const url = `http://127.0.0.1:${handle.port}/api/discord/channel`;
  expect(scopeForRoute("GET", "/api/discord/channel")).toBe("read");
  expect((await fetch(url)).status).toBe(401);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ available: true, state: "down", hasToken: true, lastError: "channel_error", otherPoller: null });
  for (const value of [secret, "123456789", "987654321", "PRIVATE-MESSAGE", "PRIVATE-USER"]) expect(text).not.toContain(value);
});
