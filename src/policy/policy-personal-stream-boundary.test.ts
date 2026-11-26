import { describe, expect, it } from "vitest";
import { shellRunsUnreadableScript, stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";

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
});
