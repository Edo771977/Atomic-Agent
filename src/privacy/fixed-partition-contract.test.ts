import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { privacyVaultForRequest, resetPrivacyVaults } from "./index.js";
afterEach(resetPrivacyVaults);
it("documents that consolidator outside a fresh scope shares a registry archive", () => {
  const archive = privacyVaultForRequest("consolidator");
  expect(privacyVaultForRequest("consolidator")).toBe(archive);
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toContain('Outside `withFreshPrivacyVault`, calls to `privacyVaultForRequest("consolidator")` share the registry archive.');
});
