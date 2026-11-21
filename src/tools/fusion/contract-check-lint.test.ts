import { describe, expect, it } from "vitest";

import type { ContractCheck, DelegateContract } from "./contract.js";
import {
  checkReservations,
  checksWithoutCriteriaHint,
  fixedOutputOf,
  lintContract,
  lintContractCheck,
  lintExampleExpect,
  splitPlainCommand,
} from "./contract-check-lint.js";
import { parseDelegateArgs } from "./delegate-args.js";

/**
 * Issue #110: contract checks that cannot fail are refused before
 * anything runs, and the ones that may pass on the wrong thing are named.
 */

const severeOf = (check: ContractCheck): string[] =>
  lintContractCheck(check, 0).filter((f) => f.severity === "severe").map((f) => f.rule);
const rulesOf = (check: ContractCheck): string[] => lintContractCheck(check, 0).map((f) => `${f.rule}:${f.severity}`);

/** Fixed prints whose text their own checks accept: provably green whatever the workers wrote. */
const SEVERE_CHECKS: Array<[string, ContractCheck]> = [
  ["echo as one line", { task: "t1", kind: "command", cmd: "echo ok", checks: ['stdout contains "ok"'] }],
  ["echo as words, exit only", { task: "t1", kind: "command", cmd: "echo", args: ["ok"], checks: ["exit 0"] }],
  ["node -e console.log of a literal", { task: "t1", kind: "command", cmd: "node", args: ["-e", "console.log('ok')"], checks: ['stdout contains "ok"'] }],
  ["node -e one line", { task: "t1", cmd: `node -e "console.log('all good'); process.exit(0)"`, checks: ["exit 0", 'stdout matches /good/'] }],
  ["node -e stdout.write", { task: "t1", cmd: "node", args: ["-e", 'process.stdout.write("done")'], checks: ['stdout contains "done"'] }],
  ["node -p literal", { task: "t1", cmd: "node", args: ["-p", "'passed'"], checks: ['stdout contains "passed"'] }],
  ["printf", { task: "t1", cmd: "printf", args: ["3 tests passed\\n"], checks: ['stdout contains "passed"'] }],
  ["true", { task: "t1", cmd: "true", checks: ["exit 0"] }],
  ["exit 0 with no checks", { task: "t1", cmd: "exit 0" }],
  ["cmd /c echo", { task: "t1", cmd: "cmd", args: ["/c", "echo ok"], checks: ['stdout contains "ok"'] }],
  ["sh -c echo", { task: "t1", cmd: "sh", args: ["-c", "echo all tests passed"], checks: ["exit 0", 'stdout matches /passed/'] }],
  ["powershell Write-Output", { task: "t1", cmd: "powershell", args: ["-NoProfile", "-Command", "Write-Output 'ok'"], checks: ['stdout contains "ok"'] }],
  ["python print", { task: "t1", cmd: "python3", args: ["-c", "print('ok')"], checks: ['stdout contains "ok"'] }],
  ["echo with a negated assertion it also satisfies", { task: "t1", cmd: "echo 42", checks: ['stdout contains "42"', 'stdout not contains "Error"'] }],
];

/**
 * Real-shaped contracts that must never be refused: the CSV e2e's
 * (docs/testing/fixtures/csv-sales/prompt.txt: `node sales.cjs <input.csv>`,
 * `node --test sales.test.cjs`, "Invalid header" / "Invalid row N" on
 * stderr with exit 1, brief examples such as `{"X":0}` as expected
 * output), the game e2e's page checks, and commands a shell could
 * expand, redirect or that run a file.
 */
const CLEAN_CHECKS: Array<[string, ContractCheck]> = [
  ["csv: the tests", { task: "tests", criteria: ["c1"], kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"], checks: ["exit 0"] }],
  ["csv: tests as one line", { task: "tests", kind: "command", cmd: "node --test sales.test.cjs", checks: ["exit 0", 'stdout matches /# fail 0/'] }],
  ["csv: a brief example output", { task: "program", criteria: ["c2"], kind: "command", cmd: "node", args: ["sales.cjs", "fixtures/zero.csv"], checks: ["exit 0", 'stdout contains "{\\"X\\":0}"'] }],
  ["csv: total at the limit", { task: "program", kind: "command", cmd: "node", args: ["sales.cjs", "fixtures/max.csv"], checks: ["exit 0", 'stdout contains "9007199254740991"'] }],
  ["csv: invalid row observed through a wrapper", { task: "program", criteria: ["c3"], kind: "command", cmd: "node", args: ["-e", "const r=require('child_process').spawnSync(process.execPath,['sales.cjs','bad.csv'],{encoding:'utf8'});process.stdout.write(String(r.status)+' '+r.stderr)"], checks: ["exit 0", 'stdout contains "1 Invalid row 2"'] }],
  ["csv: invalid header expects a failure", { task: "program", kind: "command", cmd: "node sales.cjs bad-header.csv", checks: ["exit != 0", 'stderr contains "Invalid header"'] }],
  ["csv: an error expected on stderr with exit 1", { task: "program", kind: "command", cmd: "node", args: ["sales.cjs", "neg.csv"], checks: ["exit 1", 'stderr contains "error"'] }],
  ["e2e with stdin", { task: "cli", kind: "command", cmd: "node", args: ["cli.js"], stdin: "move e2e4\nquit\n", checks: ["exit 0", 'stdout contains "e2e4"'] }],
  ["game: played games", { task: "ui", criteria: ["c3"], kind: "page", path: "index.html", game: { games: 3, maxMsPerGame: 1000 }, checks: ["games finish", "game errors 0", "game winners vary"] }],
  ["game: visual", { task: "ui", criteria: ["c4"], judge: "vision", kind: "page", path: "index.html", screenshot: { fullPage: false }, checks: ["no errors", "missing selectors 0"] }],
  ["game: a probe", { task: "ui", kind: "page", path: "index.html", probes: [{ name: "score", expr: "window.score" }], checks: ["no errors", "probe score increases"] }],
  ["service", { task: "api", kind: "service", start: { cmd: "node", args: ["server.js"] }, ready: { port: 3000, timeoutMs: 5000 }, requests: [{ path: "/api/score" }], checks: ["status 200"] }],
  ["echo a variable", { task: "t1", cmd: "echo $RESULT", checks: ['stdout contains "ok"'] }],
  ["echo then a pipe", { task: "t1", cmd: "echo ok | node check.js", checks: ['stdout contains "ok"'] }],
  ["echo into a file", { task: "t1", cmd: "sh", args: ["-c", "node app.js > out.txt && cat out.txt"], checks: ['stdout contains "ok"'] }],
  ["node -e that requires the deliverable", { task: "t1", cmd: "node", args: ["-e", "console.log(require('./sum')(2, 3))"], checks: ['stdout contains "5"'] }],
  ["cat of a written file", { task: "t1", cmd: "cat", args: ["result.txt"], checks: ['stdout contains "ok"'] }],
  ["a fixed print that its checks reject cannot pass, not always pass", { task: "t1", cmd: "echo ok", checks: ['stdout contains "done"'] }],
  ["a fixed print expecting a failure", { task: "t1", cmd: "echo ok", checks: ["exit 1"] }],
  ["python running a file", { task: "t1", cmd: "python3", args: ["main.py"], checks: ["exit 0", 'stdout contains "Total: 12"'] }],
];

describe("contract check lint — severe: a check that cannot fail", () => {
  it.each(SEVERE_CHECKS)("%s is severe", (_name, check) => {
    expect(severeOf(check)).toEqual(["fixed-output"]);
  });

  it.each(CLEAN_CHECKS)("%s is never severe", (_name, check) => {
    expect(severeOf(check)).toEqual([]);
  });

  it("reads only plain words: anything a shell could expand or redirect is not a fixed print", () => {
    expect(splitPlainCommand(`echo "it's fine"`)).toEqual(["echo", "it's fine"]);
    for (const line of ["echo ok > x", "echo `date`", 'echo "$HOME"', "echo ok; rm x", "echo *", "echo ok && cat x", "echo (x)"]) {
      expect(splitPlainCommand(line)).toBeNull();
    }
    expect(fixedOutputOf(["node", "-e", "console.log(x)"])).toBeNull();
    expect(fixedOutputOf(["node", "-e", "console.log(`${a}`)"])).toBeNull();
    expect(fixedOutputOf(["node", "script.js"])).toBeNull();
    expect(fixedOutputOf(["echo", "-e", "a\\tb"])).toBeNull();
    expect(fixedOutputOf(["printf", "%s", "x"])).toBeNull();
    expect(fixedOutputOf(["echo", "ok"])).toEqual({ stdout: "ok\n" });
    expect(fixedOutputOf(["node", "-e", "console.log('a', 2); console.log(\"b\")"])).toEqual({ stdout: "a 2\nb\n" });
  });
});

describe("contract check lint — warnings and hints", () => {
  it("an expectation that failure output also satisfies is a warning, never severe", () => {
    expect(rulesOf({ task: "t", cmd: "node", args: ["--test"], checks: ['stdout contains "passed"'] })).toEqual(["error-output-match:warning"]);
    expect(rulesOf({ task: "t", cmd: "npm", args: ["test"], checks: ["exit 0", "stdout matches /ok/"] })).toEqual(["error-output-match:warning"]);
    expect(rulesOf({ task: "t", cmd: "node", args: ["app.js"], checks: ['stderr contains "not found"'] })).toEqual(["error-output-match:warning"]);
  });

  it("a check that observes an error on purpose raises nothing about error phrases", () => {
    expect(rulesOf({ task: "t", cmd: "node", args: ["sales.cjs", "bad.csv"], checks: ["exit != 0", 'stderr contains "failed"'] })).toEqual([]);
    expect(rulesOf({ task: "t", cmd: "node", args: ["sales.cjs", "bad.csv"], checks: ["exit 1", 'stderr contains "Invalid row 2"'] })).toEqual([]);
  });

  it("a check that only asserts absences is a warning", () => {
    expect(rulesOf({ task: "t", cmd: "node", args: ["app.js"], checks: ['stdout not contains "Error"'] })).toEqual(["absence-only:warning"]);
    expect(rulesOf({ task: "t", kind: "page", path: "index.html", checks: ["no errors"] })).toEqual(["absence-only:warning"]);
  });

  it("a number the check's own input already holds is a hint; one only from the brief is nothing", () => {
    expect(rulesOf({ task: "t", cmd: "node", args: ["sum.js"], stdin: "21\n", checks: ['stdout contains "21"'] })).toEqual(["echoed-number:hint"]);
    expect(rulesOf({ task: "t", cmd: "node", args: ["sales.cjs", "in.csv"], checks: ['stdout contains "{\\"A\\":2500}"'] })).toEqual([]);
  });

  it.each(CLEAN_CHECKS.filter(([name]) => name.startsWith("csv") || name.startsWith("game") || name === "service"))(
    "real e2e contract %s carries no reservation", (_name, check) => {
      expect(lintContractCheck(check, 0).filter((f) => f.severity !== "hint")).toEqual([]);
    });

  it("reservations come from warnings only, by check index", () => {
    const contract: DelegateContract = {
      checks: [
        { task: "t", cmd: "node", args: ["--test"], checks: ['stdout contains "passed"'] },
        { task: "t", cmd: "node", args: ["--test"], checks: ["exit 0"] },
        { task: "t", cmd: "node", args: ["sum.js"], stdin: "21", checks: ['stdout contains "21"'] },
      ],
    };
    expect([...checkReservations(contract).keys()]).toEqual([0]);
  });

  it("names task checks without criteria when the brief has criteria, as one hint", () => {
    const contract: DelegateContract = { checks: [{ task: "t", cmd: "node", args: ["a.js"] }, { task: "t", criteria: ["c1"], cmd: "node", args: ["b.js"] }, { cmd: "node", args: ["c.js"] }] };
    expect(checksWithoutCriteriaHint(contract, 0)).toBeNull();
    expect(checksWithoutCriteriaHint(contract, 2)).toMatch(/^check lint \(hint\): contract\.checks\[0\] names no success criterion/);
  });
});

describe("contract check lint — examples", () => {
  const where = "contract.provides[0].example.expect";
  it.each(["true", "1", "!0", "1 === 1", "'ok'", "(true)", "r === r", "r.x > 0 || true", "true || r.ok"])("`%s` is severe", (expect_) => {
    expect(lintExampleExpect(expect_, where)?.severity).toBe("severe");
  });
  it.each(["r !== undefined", "r != null", "typeof r !== 'undefined'", "!!r"])("`%s` is a warning", (expect_) => {
    expect(lintExampleExpect(expect_, where)?.severity).toBe("warning");
  });
  it.each([
    "r.length === 8 && 'w' in r[0] && 'o' in r[0]",
    "r === 5",
    "typeof PHYS.corners === 'function'",
    "Array.isArray(r) && r.length > 0",
    "r.ok ? r.total === 3 : false",
    "JSON.stringify(r) === '{\"X\":0}'",
  ])("`%s` is clean", (expect_) => {
    expect(lintExampleExpect(expect_, where)).toBeNull();
  });

  it("lints a contract's examples after its checks", () => {
    const contract: DelegateContract = {
      provides: [{ task: "t", kind: "symbol", name: "sum", in: "sum.js", example: { call: "sum(2,3)", expect: "true" } }],
      checks: [{ task: "t", cmd: "echo ok" }],
    };
    expect(lintContract(contract).map((f) => f.where)).toEqual(["contract.checks[0]", "contract.provides[0].example.expect"]);
  });
});

describe("parseDelegateArgs refuses a contract that cannot fail (issue #110)", () => {
  const tasks = [{ id: "t1", instructions: "write sales.cjs", files: ["sales.cjs"] }];

  it("refuses `echo ok` / `stdout contains \"ok\"` with a reason the director can fix", () => {
    const parsed = parseDelegateArgs({ tasks, contract: { checks: [{ task: "t1", kind: "command", cmd: "echo ok", checks: ['stdout contains "ok"'] }] } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("contract.checks[0] cannot fail: `echo ok` only prints fixed text");
    expect(parsed.error).toContain("run what the tasks produce");
  });

  it("refuses an example whose expect is `true`", () => {
    const parsed = parseDelegateArgs({
      tasks,
      contract: { provides: [{ task: "t1", kind: "symbol", name: "sum", in: "sum.js", example: { call: "sum(2,3)", expect: "true" } }] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("contract.provides[0].example.expect is always");
  });

  it("passes the real CSV and game contracts through", () => {
    const parsed = parseDelegateArgs({
      tasks: [{ id: "program", instructions: "x" }, { id: "tests", instructions: "y" }, { id: "ui", instructions: "z" }, { id: "cli", instructions: "w" }, { id: "api", instructions: "v" }, { id: "t1", instructions: "u" }],
      contract: { checks: CLEAN_CHECKS.slice(0, 16).map(([, check]) => check) },
    });
    expect(parsed.ok).toBe(true);
  });
});
