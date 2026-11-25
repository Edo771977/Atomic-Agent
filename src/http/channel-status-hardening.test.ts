import { afterEach, expect, it } from "vitest";
import { formatChannelLockHeld } from "../channels/channel-lock-error.js";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";
import type { HttpRole } from "./http-scopes.js";

let handle: HttpServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; });
const OWNER = "status-owner";
const NAMED = "status-named";
async function fixture(error: string | null, role: HttpRole = "viewer") {
  const channel = { state: () => "down", lastError: () => error, hasToken: () => true };
  handle = await createHttpServer({ runtime: { discordChannel: channel, telegramChannel: channel } as never,
    host: "127.0.0.1", port: 0, apiKey: OWNER, routes: buildRouteTable(),
    namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(NAMED), createdAt: "" }],
  });
  return (channelName: string, token = OWNER) => fetch(`http://127.0.0.1:${handle!.port}/api/${channelName}/channel`, { headers: { authorization: `Bearer ${token}` } });
}

it("distinguishes Discord lock contention from a channel failure", async () => {
  const get = await fixture(formatChannelLockHeld(424242));
  const response = await get("discord");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ lastError: "channel_locked", otherPoller: { where: "this_computer", pid: 424242 } });
});

it.each(["viewer", "member", "operator", "admin"] as const)("hides local poller PIDs from %s on both channels", async role => {
  const get = await fixture(formatChannelLockHeld(424242), role);
  for (const channel of ["discord", "telegram"]) {
    const response = await get(channel, NAMED);
    expect(response.status).toBe(200);
    const body = await response.json() as { otherPoller: unknown };
    expect(body.otherPoller).toEqual({ where: "this_computer" });
  }
});

it.each(["owner", "viewer", "member", "operator", "admin"] as const)("redacts Telegram errors and forbids caching for %s", async role => {
  const get = await fixture("failed with SYNTHETIC-TOKEN for user 123456789 PRIVATE-MESSAGE", role === "owner" ? "viewer" : role);
  const response = await get("telegram", role === "owner" ? OWNER : NAMED);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ available: true, state: "down", lastError: "channel_error", otherPoller: null });
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const secret of ["SYNTHETIC-TOKEN", "123456789", "PRIVATE-MESSAGE"]) expect(text).not.toContain(secret);
});

it("reports Telegram lock contention without the raw lock error", async () => {
  const get = await fixture(formatChannelLockHeld(424242));
  const response = await get("telegram");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ lastError: "channel_locked", otherPoller: { where: "this_computer", pid: 424242 } });
});
