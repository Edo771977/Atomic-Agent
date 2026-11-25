import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { buildTunnelRouteTable } from "./tunnel-route-table.js";
import { verifySignedWebhook } from "./webhook-verify.js";

it("accepts a signed Svix delivery while retaining the fork's dedicated tunnel path", () => {
  const body = Buffer.from("{}");
  const key = Buffer.from("fixture-key-only");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(`msg_fixture.${timestamp}.`).update(body).digest("base64");
  const req = { headers: { "svix-id": "msg_fixture", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } } as unknown as IncomingMessage;
  expect(verifySignedWebhook({ verify: "standard-webhooks", secret: `whsec_${key.toString("base64")}` } as never, req, body, Date.now()))
    .toEqual({ ok: true, messageId: "msg_fixture" });
  expect(buildTunnelRouteTable().map(route => route.path)).toEqual(["/webhooks/{name}"]);
});
