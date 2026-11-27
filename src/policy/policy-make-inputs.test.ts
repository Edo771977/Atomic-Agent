import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { policyRuleMatch } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

const opaque = [
  ["-E", "fixture=1"], ["-Efixture=1"], ["--eval", "fixture=1"], ["--eval=fixture=1"],
  ...["-f", "--file", "--makefile"].flatMap(flag => [[flag, "-"], [flag, "/dev/fd/3"], [`${flag}=/dev/stdin`]]),
  ["-f/dev/fd/3"], ["-f-"],
];
describe("make code and stream selectors", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    it.each(opaque)(`${effect} at level ${level} covers %j`, async (...args) => {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      const request = { tool: "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandArgv: ["make", ...args] };
      expect(gate.ruleDecisionFor(request)).toBe(effect);
      expect((await gate.request(request)).approved).toBe(false);
      expect(prompts).toBe(effect === "ask" ? 1 : 0);
    });
  }
  it.each([[], ["test"], ["-f", "Makefile.other"], ["-fMakefile.other"], ["--file=Makefile.other"], ["--makefile", "Makefile.other"]])("retains ordinary make %j", (...args) => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect: "deny" }] };
    expect(policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandArgv: ["make", ...args] })).toBeNull();
  });
});
