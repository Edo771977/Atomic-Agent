import { afterEach, expect, it } from "vitest";
import { privacyVaultFor, privacyShieldTotals, resetPrivacyVaults, linkPrivacyVault } from "../privacy/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); resetPrivacyVaults(); });
it("closing incognito removes its derived archives and worker aliases through the runtime", async () => {
  h = await startTestHarness();
  const chat = h.runtime.createSession({ incognito: true });
  const other = privacyVaultFor("other"); other.mask("other@example.test");
  for (const prefix of ["", "compaction/", "next-step/", "risk/", "browser-extract/", "reflection/", "rewriter/", "link-gen/", "vote/", "note-reconcile/", "btw/", "title/", "enhance/"]) privacyVaultFor(prefix + chat.id).mask("incognito@example.test");
  linkPrivacyVault("s-w-private", chat.id);
  privacyVaultFor("reflection/s-w-private").mask("worker@example.test");
  h.runtime.sessionStore.delete(chat.id);
  expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
  expect(privacyVaultFor("reflection/" + chat.id).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  expect(privacyVaultFor("s-w-private").unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  expect(privacyVaultFor("other")).toBe(other);
});
