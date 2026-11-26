import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { shellRunsUnreadableScript } from "../tools/os/shell/shell-command-argv.js";
describe("external code options are conservative only for organization policy", () => {
  it("classifies explicit verification initialization environment", () => {
    expect(toolCallTarget("verify.run", { kind: "command", cmd: "bash", args: ["-c", "printf fixture"], env: { BASH_ENV: "/fixture/init" } })?.unreadable).toBe(true);
    expect(toolCallTarget("verify.run", { kind: "command", cmd: "git", args: ["log"], env: { GIT_PAGER: "fixture" } })?.unreadable).toBe(true);
  });
  it.each([
    ["git", "-c", "alias.fixture=!fixture", "fixture"], ["git", "-c", "core.sshCommand=fixture", "fetch"],
    ["git", "--paginate", "log"], ["git", "-c", "core.pager=fixture", "log"],
    ["make", "fixture"], ["tar", "--to-command=fixture", "-xf", "fixture.tar"],
    ["tar", "--checkpoint-action=exec=fixture", "-cf", "fixture.tar", "fixture.txt"],
    ["vim", "fixture.txt"], ["gdb", "-ex", "fixture"],
    ["env", "BASH_ENV=/fixture/init", "bash", "-c", "printf fixture"],
  ])("classifies %j without executing its fixture", (cmd, ...args) => {
    expect(shellRunsUnreadableScript(cmd, args, false)).toBe(false);
    expect(toolCallTarget("os.shell.run", { cmd, args })?.unreadable).toBe(true);
  });
});
