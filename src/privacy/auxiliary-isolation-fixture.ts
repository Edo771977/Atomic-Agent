import assert from "node:assert/strict";
import { privacyVaultFor, privacyVaultForRequest, releasePrivacyVault } from "./index.js";

/** Fake provider boundary: a previous call's placeholder must remain literal. */
export function assertAuxiliaryArchive(id: string | undefined): void {
  const key = id ?? "fixture:auxiliary";
  const previous = privacyVaultFor(key);
  previous.mask("previous.call@example.test");
  try {
    const current = privacyVaultForRequest(key);
    assert.equal(current.unmask("[EMAIL_1]"), "[EMAIL_1]");
    assert.equal(current.unmask(current.mask("current.call@example.test")), "current.call@example.test");
  } finally { releasePrivacyVault(key); }
}
