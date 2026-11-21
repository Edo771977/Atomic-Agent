import { describe, expect, it } from "vitest";

import type { ContractCheck } from "./contract.js";
import { lintContractCheck, lintExampleExpect } from "./contract-check-lint.js";
import { parseDelegateArgs } from "./delegate-args.js";

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

describe("example expects: only a top-level trailing `|| true` is constant", () => {
  const where = "contract.provides[0].example.expect";
  it.each([
    "r.average === r.sum / (r.count || 1)",
    "r.pages === (r.total || 1)",
    "/'/.test(r) && r !== ''",
    "r.ok || (r.retry && true)",
  ])("`%s` is not severe", (expect_) => {
    expect(lintExampleExpect(expect_, where)?.severity).not.toBe("severe");
  });
  it.each(["r.ok || true", "(r.x > 0) || 1", "r.a && r.b || !0", "true || r.ok"])("`%s` is still severe", (expect_) => {
    expect(lintExampleExpect(expect_, where)?.severity).toBe("severe");
  });
});

describe("error-output-match counts only failure output a passing command could print", () => {
  const rules = (check: ContractCheck): string[] => lintContractCheck(check, 0).map((f) => f.rule);
  it("ignores failure output that only comes with a non-zero exit, which a passing command check never has", () => {
    expect(rules({ task: "t", cmd: "node", args: ["app.js"], checks: ["exit 0", 'stdout contains "module"'] })).toEqual([]);
    expect(rules({ task: "t", cmd: "node", args: ["app.js"], checks: ["exit 0", 'stdout contains "1"'] })).toEqual([]);
    expect(rules({ task: "t", cmd: "npm", args: ["test"], checks: ["exit 0", "stdout matches /ok/"] })).toEqual([]);
  });
  it("keeps the warning for output an exit 0 run prints", () => {
    expect(rules({ task: "t", cmd: "node", args: ["--test"], checks: ["exit 0", 'stdout contains "passed"'] })).toEqual(["error-output-match"]);
  });
  it("clears it when the check follows the advice and rules the failure form out", () => {
    expect(rules({ task: "t", cmd: "node", args: ["--test"], checks: ["exit 0", "stdout matches /# pass \\d+/", 'stdout not contains "# pass 0"'] })).toEqual([]);
    expect(rules({ task: "t", cmd: "node", args: ["--test"], checks: ["exit 0", 'stdout contains "passed"', "stdout not matches /\\b0 (tests )?passed|passed: 0/"] })).toEqual([]);
  });
  it("a negative assertion on the other stream does not clear it", () => {
    expect(rules({ task: "t", cmd: "node", args: ["--test"], checks: ["exit 0", 'stdout contains "passed"', 'stderr not contains "0 passed"'] })).toEqual(["error-output-match"]);
  });
  it("names a negative control as a remedy", () => {
    const [finding] = lintContractCheck({ task: "t", cmd: "node", args: ["--test"], checks: ['stdout contains "passed"'] }, 0);
    expect(finding?.message).toContain("`negative`");
  });
});

describe("a check that sets env or cwd is never severe", () => {
  it.each<[string, ContractCheck]>([
    ["NODE_OPTIONS can preload code", { task: "t", cmd: "node", args: ["-e", "console.log('ok')"], env: { NODE_OPTIONS: "--require ./check.js" }, checks: ['stdout contains "ok"'] }],
    ["PATH can shadow echo", { task: "t", cmd: "echo ok", env: { PATH: "./bin" }, checks: ['stdout contains "ok"'] }],
    ["a cwd", { task: "t", cmd: "echo ok", cwd: "sub", checks: ['stdout contains "ok"'] }],
  ])("%s", (_name, check) => {
    expect(severe(check)).toBe(false);
  });
});

describe("a resumed run's stored contract is not refused for a check the person already approved", () => {
  const args = { tasks: [{ id: "t", instructions: "x" }], contract: { checks: [{ task: "t", cmd: "echo ok", checks: ['stdout contains "ok"'] }] } };
  it("a new call is refused", () => {
    expect(parseDelegateArgs(args).ok).toBe(false);
  });
  it("the stored contract of a resume parses, with the finding as a warning", () => {
    const parsed = parseDelegateArgs(args, { storedContract: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.contract?.warnings).toEqual([expect.stringMatching(/^check lint \(warning\): contract\.checks\[0\] cannot fail/)]);
  });
});
