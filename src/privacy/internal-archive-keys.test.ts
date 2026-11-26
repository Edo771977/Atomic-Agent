import { afterEach, expect, it } from "vitest";
import { sessionIdError } from "../session/session-id.js";
import { forgetPrivacyVault, releasePrivacyVault, privacyVaultFor, resetPrivacyVaults } from "./index.js";
afterEach(resetPrivacyVaults);
const prefixes = ["compaction", "next-step", "risk", "browser-extract", "reflection", "rewriter", "link-gen", "vote", "note-reconcile", "btw", "title", "enhance", "learn"];

it.each([releasePrivacyVault, forgetPrivacyVault])("uses unforgeable internal keys without reinterpreting real colon IDs: %s", close => {
  for (const prefix of prefixes) {
    const real = `${prefix}:Y`;
    expect(sessionIdError(real)).toBeNull();
    const vault = privacyVaultFor(real); vault.mask("real.chat@example.test");
    privacyVaultFor(`${prefix}/Y`).mask("derived@example.test");
  }
  close("Y");
  for (const prefix of prefixes) {
    expect(sessionIdError(`${prefix}/Y`)).not.toBeNull();
    expect(privacyVaultFor(`${prefix}:Y`).unmask("[EMAIL_1]")).toBe("real.chat@example.test");
    expect(privacyVaultFor(`${prefix}/Y`).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  }
});

it("a closed Y never makes a real compaction:Y chat disposable", () => {
  forgetPrivacyVault("Y");
  const real = privacyVaultFor("compaction:Y"); real.mask("real.chat@example.test");
  expect(privacyVaultFor("compaction:Y")).toBe(real);
  expect(privacyVaultFor("compaction/Y")).not.toBe(privacyVaultFor("compaction/Y"));
});
