import { afterEach, describe, expect, it } from "vitest";
import { GateBackend, facts, recordingGate, GATE_CTX } from "./browser-gate-test-helpers.js";
import { gateBrowserAction } from "./gate-browser-action.js";
import { installPolicy } from "../../policy/policy-active.js";

afterEach(() => installPolicy(null));
describe("profile actions without a web navigation", () => {
  it.each(["javascript:void(0)", "mailto:fixture@example.test"])("retains click and submit for %s", async target => {
    for (const kind of ["click", "type_enter"] as const) {
      const backend = new GateBackend();
      backend.element = facts({ href: target, formAction: target, inForm: true, isSubmit: true, name: "Continue" });
      const { options, prompts } = recordingGate(true);
      expect(await gateBrowserAction(backend, options, { blockedDomains: [], allowedDomains: [], userProfile: true }, { tool: "browser.click", kind, ref: "e1" }, GATE_CTX)).toBeNull();
      expect(prompts.at(-1)).toMatchObject({ category: "browser_secret" });
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: `${target}*`, effect: "deny" }] });
      expect((await gateBrowserAction(backend, options, { blockedDomains: [], allowedDomains: [], userProfile: true }, { tool: "browser.click", kind, ref: "e1" }, GATE_CTX))?.status).toBe("error");
      installPolicy(null);
    }
  });
});
