import { describe, expect, it } from "vitest";
import { shellRuleSegments, shellRunsUnreadableScript } from "../tools/os/shell/org-shell-analysis.js";
import { shellResources } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { matchRules, type ApprovalRule } from "../approval/approval-rules.js";

const posix = [
  "if fixture-check stop; then echo ordinary; fi", "if true; then fixture-check stop; else echo ordinary; fi",
  "while fixture-check stop; do echo ordinary; done", "until true; do fixture-check stop; done",
  "for item in ordinary; do fixture-check stop; done", "select item in ordinary; do fixture-check stop; done",
  "case ordinary in ordinary) fixture-check stop ;; esac", "{ fixture-check stop; }", "(fixture-check stop)",
  "! fixture-check stop", "time fixture-check stop", "coproc fixture-check stop", "coproc worker { fixture-check stop; }",
  "function worker { fixture-check stop; }; worker", "worker() { fixture-check stop; }; worker",
  "X=ordinary env -u UNUSED setsid fixture-check stop", "ionice -c 2 -n 5 fixture-check stop",
  "chroot /fixture-root fixture-check stop", "strace -o /fixture-output fixture-check stop", "unshare --mount fixture-check stop",
  "flock /fixture-lock fixture-check stop", "script -q -c 'fixture-check stop' /fixture-output",
  "flock /fixture-lock -c 'fixture-check stop'", "sudo flock /fixture-lock -c 'fixture-check stop'",
  "su fixture-user -c 'fixture-check stop'", "parallel fixture-check stop ::: ordinary", "busybox fixture-check stop",
  "busybox sh -c 'fixture-check stop'", "bash -c 'fixture-check stop'", "fixture-check st\\op", "fixture-check 'stop'",
];
const forms: Array<[string, string, string[]]> = [
  ["qualified executable", "C:/fixture/FiXtUrE-cHeCk.ExE", ["stop"]],
  ...posix.map(line => [line, "bash", ["-c", line]] as [string, string, string[]]),
  ["cmd escaped", "cmd.exe", ["/d", "/s", "/c", "call fixture-check st^op"]],
  ["cmd grouped", "cmd", ["/c", "(fixture-check stop) && echo ordinary"]],
  ["cmd start", "cmd", ["/c", 'start "" /b /wait fixture-check stop']],
  ["PowerShell escaped", "pwsh", ["-NoProfile", "-Command", "& 'fixture-check' st`op"]],
  ["PowerShell group", "PowerShell.exe", ["-Command", "if ($true) { fixture-check stop }"]],
];
describe("shared shell rule decisions on synthetic parser fixtures", () => {
  it.each(forms)("policy metadata agrees with restrictive rule matching for %s", (_label, cmd, args) => {
    const commandSegments = shellRuleSegments(cmd, args, false);
    const commandUnreadable = shellRunsUnreadableScript(cmd, args, false);
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-check stop*", effect }] };
      expect(evaluatePolicy(policy, "shell", shellResources(cmd, args), { unreadable: commandUnreadable })?.effect).toBe(effect);
      const rule: ApprovalRule = { id: "fixture", source: "user", createdAt: "", decision: effect, category: "shell", commandPrefix: ["fixture-check", "stop"] };
      expect(matchRules([rule], { tool: "os.shell.run", category: "shell", commandSegments, commandUnreadable })?.decision).toBe(effect);
    }
  });
  it.each(["$FIXTURE_PROGRAM stop", "${FIXTURE_PROGRAM} stop", "$(printf fixture-program) stop", "alias fixture_alias='ordinary'; fixture_alias", "f* stop"])("unresolved executable/alias is unreadable: %s", line => {
    expect(shellRunsUnreadableScript("bash", ["-c", line], false)).toBe(true);
  });
  it("keeps quoted data separate from executable words", () => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-check stop*", effect: "deny" }] };
    for (const line of ["echo 'fixture-check stop'", "echo bash -c 'fixture-check stop'"]) {
      const args = ["-c", line];
      expect(shellRunsUnreadableScript("bash", args, false)).toBe(false);
      expect(evaluatePolicy(policy, "shell", shellResources("bash", args))).toBeNull();
    }
  });
  it("function/PowerShell alias definitions and encoded commands are opaque", () => {
    expect(shellRunsUnreadableScript("bash", ["-c", "worker() { echo ordinary; }; worker"], false)).toBe(true);
    expect(shellRunsUnreadableScript("pwsh", ["-Command", "Set-Alias fixture_alias Write-Output; fixture_alias ordinary"], false)).toBe(true);
    expect(shellRunsUnreadableScript("PowerShell", ["-EncodedCommand", "ordinary-fixture"], false)).toBe(true);
    expect(shellRunsUnreadableScript("pwsh", ["-Command", "fixture_alias ordinary"], false)).toBe(true);
    expect(shellRunsUnreadableScript("pwsh", ["-Command", "Fixture-Alias ordinary"], false)).toBe(true);
  });
  it("normalizing restrictive executable names never broadens a saved allow", () => {
    const rule: ApprovalRule = { id: "fixture", source: "user", createdAt: "", decision: "allow", category: "shell", commandPrefix: ["fixture-check", "stop"] };
    expect(matchRules([rule], { tool: "os.shell.run", category: "shell", commandArgv: ["fixture-check.exe", "stop"] })).toBeNull();
  });
  it("ordinary executable names are not inherited wrapper-table properties", () => {
    expect(shellRuleSegments("constructor", ["--ordinary"], false)).toEqual([["constructor", "--ordinary"]]);
    expect(shellRuleSegments("toString", ["--ordinary"], false)).toEqual([["toString", "--ordinary"]]);
  });
});
