import { CALLER_PARTITIONS as prefixes } from "./auxiliary-caller-test-helpers.js";
import { afterEach, expect, it } from "vitest";
import { sessionIdError } from "../session/session-id.js";
import { forgetPrivacyVault, releasePrivacyVault, privacyVaultFor, resetPrivacyVaults } from "./index.js";
afterEach(resetPrivacyVaults);


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

it.each([releasePrivacyVault, forgetPrivacyVault])("recursively clears only nested internal descendants: %s", close => {
  const real = privacyVaultFor("reflection:title:X"); real.mask("real@example.test");
  const imported = privacyVaultFor("reflection/title/codex:X"); imported.mask("imported@example.test");
  for (const key of ["title/X", "reflection/title/X", "risk/reflection/title/X"]) privacyVaultFor(key).mask("nested@example.test");
  close("X");
  for (const key of ["title/X", "reflection/title/X", "risk/reflection/title/X"]) expect(privacyVaultFor(key).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  expect(privacyVaultFor("reflection:title:X")).toBe(real);
  expect(privacyVaultFor("reflection/title/codex:X")).toBe(imported);
});

it("closed roots make arbitrarily nested internal archives disposable", () => {
  forgetPrivacyVault("codex:X");
  for (const key of ["title/codex:X", "reflection/title/codex:X", "risk/reflection/title/codex:X"]) expect(privacyVaultFor(key)).not.toBe(privacyVaultFor(key));
  expect(privacyVaultFor("reflection:title:codex:X")).toBe(privacyVaultFor("reflection:title:codex:X"));
});
