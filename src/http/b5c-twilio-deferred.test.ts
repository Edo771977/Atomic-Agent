import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { WEBHOOK_VERIFY_SCHEMES } from "../config/webhook-config.js";
import { buildRouteTable } from "./route-table.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
it("keeps the unapproved dialer and Twilio credential reader absent", () => {
  for (const path of ["../telephony/index.ts", "../telephony/twilio-voice-client.ts", "../telephony/telephony-config.ts"]) {
    expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
  }
});
it("does not expose Twilio configuration, calls, status or inbound webhook routes", () => {
  expect(buildRouteTable().filter(route => /twilio|telephony|phone.call/i.test(route.path))).toEqual([]);
  expect(Object.keys(ROUTE_SCOPES).filter(route => /twilio|telephony|phone.call/i.test(route))).toEqual([]);
  expect(WEBHOOK_VERIFY_SCHEMES).not.toContain("twilio");
});
