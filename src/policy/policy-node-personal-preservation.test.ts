import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { shellRuleSegments, shellRunsUnreadableScript, stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import type { ApprovalRule } from "../approval/approval-rules.js";

const ordinary = ["--max-semi-space-size", "--max-http-header-size", "--secure-heap", "-C", "--experimental-default-type", "--snapshot-blob"].flatMap(flag => [[flag, "fixture.js"], [flag, "fixture", "-"]]);
const conservative = [["--run"], ["--run=fixture", "-"]];
describe("Node organization options do not change personal stdin decisions", () => {
  for (const level of [1, 5] as const) for (const decision of ["deny", "ask"] as const) {
    it.each([...ordinary.map(args => ({ args, unreadable: false })), ...conservative.map(args => ({ args, unreadable: true }))])(`${decision}/${level} preserves $args`, ({ args, unreadable }) => {
      const cmd = `printf fixture | node ${args.join(" ")}`;
      const gate = new ApprovalGate({ level, emit: () => { throw new Error("decision-only fixture"); } });
      const rules: ApprovalRule[] = [{ id: "fixture", source: "user", createdAt: "", decision, category: "shell", commandPrefix: ["unrelated-fixture"] }];
      gate.setRules({ list: () => rules, add: () => { throw new Error("read-only fixture"); }, remove: () => false });
      const commandUnreadable = shellRunsUnreadableScript(cmd, [], true);
      expect(commandUnreadable).toBe(unreadable);
      expect(gate.ruleDecisionFor({ tool: "os.shell.run", category: "shell", sessionId: "fixture", commandSegments: shellRuleSegments(cmd, [], true), commandUnreadable })).toBe(unreadable ? decision : null);
      expect(stdinScriptOf("node", args, false, "fixture-command")).toEqual(unreadable ? { lines: [], unreadable: true } : null);
    });
  }
});
