import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { policyRuleMatch } from "./policy-enforce.js";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

const opaque = [
  ["-sE", "fixture=1"], ["-ksEfixture=1"], ["-j4Efixture=1"], ["-l2.5Efixture=1"],
  ["-jE", "fixture=1"], ["-lf", "-"], ["-ksf-"], ["-sf", "/dev/stdin"], ["-j4f/dev/fd/3"],
  ...["--ev", "--eva", "--eval"].flatMap(flag => [[flag, "fixture=1"], [`${flag}=fixture=1`]]),
  ...["--f", "--fi", "--fil", "--file", "--mak", "--make", "--makef", "--makefile"].flatMap(flag => [[flag, "-"], [`${flag}=/dev/fd/3`]]),
];
const ordinary = [
  [], ["test"], ["-j4", "test"], ["-kl2.5s", "test"], ["-ksfMakefile.other"], ["-sf", "Makefile.other"],
  ...["C", "I", "o", "W"].flatMap(flag => [[`-s${flag}`, "-Efixture", "test"], [`-s${flag}-Efixture`, "test"]]),
  ["--file=Makefile.other"], ["--mak", "Makefile.other"], ["--environment-overrides", "test"],
];
describe("make option groups and unique GNU abbreviations", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    it.each(opaque)(`${effect}/${level} gates grouped or abbreviated %j`, async (...args) => {
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      const req = { tool: "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandArgv: ["make", ...args] };
      expect(gate.ruleDecisionFor(req)).toBe(effect);
      expect((await gate.request(req)).approved).toBe(false);
      expect(prompts).toBe(effect === "ask" ? 1 : 0);
      const target = toolCallTarget("verify.run", { kind: "command", cmd: "make", args, stdin: "fixture" })!;
      expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
    });
    it.each(ordinary)(`${effect}/${level} retains ordinary grouped %j`, (...args) => {
      for (const tool of ["os.shell.run", "verify.run"]) {
        const target = toolCallTarget(tool, { kind: "command", cmd: "make", args })!;
        expect(evaluatePolicy(policy, "shell", target.resources, target)).toBeNull();
      }
    });
  }
});
