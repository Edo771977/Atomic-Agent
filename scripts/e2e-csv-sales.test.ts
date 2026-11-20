// Issue #95 item 4: our own parts of the CSV sales end-to-end fixture. The
// acceptance test must pass a correct program and catch the defects a live
// run showed (a `{}` accumulator hit by the sku "toString", no header check)
// and loose number parsing; the runner must read a recorded run (its printed
// session, receipts, the session store and the outcome log) into the report.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs script without declarations
import * as runner from "./e2e-csv-sales.mjs";

const FIXTURES = resolve(import.meta.dirname, "test-fixtures/csv-sales");
const SAMPLE = join(FIXTURES, "sample-run");
const PROMPT = resolve(import.meta.dirname, "../docs/testing/fixtures/csv-sales/prompt.txt");
const temps: string[] = [];
const temp = (name: string): string => { const d = mkdtempSync(join(tmpdir(), name)); temps.push(d); return d; };
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** The acceptance test against one implementation: exit code and TAP counts. */
function acceptance(program: string): { exitCode: number | null; pass: number | null; fail: number | null; failed: string[] } {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", runner.ACCEPTANCE_TEST], {
    encoding: "utf8", env: { ...process.env, CSV_SALES_PROGRAM: join(FIXTURES, program) }, timeout: 60_000,
  });
  return { exitCode: r.status, ...runner.parseTap(r.stdout) };
}

describe("the independent acceptance test", () => {
  it("passes a correct implementation, every case", () => {
    const r = acceptance("reference-sales.cjs");
    expect(r.failed).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.fail).toBe(0);
    expect(r.pass).toBe(10);
  });

  it("fails the plain-object accumulator on the prototype-key skus, and only there", () => {
    const r = acceptance("tostring-bug-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual(["prototype-key skus are ordinary skus"]);
  });

  it("fails a program without header validation on the wrong first line", () => {
    const r = acceptance("no-header-check-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual([
      "a wrong first line is refused with \"Invalid header\"",
      "a valid header further down does not rescue a wrong first line",
    ]);
  });

  it("fails parseInt-style number checks on negative and fractional numbers", () => {
    const r = acceptance("parseint-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual(["negative numbers are refused", "non-integer numbers are refused"]);
  });

  it("fails when there is no program at all", () => {
    const r = acceptance("missing-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.pass).toBe(0);
  });
});

describe("the task prompt", () => {
  it("is one line, since `atomic-agent run` takes each piped line as a turn, and names the interface", () => {
    const text = readFileSync(PROMPT, "utf8");
    expect(text.trimEnd().split(/\r?\n/)).toHaveLength(1);
    for (const words of ["sales.cjs", "node --test sales.test.cjs", "sku,qty,price_cents", "Invalid header", "Invalid row", "toString", "__proto__", "exit 1"]) {
      expect(text).toContain(words);
    }
  });
});

describe("the runner's parsing", () => {
  it("reads its options and refuses bad ones", () => {
    expect(runner.parseArgs(["--cwd", "w", "--log", "a", "--log", "b", "--run-exit", "3", "--session", "s"])).toEqual({
      cwd: "w", stateDir: null, session: "s", logs: ["a", "b"], runExit: 3, output: null,
    });
    expect(runner.parseArgs([])).toEqual({ error: "--cwd is required" });
    expect(runner.parseArgs(["--cwd"])).toEqual({ error: "--cwd needs a value" });
    expect(runner.parseArgs(["--cwd", "w", "--run-exit", "x"])).toEqual({ error: "--run-exit needs a whole number" });
    expect(runner.parseArgs(["--cwd", "w", "--json"])).toEqual({ error: "unknown option --json" });
  });

  it("reads TAP counts and failing test names", () => {
    const tap = "TAP version 13\nok 1 - a\nnot ok 2 - b fails # with a note\n  ---\n1..2\n# tests 2\n# pass 1\n# fail 1\n";
    expect(runner.parseTap(tap)).toEqual({ tests: 2, pass: 1, fail: 1, failed: ["b fails"] });
  });

  it("finds the printed session and the receipt lines in a recorded run", () => {
    const out = readFileSync(join(SAMPLE, "stdout.txt"), "utf8");
    const err = readFileSync(join(SAMPLE, "stderr.txt"), "utf8");
    expect(runner.sessionIdFromOutput(out)).toBe("sess_95e2e7f1");
    expect(runner.sessionIdFromOutput("nothing here")).toBeNull();
    expect(runner.receiptLines(err)).toHaveLength(3);
    expect(runner.receiptLines(err)[1]).toMatch(/^fusion receipt · strong \$0\.42/);
  });

  it("keeps only the session's outcome records: verdicts in order, receipts summed", () => {
    const lines = readFileSync(join(SAMPLE, "outcomes.ndjson"), "utf8").split("\n");
    const s = runner.outcomeSummary(lines, "sess_95e2e7f1");
    expect(s.sessionTag).toBe("e50f80be9b0f");
    expect(s.tasks.map((t: { status: string }) => t.status)).toEqual(["ok", "timeout"]);
    expect(s.tasks[0]).toMatchObject({ worker: "local-llama:qwen-3.6-35b-a3b", attempt: 2, taskRole: "implement",
      review: { decision: "needs-changes", reviewer: "codex-cli:default", majors: 1 } });
    expect(s.tasks[1].review).toBeNull();
    expect(s.unreviewedTasks).toBe(1);
    expect(s.receipts.turns).toHaveLength(3);
    expect(s.receipts.strongUsd).toBe(0.903039);
    expect(s.receipts.workerUsd).toBe(0);
    expect(runner.outcomeSummary(lines, "someone-else").tasks).toEqual([]);
  });

  it("records a whole run: both suites, the stored milestone, the verdicts and the spend", async () => {
    const cwd = temp("csv-sales-run-");
    copyFileSync(join(FIXTURES, "reference-sales.cjs"), join(cwd, "sales.cjs"));
    copyFileSync(join(SAMPLE, "agent-sales.test.cjs"), join(cwd, "sales.test.cjs"));
    const stateDir = temp("csv-sales-state-");
    mkdirSync(join(stateDir, "fusion"));
    copyFileSync(join(SAMPLE, "outcomes.ndjson"), join(stateDir, "fusion", "outcomes.ndjson"));
    const stored = JSON.parse(readFileSync(join(SAMPLE, "session.json"), "utf8"));
    const db = new DatabaseSync(join(stateDir, "sessions.sqlite"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, turn_owner TEXT)");
    const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, 1, ?, NULL)");
    insert.run(stored.id, cwd, "active", JSON.stringify(stored), 2);
    insert.run("older", cwd, "active", JSON.stringify({ id: "older" }), 1);
    db.close();
    const out = join(stateDir, "report.json");
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "e2e-csv-sales.mjs"), "--cwd", cwd, "--state-dir", stateDir,
      "--log", join(SAMPLE, "stdout.txt"), "--log", join(SAMPLE, "stderr.txt"), "--run-exit", "3", "--output", out], { encoding: "utf8", timeout: 120_000 });
    expect(r.stderr).toContain("report:");
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.run).toMatchObject({ exitCode: 3, printedSession: "sess_95e2e7f1" });
    expect(report.run.receiptLines).toHaveLength(3);
    expect(report.session).toMatchObject({ id: "sess_95e2e7f1", status: "active", workingDir: cwd });
    expect(report.tests.acceptance).toMatchObject({ exitCode: 0, pass: 10, fail: 0 });
    expect(report.tests.agent).toMatchObject({ exitCode: 0, pass: 1, fail: 0 });
    expect(report.tests.passed).toBe(true);
    expect(report.project.gate).toEqual({ kind: "milestone", id: "m1" });
    expect(report.project.milestones).toEqual([expect.objectContaining({ id: "m1", state: "failed", runIds: ["run-a1"] })]);
    expect(report.project.plan.rows.map((row: { taskId: string; reviewer: string }) => [row.taskId, row.reviewer])).toEqual([["t1", "codex-cli:default"], ["t2", "codex-cli:default"]]);
    expect(report.verdicts.map((v: { review: { decision: string } | null }) => v.review?.decision ?? null)).toEqual(["needs-changes", null]);
    expect(report.unreviewedTasks).toBe(1);
    expect(report.receipts.strongUsd).toBe(0.903039);
  });

  it("exits 1 when the program fails the acceptance test, and names the session found by folder", async () => {
    const cwd = temp("csv-sales-bad-");
    copyFileSync(join(FIXTURES, "tostring-bug-sales.cjs"), join(cwd, "sales.cjs"));
    const stateDir = temp("csv-sales-empty-");
    const report = await runner.buildReport({ cwd, stateDir, session: null, logs: [], runExit: null, output: null });
    expect(report.tests.acceptance.exitCode).not.toBe(0);
    expect(report.tests.acceptance.failed).toEqual(["prototype-key skus are ordinary skus"]);
    expect(report.tests.agent).toMatchObject({ exitCode: null, error: "not found" });
    expect(report.tests.passed).toBe(false);
    expect(report.session.error).toMatch(/no session store/);
    expect(report.project).toBeNull();
  });
});
