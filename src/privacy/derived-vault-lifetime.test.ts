import { afterEach, expect, it } from "vitest";
import { forgetPrivacyVault, releasePrivacyVault, privacyVaultFor, privacyShieldTotals, resetPrivacyVaults, linkPrivacyVault } from "./index.js";

afterEach(resetPrivacyVaults);
const prefixes = ["compaction", "next-step", "risk", "browser-extract", "reflection", "rewriter", "link-gen", "vote", "note-reconcile", "btw", "title", "enhance"];
it.each([releasePrivacyVault, forgetPrivacyVault])("removes derived archives while preserving other chats and worker parents: %s", close => {
  const other = privacyVaultFor("other"); other.mask("other@example.test");
  privacyVaultFor("chat").mask("old@example.test");
  for (const prefix of prefixes) privacyVaultFor(`${prefix}:chat`).mask("derived@example.test");
  linkPrivacyVault("worker", "other");
  close("chat");
  expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
  for (const prefix of prefixes) expect(privacyVaultFor(`${prefix}:chat`).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  expect(privacyVaultFor("worker")).toBe(other);
  close("worker");
  expect(privacyVaultFor("other")).toBe(other);
});

it.each([releasePrivacyVault, forgetPrivacyVault])("derived archives of closed chats do not evict an unrelated archive: %s", close => {
  const retained = privacyVaultFor("retained"); retained.mask("retained@example.test");
  for (let i = 0; i < 140; i++) {
    privacyVaultFor(`reflection:closed-${i}`).mask("temporary@example.test");
    close(`closed-${i}`);
  }
  expect(privacyVaultFor("retained")).toBe(retained);
  expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
});
