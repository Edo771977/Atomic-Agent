import { afterEach, expect, it } from "vitest";
import { AUXILIARY_PARTITIONS } from "./auxiliary-partitions.js";
import { AUXILIARY_CALLERS, CALLER_PARTITIONS } from "./auxiliary-caller-test-helpers.js";
import {
  forgetPrivacyVault, privacyVaultFor, privacyVaultForRequest, resetPrivacyVaults,
  withFreshPrivacyVault, withPrivacyShieldTurn,
} from "./index.js";

afterEach(() => resetPrivacyVaults());

it.each(AUXILIARY_CALLERS)("registers the actual %s caller prefix", (_name, prefix) => {
  expect(prefix).toBeTypeOf("string");
  expect(prefix.endsWith(":")).toBe(true);
  expect(AUXILIARY_PARTITIONS).toContain(prefix.slice(0, -1));
});

it.each(CALLER_PARTITIONS)("refuses an unscoped %s partition without reinterpreting real colon IDs", prefix => {
  const realId = `${prefix}:Y`;
  const real = privacyVaultFor(realId);
  real.mask("real.chat@example.test");
  expect(() => privacyVaultForRequest(realId)).toThrow("requires withFreshPrivacyVault");
  withPrivacyShieldTurn(realId, () => {
    expect(privacyVaultForRequest(realId)).toBe(real);
    expect(privacyVaultForRequest(realId).unmask("[EMAIL_1]")).toBe("real.chat@example.test");
  });
  withPrivacyShieldTurn("Y", () => {
    expect(() => privacyVaultForRequest(realId)).toThrow("requires withFreshPrivacyVault");
    withFreshPrivacyVault(() => {
      const fresh = privacyVaultForRequest(realId);
      expect(privacyVaultForRequest(realId)).toBe(fresh);
      expect(fresh.unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
    });
  });
  forgetPrivacyVault("Y");
  expect(privacyVaultFor(realId)).toBe(real);
});

it("keeps imported colon IDs opaque without a turn scope", () => {
  const real = privacyVaultFor("codex:compaction:Y");
  expect(privacyVaultForRequest("codex:compaction:Y")).toBe(real);
});
