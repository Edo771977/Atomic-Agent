import { afterEach, expect, it } from "vitest";
import { privacyVaultFor, resetPrivacyVaults } from "../privacy/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); resetPrivacyVaults(); });
it.each(["rollback-last-turn", "rewind"])("releases removed values on %s and masks the next turn", async action => {
  let id = "";
  let nextTurnCalls = 0;
  h = await startTestHarness({ llamaComplete: async p => {
    if (p.sessionId === id) {
      nextTurnCalls++;
      const vault = privacyVaultFor(id);
      expect(vault.unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
      expect(vault.mask("current@example.test")).toBe("[EMAIL_1]");
      expect(vault.unmask("[EMAIL_1]")).toBe("current@example.test");
    }
    return { content: JSON.stringify([{ tool: "reply", args: { text: "done" } }]), reasoningContent: "", stop: true, truncated: false, timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 }, cacheHitTokens: 0, slotId: 0, modelId: null };
  } });
  const state = h.runtime.createSession(); id = state.id;
  h.runtime.sessionStore.save({ ...state, status: "pending", turns: [{ kind: "user", text: "old@example.test", at: 1 }, { kind: "assistant_reply", text: "old answer", at: 2 }], turnCount: 1, macroTurnStarts: [2] });
  privacyVaultFor(id).mask("old@example.test");
  const response = await fetch(`${h.baseUrl}/api/sessions/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "rewind" ? { priorQuestions: 0, expectText: "old@example.test", files: false } : {}) });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(privacyVaultFor(id).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  await h.runtime.runTurn(h.runtime.sessionStore.load(id)!, "current@example.test", { maxSteps: 1 });
  expect(nextTurnCalls).toBe(1);
});
