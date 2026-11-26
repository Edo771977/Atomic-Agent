import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { privacyVaultForRequest, resetPrivacyVaults } from "./index.js";
import { PLAIN_COMPLETE_PARTITION } from "../runtime/plain-complete.js";
import { AUXILIARY_PARTITIONS } from "./auxiliary-partitions.js";
afterEach(resetPrivacyVaults);
it("documents why the fresh plain completion is excluded from session-owned prefixes", () => {
  expect(AUXILIARY_PARTITIONS).not.toContain(PLAIN_COMPLETE_PARTITION.split(":")[0]);
  const source = readFileSync(new URL("./auxiliary-partitions.ts", import.meta.url), "utf8");
  expect(source).toContain(PLAIN_COMPLETE_PARTITION);
  expect(source).toMatch(/withFreshPrivacyVault[\s\S]*folder constraints[\s\S]*intentionally refused/);
  expect(source).toContain("../http/README.md");
});
it("documents that consolidator outside a fresh scope shares a registry archive", () => {
  const archive = privacyVaultForRequest("consolidator");
  expect(privacyVaultForRequest("consolidator")).toBe(archive);
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toContain('Outside `withFreshPrivacyVault`, calls to `privacyVaultForRequest("consolidator")` share the registry archive.');
});
