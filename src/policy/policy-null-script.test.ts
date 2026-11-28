import { describe, expect, it } from "vitest";
import { scriptStream, scriptInput } from "../tools/os/shell/org-script-operands.js";
import { stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { toolCallTarget } from "./policy-targets.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import { policyRuleMatch } from "./policy-enforce.js";

describe("Make and shell empty scripts", () => {
  it.each(["/dev/null", "/dev/./null", "../dev/null"])("classifies %s as none after lexical resolution", path => {
    expect(scriptStream(path, "/work")).toBe("none");
    expect(scriptInput(["bash", path], "/work")).toBeNull();
    expect(stdinScriptOf("bash", [path], false, "fixture", "/work")).toBeNull();
  });
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    it.each([["make", ["-f", "/dev/null"]], ["make", ["-sf../dev/null"]], ["bash", ["/dev/null"]], ["sh", ["../dev/null"]]] as const)(`${effect}/${level} retains empty %s %j`, (cmd, args) => {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
      const gate = new ApprovalGate({ level, emit: () => { throw new Error("empty script must not prompt for unrelated policy"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      expect(gate.ruleDecisionFor({ tool: "os.shell.run", category: "shell", sessionId: "fixture", commandArgv: [cmd, ...args], workdir: "/work" })).toBeNull();
      for (const tool of ["os.shell.run", "verify.run"]) {
        const target = toolCallTarget(tool, { kind: "command", cmd, args, cwd: "/work", stdin: "unrelated-fixture-data" })!;
        expect(evaluatePolicy(policy, "shell", target.resources, target)).toBeNull();
        expect(target.resources).not.toContain("unrelated-fixture-data");
      }
    });
  }
  it.each(["/dev/fd/3", "/proc/version"])("retains conservative unrelated streams: %s", path => expect(scriptStream(path)).toBe("unknown"));
});
