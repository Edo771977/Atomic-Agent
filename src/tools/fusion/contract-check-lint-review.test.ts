import { describe, expect, it } from "vitest";

import type { ContractCheck } from "./contract.js";
import { lintContractCheck } from "./contract-check-lint.js";

/** Issue #110 review: severe false refusals and weak warnings found by an adversarial review. */

const severe = (check: ContractCheck): boolean => lintContractCheck(check, 0).some((f) => f.severity === "severe");

describe("a newline separates shell commands: never a fixed print", () => {
  it.each<[string, ContractCheck]>([
    ["one-line cmd with \\n", { task: "t", cmd: "echo building\nnpm test", checks: ["exit 0"] }],
    ["one-line cmd with \\r\\n", { task: "t", cmd: "echo building\r\nnpm test", checks: ["exit 0"] }],
    ["bash -c body with \\n", { task: "t", cmd: "bash", args: ["-c", "echo ok\nnpm test"], checks: ["exit 0"] }],
    ["sh -c body with \\r", { task: "t", cmd: "sh", args: ["-c", "echo ok\rnpm test"], checks: ["exit 0"] }],
  ])("%s is not severe", (_name, check) => {
    expect(severe(check)).toBe(false);
  });
});

describe("words a subshell or interpreter re-reads are checked for metacharacters", () => {
  it.each<[string, ContractCheck]>([
    ["cmd /c with the line as args", { task: "t", cmd: "cmd", args: ["/c", "echo", "building", "&&", "npm", "test"], checks: ["exit 0"] }],
    ["pwsh -Command with a multi-word body", { task: "t", cmd: "pwsh", args: ["-Command", "Write-Output", "ok;", "npm", "test"], checks: ['stdout contains "ok"'] }],
    ["pwsh -Command with a subexpression", { task: "t", cmd: "pwsh", args: ["-Command", "Write-Output", "$(node", "app.js)"], checks: ["exit 0"] }],
    ["echo with args that cmd.exe would run (Windows builtin)", { task: "t", cmd: "echo", args: ["ok", "&&", "npm", "test"], checks: ['stdout contains "ok"'] }],
    ["echo with a %VAR% arg", { task: "t", cmd: "echo", args: ["%RESULT%"], checks: ["exit 0"] }],
    ["exit with a piped arg", { task: "t", cmd: "exit", args: ["0|node"], checks: ["exit 0"] }],
  ])("%s is not severe", (_name, check) => {
    expect(severe(check)).toBe(false);
  });

  it("still refuses the plain forms", () => {
    expect(severe({ task: "t", cmd: "cmd", args: ["/c", "echo", "ok"], checks: ['stdout contains "ok"'] })).toBe(true);
    expect(severe({ task: "t", cmd: "pwsh", args: ["-Command", "Write-Output", "ok"], checks: ['stdout contains "ok"'] })).toBe(true);
    expect(severe({ task: "t", cmd: "echo", args: ["ok"], checks: ['stdout contains "ok"'] })).toBe(true);
    expect(severe({ task: "t", cmd: "node", args: ["-e", "console.log('ok')"], checks: ['stdout contains "ok"'] })).toBe(true);
  });
});
