import { describe, expect, it } from "vitest";
import { shellRunsUnreadableScript, stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import { matchRules } from "../approval/approval-rules.js";

describe("intentional personal stdin hardening relative to main", () => {
  it.each([
    ["python3", ["-W", "error", "-"]], ["node", ["--title", "fixture", "-"]],
    ["ruby", ["-I", "fixture", "-"]], ["perl", ["-I", "fixture", "-"]],
  ] as const)("locates actual stdin past value options in %s", (cmd, args) => {
    expect(shellRunsUnreadableScript(`printf fixture | ${cmd} ${args.join(" ")}`, [], true)).toBe(true);
    expect(stdinScriptOf(cmd, args, false, "fixture")).toEqual({ lines: [], unreadable: true });
  });
  it.each(["/dev/fd/3", "/proc/self/fd/4"])("does not bind an unrelated verify payload to %s", operand => {
    expect(stdinScriptOf("sh", [operand], false, "fixture")).toEqual({ lines: [], unreadable: true });
  });
  it.each([
    ["awk", ["-f", "-"]], ["sed", ["-f", "-"]], ["bash", ["/dev/stdin"]], [".", ["/dev/stdin"]],
    ["php", ["-d", "fixture=1", "-"]], ["php", ["-c", "fixture.ini", "-"]],
    ["osascript", ["-l", "JavaScript", "-"]], ["osascript", ["-s", "h", "-"]],
    ["mksh", []], ["ash", []], ["busybox", ["sh"]],
  ] as const)("documents additional no-policy stdin hardening for %s", (cmd, args) => {
    const commandUnreadable = shellRunsUnreadableScript(`printf fixture | ${cmd} ${args.join(" ")}`, [], true);
    expect(commandUnreadable).toBe(true);
    for (const decision of ["deny", "ask"] as const) {
      expect(matchRules([{ id: "fixture", source: "user", createdAt: "", category: "shell", commandPrefix: ["unrelated-fixture"], decision }], { tool: "os.shell.run", category: "shell", commandUnreadable })?.decision).toBe(decision);
    }
  });
});
