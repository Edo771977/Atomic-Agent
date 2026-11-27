import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EXTRA_CHANNELS } from "./channel-catalog.js";
it("cannot select a WhatsApp channel that would accept external turns or approvals", () => {
  expect(EXTRA_CHANNELS.some(channel => channel.id === "whatsapp")).toBe(false);
});
it("keeps WhatsApp connection, authentication, QR and inbound dispatch absent", () => {
  for (const path of ["whatsapp/index.ts", "whatsapp/whatsapp-baileys.ts", "whatsapp/whatsapp-channel.ts", "whatsapp/whatsapp-inbound-handler.ts", "whatsapp/whatsapp-approval-bridge.ts"]) {
    expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
  }
});
it("does not install the deferred WhatsApp protocol or QR packages", () => {
  const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  expect(lock.packages["node_modules/baileys"]).toBeUndefined();
  expect(lock.packages["node_modules/qrcode-terminal"]).toBeUndefined();
});
