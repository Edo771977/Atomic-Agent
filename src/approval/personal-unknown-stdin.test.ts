import { describe, expect, it } from "vitest";
import { ApprovalGate } from "./approval-gate.js";
import { shellRuleSegments, shellRunsUnreadableScript, stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import type { ApprovalRule } from "./approval-rules.js";

describe("personal unknown interpreter stdin retains main's caution", () => {
  for (const level of [1, 5] as const) for (const decision of ["deny", "ask"] as const) {
    it.each(["python3", "node", "ruby", "perl"])(`${decision} at level ${level} still matches unknown stdin options for %s`, async program => {
      const cmd = `printf fixture | ${program} --fixture-unknown`;
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: request => { prompts++; gate.reject(request.approvalId, "fixture declines"); } });
      const rules: ApprovalRule[] = [{ id: "fixture", source: "user", createdAt: "", decision, category: "shell", commandPrefix: ["unrelated-fixture"] }];
      gate.setRules({ list: () => rules, add: () => { throw new Error("read-only fixture"); }, remove: () => false });
      const request = { tool: "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandSegments: shellRuleSegments(cmd, [], true), commandUnreadable: shellRunsUnreadableScript(cmd, [], true) };
      expect(request.commandUnreadable).toBe(true);
      expect(gate.ruleDecisionFor(request)).toBe(decision);
      expect((await gate.request(request)).approved).toBe(false);
      expect(prompts).toBe(decision === "ask" ? 1 : 0);
      expect(stdinScriptOf(program, ["--fixture-unknown"], false, "fixture")).toEqual({ lines: [], unreadable: true });
    });
  }
  it("keeps main's literal operand boundary for an unknown option followed by a file", () => {
    expect(shellRunsUnreadableScript("printf fixture | node --fixture-unknown fixture.js", [], true)).toBe(false);
  });
});
