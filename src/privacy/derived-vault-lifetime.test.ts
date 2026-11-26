import { afterEach, expect, it } from "vitest";
import { forgetPrivacyVault, releasePrivacyVault, privacyVaultFor, privacyShieldTotals, resetPrivacyVaults, linkPrivacyVault } from "./index.js";

afterEach(resetPrivacyVaults);
const prefixes = ["compaction", "next-step", "risk", "browser-extract", "reflection", "rewriter", "link-gen", "vote", "note-reconcile", "btw", "title", "enhance", "learn"];

it.each([releasePrivacyVault, forgetPrivacyVault])("preserves colon-containing chat IDs during %s", close => {
  const root = "incog-1";
  const imported = ["codex:" + root, "claude-code:" + root, "client:chosen:" + root];
  const kept = imported.map(id => { const vault = privacyVaultFor(id); vault.mask("imported@example.test"); return vault; });
  privacyVaultFor(root).mask("private@example.test");
  for (const prefix of prefixes) {
    privacyVaultFor(`${prefix}/${root}`).mask("derived@example.test");
    privacyVaultFor(`${prefix}/${imported[0]}`).mask("imported-derived@example.test");
  }
  close(root);
  imported.forEach((id, index) => expect(privacyVaultFor(id)).toBe(kept[index]));
  for (const prefix of prefixes) {
    expect(privacyVaultFor(`${prefix}/${root}`).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
    expect(privacyVaultFor(`${prefix}/${imported[0]}`).unmask("[EMAIL_1]")).toBe("imported-derived@example.test");
  }
  close(imported[0]!);
  for (const prefix of prefixes) expect(privacyVaultFor(`${prefix}/${imported[0]}`).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
});

it("releasing 42 keeps codex:42's mappings and archive identity", () => {
  const imported = privacyVaultFor("codex:42"); imported.mask("imported@example.test");
  privacyVaultFor("reflection/42").mask("temporary@example.test");
  releasePrivacyVault("42");
  expect(privacyVaultFor("codex:42")).toBe(imported);
  expect(imported.unmask("[EMAIL_1]")).toBe("imported@example.test");
  expect(privacyVaultFor("reflection/42").unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
});

it("a tombstone for incog-1 does not make a new codex:incog-1 archive disposable", () => {
  forgetPrivacyVault("incog-1");
  const imported = privacyVaultFor("codex:incog-1"); imported.mask("imported@example.test");
  expect(privacyVaultFor("codex:incog-1")).toBe(imported);
  expect(privacyVaultFor("title/codex:incog-1")).toBe(privacyVaultFor("title/codex:incog-1"));
  expect(privacyVaultFor("reflection/incog-1")).not.toBe(privacyVaultFor("reflection/incog-1"));
});
it.each([releasePrivacyVault, forgetPrivacyVault])("removes derived archives while preserving other chats and worker parents: %s", close => {
  const other = privacyVaultFor("other"); other.mask("other@example.test");
  privacyVaultFor("chat").mask("old@example.test");
  for (const prefix of prefixes) privacyVaultFor(`${prefix}/chat`).mask("derived@example.test");
  linkPrivacyVault("worker", "other");
  close("chat");
  expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
  for (const prefix of prefixes) expect(privacyVaultFor(`${prefix}/chat`).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  expect(privacyVaultFor("worker")).toBe(other);
  close("worker");
  expect(privacyVaultFor("other")).toBe(other);
});

it.each([releasePrivacyVault, forgetPrivacyVault])("derived archives of closed chats do not evict an unrelated archive: %s", close => {
  const retained = privacyVaultFor("retained"); retained.mask("retained@example.test");
  for (let i = 0; i < 140; i++) {
    privacyVaultFor(`reflection/closed-${i}`).mask("temporary@example.test");
    close(`closed-${i}`);
  }
  expect(privacyVaultFor("retained")).toBe(retained);
  expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
});
