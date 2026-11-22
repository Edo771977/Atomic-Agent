// Issue #95 item 4: our own parts of the CSV sales end-to-end fixture. The
// acceptance test must pass a correct program and catch the defects a live
// run showed (a `{}` accumulator hit by the sku "toString", no header check)
// and loose number parsing; the runner must read a recorded run (its printed
// session, receipts, the session store and the outcome log) into the report.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
    expect(r.pass).toBe(17);
  });

  // Issue #100: the live program lost its blank-line handling and still passed the 10 cases.
  it("fails a program that refuses blank lines on the blank-line cases, and only there", () => {
    const r = acceptance("rejects-blank-lines-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual([
      "a blank line between two sales is skipped",
      "several trailing blank lines are skipped",
      "an invalid row after a blank line names its physical line number",
    ]);
  });

  // Issue #106: the final program refused `X,9007199254740993,0`, whose total is exactly zero.
  it("fails a program that limits each number instead of the total on the zero-total cases, and only there", () => {
    const r = acceptance("per-number-limit-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual([
      "a zero price makes a huge quantity a zero total",
      "a zero quantity makes a huge price a zero total",
    ]);
  });

  it("fails an overflow check with >= on the total exactly at the limit, and only there", () => {
    const r = acceptance("overflow-off-by-one-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual(["a total exactly at Number.MAX_SAFE_INTEGER is accepted"]);
  });

  it("fails a program that numbers lines without the blank ones on the physical line number", () => {
    const r = acceptance("counts-without-blanks-sales.cjs");
    expect(r.exitCode).not.toBe(0);
    expect(r.failed).toEqual(["an invalid row after a blank line names its physical line number"]);
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
    for (const words of ["Blank lines", "physical line number", "Invalid row N", "accumulated total", "any number of digits", "exactly zero", "sales.cjs", "node --test sales.test.cjs", "sku,qty,price_cents", "Invalid header", "Invalid row", "toString", "__proto__", "exit 1"]) {
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
    expect(runner.parseTap(tap)).toEqual({ tests: 2, pass: 1, fail: 1, failed: ["b fails"], passed: ["a"] });
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
    // Both suites pass, but the issue #95 run is not a pass (issue #98): t1 asked for changes, t2 has no review.
    expect(r.status).toBe(1);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.run).toMatchObject({ exitCode: 3, printedSession: "sess_95e2e7f1" });
    expect(report.run.receiptLines).toHaveLength(3);
    expect(report.session).toMatchObject({ id: "sess_95e2e7f1", status: "active", workingDir: cwd });
    expect(report.tests.acceptance).toMatchObject({ exitCode: 0, pass: 17, fail: 0 });
    expect(report.tests.agent).toMatchObject({ exitCode: 0, pass: 1, fail: 0 });
    expect(report.tests.passed).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.blocking).toEqual([
      "task t1 (sales.cjs: the summarizer): not accepted: needs-changes",
      "task t2 (sales.test.cjs: its tests): not accepted: no review, latest timeout",
      "the project waits at its milestone gate",
    ]);
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

describe("verdicts joined to plan rows (taskKey / milestoneKey)", () => {
  const plan = JSON.parse(readFileSync(join(SAMPLE, "session.json"), "utf8")).project;

  it("keys an id as the outcome log does: sha256 of the UTF-8 id, 16 hex characters", () => {
    expect(runner.outcomeKey("t1")).toBe("628b49d96dcde97a");
    expect(runner.outcomeKey("ü")).toHaveLength(16);
  });

  it("puts each keyed verdict next to its task, and an old row without a key by order, labelled unjoined", () => {
    const lines = readFileSync(join(SAMPLE, "outcomes.ndjson"), "utf8").split("\n");
    const tasks = runner.joinVerdicts(runner.projectSummary(plan), runner.outcomeSummary(lines, "sess_95e2e7f1").tasks);
    expect(tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["t1", "t2"]);
    expect(tasks[0]).toMatchObject({ milestoneId: "m1", reviewer: "codex-cli:default" });
    expect(tasks[0].verdicts).toEqual([expect.objectContaining({ join: "key", status: "ok", review: expect.objectContaining({ decision: "needs-changes" }) })]);
    // The test task's record is from an older build: no key, matched by order and said so.
    expect(tasks[1].verdicts).toEqual([expect.objectContaining({ join: "order (unjoined)", status: "timeout", review: null })]);
  });

  it("never puts a keyed verdict of another task or milestone on a row", () => {
    const keyed = (taskId: string, milestoneId: string) => ({ status: "ok", review: null, taskKey: runner.outcomeKey(taskId), milestoneKey: runner.outcomeKey(milestoneId) });
    const tasks = runner.joinVerdicts(runner.projectSummary(plan), [keyed("t2", "m1"), keyed("t9", "m1"), keyed("t1", "m7")]);
    expect(tasks[0].verdicts).toEqual([]);
    expect(tasks[1].verdicts).toEqual([expect.objectContaining({ join: "key" })]);
    expect(runner.joinVerdicts(null, [keyed("t1", "m1")])).toEqual([]);
  });

  it("the report lists the tasks with their verdicts, and verdicts no task took", async () => {
    const cwd = temp("csv-sales-join-");
    copyFileSync(join(FIXTURES, "reference-sales.cjs"), join(cwd, "sales.cjs"));
    const stateDir = temp("csv-sales-join-state-");
    mkdirSync(join(stateDir, "fusion"));
    const extra = JSON.stringify({ v: 7, type: "task", ts: "2026-11-20T09:19:00.000Z", session: runner.sessionTag("sess_95e2e7f1"), provider: "p", model: "m",
      status: "ok", attempt: 1, taskKey: runner.outcomeKey("gone"), milestoneKey: runner.outcomeKey("m1") });
    writeFileSync(join(stateDir, "fusion", "outcomes.ndjson"), readFileSync(join(SAMPLE, "outcomes.ndjson"), "utf8") + extra + "\n");
    const stored = JSON.parse(readFileSync(join(SAMPLE, "session.json"), "utf8"));
    const db = new DatabaseSync(join(stateDir, "sessions.sqlite"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, turn_owner TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?, ?, 'active', ?, 1, 2, NULL)").run(stored.id, cwd, JSON.stringify(stored));
    db.close();
    const report = await runner.buildReport({ cwd, stateDir, session: null, logs: [], runExit: null, output: null });
    expect(report.tasks.map((t: { taskId: string; verdicts: Array<{ join: string }> }) => [t.taskId, t.verdicts.map((v) => v.join)]))
      .toEqual([["t1", ["key"]], ["t2", ["order (unjoined)"]]]);
    expect(report.unmatchedVerdicts).toEqual([expect.objectContaining({ taskKey: runner.outcomeKey("gone") })]);
  });
});

/* ---------- issue #98: the runner's verdict ---------- */

/** A run folder with green suites and a state folder holding `sample`'s session and outcome log; the runner's exit and report. */
function runSample(sample: string, options: { program?: string } = {}): { status: number | null; report: any } {
  const dir = join(FIXTURES, sample);
  const cwd = temp("csv-sales-98-");
  copyFileSync(join(FIXTURES, options.program ?? "reference-sales.cjs"), join(cwd, "sales.cjs"));
  copyFileSync(join(SAMPLE, "agent-sales.test.cjs"), join(cwd, "sales.test.cjs"));
  const stateDir = temp("csv-sales-98-state-");
  mkdirSync(join(stateDir, "fusion"));
  copyFileSync(join(dir, "outcomes.ndjson"), join(stateDir, "fusion", "outcomes.ndjson"));
  const stored = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  const db = new DatabaseSync(join(stateDir, "sessions.sqlite"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, turn_owner TEXT)");
  db.prepare("INSERT INTO sessions VALUES (?, ?, 'active', ?, 1, 2, NULL)").run(stored.id, cwd, JSON.stringify(stored));
  db.close();
  // The run's file checkpoints (<stateDir>/file-checkpoints/<session>/), their paths in this run folder.
  const checkpoints = join(dir, "file-checkpoints");
  if (existsSync(checkpoints)) {
    const into = join(stateDir, "file-checkpoints", stored.id);
    mkdirSync(into, { recursive: true });
    for (const name of readdirSync(checkpoints)) copyFileSync(join(checkpoints, name), join(into, name));
    const index = readFileSync(join(into, "index.json"), "utf8").replaceAll("{cwd}/", JSON.stringify(cwd + sep).slice(1, -1));
    writeFileSync(join(into, "index.json"), index);
  }
  // Another session's checkpoints in the same state dir (another chat, another project).
  const other = join(dir, "file-checkpoints-other-session");
  if (existsSync(other)) {
    const into = join(stateDir, "file-checkpoints", "s-otherproject");
    mkdirSync(into, { recursive: true });
    for (const name of readdirSync(other)) copyFileSync(join(other, name), join(into, name));
    writeFileSync(join(into, "index.json"), readFileSync(join(into, "index.json"), "utf8").replaceAll("{cwd}/", JSON.stringify(cwd + sep).slice(1, -1)));
  }
  const out = join(stateDir, "report.json");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "e2e-csv-sales.mjs"), "--cwd", cwd, "--state-dir", stateDir,
    "--log", join(dir, "stdout.txt"), "--output", out], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, report: JSON.parse(readFileSync(out, "utf8")) };
}

describe("the runner passes a run only when every required task is accepted", () => {
  it("green suites with an open review block (needs-changes, then no_changes) exit 1 and name the block", () => {
    const { status, report } = runSample("sample-run-blocked");
    expect(report.tests.passed).toBe(true);
    expect(status).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.blocking).toEqual(expect.arrayContaining([
      expect.stringMatching(/^task t2 .*needs-changes.*no_changes/),
      expect.stringMatching(/^milestone m1 is reviewed while 1 required task is not accepted/),
    ]));
    expect(report.blocking.some((b: string) => /^task t1 .*not accepted/.test(b))).toBe(false);   // t1 is accepted (its review only lacks a provider, issue #100)
    expect(report.tasks.map((t: { taskId: string; latest: { status: string; decision: string | null } }) => [t.taskId, t.latest.decision ?? t.latest.status]))
      .toEqual([["t1", "accept"], ["t2", "no_changes"]]);
  });

  it("every task's latest verdict accepted, the milestone reviewed: exit 0, nothing blocking", () => {
    const { status, report } = runSample("sample-run-accepted");
    expect(report.blocking).toEqual([]);
    expect(report.passed).toBe(true);
    expect(status).toBe(0);
  });

  it("an earlier accept does not count once a later verdict asks for changes, and a missing verdict blocks", () => {
    const project = { plan: { rows: [{ taskId: "a", milestoneId: "m", reviewer: "r:x" }, { taskId: "b", milestoneId: "m", reviewer: "r:x" }] },
      milestones: [{ id: "m", state: "done" }], gate: { kind: "none" } };
    const v = (taskId: string, decision: string | null, status = "ok") => ({ taskKey: runner.outcomeKey(taskId), milestoneKey: runner.outcomeKey("m"), status,
      review: decision ? { decision, reviewer: "r:x" } : null });
    const tasks = runner.joinVerdicts(project, [v("a", "accept"), v("a", "needs-changes")]);
    const blocking = runner.blockingReasons({ tests: { passed: true }, project, tasks });
    expect(blocking).toEqual([
      expect.stringMatching(/^task a .*needs-changes/),
      expect.stringMatching(/^task b .*no verdict/),
      expect.stringMatching(/^milestone m is done while 2 required tasks are not accepted/),
    ]);
    expect(runner.blockingReasons({ tests: { passed: false }, project: null, tasks: [] })).toEqual(["the test suites did not both pass", "no project was stored for the session"]);
  });
});

describe("the reviewer's identity", () => {
  it("reads the runtime's structured reviewer fields alongside a model-only label", () => {
    const project = { plan: { rows: [{ taskId: "report", milestoneId: "delivery", reviewer: "team:editor" }] } };
    const line = JSON.stringify({
      type: "task", ts: "1", session: runner.sessionTag("s"), status: "ok",
      taskKey: runner.outcomeKey("report"), milestoneKey: runner.outcomeKey("delivery"),
      review: {
        decision: "accept", reviewer: "substitute", reviewerProvider: "team",
        reviewerModel: "substitute", reviewerPlanRef: "team:editor",
      },
    });
    const { tasks } = runner.outcomeSummary([line], "s");
    const [task] = runner.joinVerdicts(project, tasks);
    expect(task.latestReview).toEqual({
      planned: "team:editor", recorded: "team:substitute", reviewedBy: "reviewer",
      provider: "team", model: "substitute", planRef: "team:editor", mismatch: false,
    });
  });

  it("records provider and effective model, and flags a reviewer that is not the plan's", () => {
    const blocked = runSample("sample-run-blocked").report;
    expect(blocked.tasks[1].latestReview).toMatchObject({ planned: "codex-cli:default", recorded: "default", mismatch: true });
    const accepted = runSample("sample-run-accepted").report;
    expect(accepted.tasks[0].latestReview).toEqual({ planned: "codex-cli:default", reviewedBy: "reviewer", recorded: "codex-cli:default", provider: "codex-cli",
      model: "gpt-5.5-codex", planRef: "codex-cli:default", mismatch: false });
  });
});

describe("autonomous run or guided resume", () => {
  it("one prompt with the auto-approval continuations is autonomous; a person's line after it is a guided resume", () => {
    expect(runSample("sample-run-accepted").report.mode).toMatchObject({ kind: "autonomous", humanInputs: 0, runStarts: 1 });
    const guided = runSample("sample-run-blocked").report.mode;
    expect(guided).toMatchObject({ kind: "guided", humanInputs: 1 });
    expect(guided.reasons).toEqual([expect.stringMatching(/^1 line from a person after the first prompt/)]);
    expect(runner.runMode([{ kind: "user", text: "go" }], "session: a\nsession: b\n").kind).toBe("guided");
  });
});

/* ---------- issue #100: the report's integrity ---------- */

describe("a run passes only on a plan whose tasks and reviews can be accounted for", () => {
  it("an accepted task tied to a milestone the project does not have exits 1 and names it", () => {
    const { status, report } = runSample("sample-run-missing-milestone");
    expect(report.tests.passed).toBe(true);
    expect(report.blocking).toEqual(["task t2 (sales.test.cjs: its tests) belongs to milestone m9, which the project does not have"]);
    expect(report.passed).toBe(false);
    expect(status).toBe(1);
  });

  it("a required review accepted with no reviewer identity exits 1 and names it", () => {
    const { status, report } = runSample("sample-run-anonymous-review");
    expect(report.blocking).toEqual(["task t2 (sales.test.cjs: its tests): its review names no reviewer provider (the plan names codex-cli:default)"]);
    expect(status).toBe(1);
  });

  it("a review naming only a model, as the issue #98 rows wrote `default`, is not identifiable either", () => {
    const blocked = runSample("sample-run-blocked").report.blocking;
    expect(blocked).toEqual(expect.arrayContaining([
      "task t1 (sales.cjs: the summarizer): its review names no reviewer provider (the plan names codex-cli:default)",
    ]));
  });

  it("the accepted sample still passes", () => {
    expect(runSample("sample-run-accepted").status).toBe(0);
  });
});

/* ---------- issue #100: an accept decided by the task's own checks, no reviewer ---------- */

describe("an accept by the task's checks alone", () => {
  it("passes on green checks, but is listed apart and never shown as the reviewer's accept", () => {
    const { status, report } = runSample("sample-run-facts-accept");
    expect(report.blocking).toEqual([]);
    expect(status).toBe(0);
    expect(report.acceptedByChecksOnly).toEqual([{ taskId: "t2", title: "sales.test.cjs: its tests", configuredReviewer: "codex-cli", acceptance: "checks-passed" }]);
    const t2 = report.tasks[1].latestReview;
    expect(t2).toMatchObject({ reviewedBy: "facts", configured: "codex-cli", planned: "codex-cli:default" });
    expect(t2.recorded).toBeUndefined();
    expect(t2.provider).toBeUndefined();
    expect(report.tasks[0].latestReview).toMatchObject({ reviewedBy: "reviewer", provider: "codex-cli" });
    expect(runSample("sample-run-accepted").report.acceptedByChecksOnly).toEqual([]);
  });

  it("reads the source on the row or in its review, and an accept by checks that did not pass blocks", () => {
    const project = { plan: { rows: [{ taskId: "a", title: "A", milestoneId: "m", reviewer: "codex-cli:default" }] }, milestones: [{ id: "m", state: "done" }], gate: { kind: "none" } };
    const line = (extra: object, review: object) => JSON.stringify({ type: "task", ts: "1", session: runner.sessionTag("s"), status: "ok",
      taskKey: runner.outcomeKey("a"), milestoneKey: runner.outcomeKey("m"), ...extra, review: { decision: "accept", provider: "codex-cli", ...review } });
    const cases: Array<[object, object]> = [[{ reviewerSource: "facts", acceptance: "checks-passed" }, {}], [{ acceptance: "checks-passed" }, { source: "facts" }]];
    for (const [extra, review] of cases) {
      const tasks = runner.joinVerdicts(project, runner.outcomeSummary([line(extra, review)], "s").tasks);
      expect(tasks[0].latestReview.reviewedBy).toBe("facts");
      expect(runner.blockingReasons({ tests: { passed: true }, project, tasks })).toEqual([]);
    }
    const red = runner.joinVerdicts(project, runner.outcomeSummary([line({ reviewerSource: "facts", acceptance: "checks-failed" }, {})], "s").tasks);
    expect(runner.blockingReasons({ tests: { passed: true }, project, tasks: red })).toEqual([
      "task a (A): not accepted: accept by its checks, which did not pass",
      "milestone m is done while 1 required task is not accepted",
    ]);
  });
});

/* ---------- issue #106: the suite before and after the reviewer's changes ---------- */

describe("earlier versions of sales.cjs", () => {
  it("runs the acceptance suite on each version the run's file checkpoints kept, and names a case that regressed", () => {
    const { status, report } = runSample("sample-run-regressed", { program: "per-number-limit-sales.cjs" });
    expect(status).toBe(1);
    // Only this session's copies of the run folder's sales.cjs from its own time count: the same bytes twice, another file,
    // a copy from before the session, a sales.cjs in another folder, one after its last update and another session's are not.
    expect(report.earlierVersions).toHaveLength(1);
    expect(report.earlierVersions[0].sha256).toBe(createHash("sha256").update(readFileSync(join(FIXTURES, "reference-sales.cjs"))).digest("hex"));
    expect(report.earlierVersions[0]).toMatchObject({ tool: "os.fs.edit", at: 1795640100000, acceptance: { exitCode: 0, pass: 17, fail: 0 } });
    expect(report.earlierVersions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.regressed).toEqual([
      { test: "a zero price makes a huge quantity a zero total", passedIn: [report.earlierVersions[0].sha256] },
      { test: "a zero quantity makes a huge price a zero total", passedIn: [report.earlierVersions[0].sha256] },
    ]);
    expect(report.blocking).toEqual(expect.arrayContaining([
      "the final sales.cjs fails 2 acceptance cases an earlier version passed: a zero price makes a huge quantity a zero total; a zero quantity makes a huge price a zero total",
    ]));
  });

  it("says when no earlier version is available, and invents none", () => {
    const { report } = runSample("sample-run-accepted");
    expect(report.earlierVersions).toBe("unavailable");
    expect(report.earlierVersionsWhy).toMatch(/no file checkpoints for session sess_98accepted/);
    expect(report.regressed).toEqual([]);
  });
});

describe("earlier versions are only this session's, of this run folder's sales.cjs, within the session's time", () => {
  const sid = "s-run1";
  const write = (stateDir: string, folder: string, entries: Array<{ path: string; at: number; body: string }>) => {
    const dir = join(stateDir, "file-checkpoints", folder);
    mkdirSync(dir, { recursive: true });
    const index = { version: 1, next: entries.length + 1, totalBytes: 0, droppedThrough: 0,
      entries: entries.map((e, i) => { writeFileSync(join(dir, `${i + 1}.bin`), e.body); return { n: i + 1, path: e.path, at: e.at, tool: "os.fs.write", existed: true, file: `${i + 1}.bin` }; }) };
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
  };
  const window = { from: 100, to: 200 };

  it("ignores another session's sales.cjs", () => {
    const stateDir = temp("csv-sales-c1-");
    const cwd = temp("csv-sales-c1-run-");
    write(stateDir, "s-other", [{ path: join(cwd, "sales.cjs"), at: 150, body: "other" }]);
    expect(runner.earlierProgramVersions(stateDir, cwd, sid, window, null)).toBeNull();
    write(stateDir, sid, [{ path: join(cwd, "sales.cjs"), at: 150, body: "mine" }]);
    expect(runner.earlierProgramVersions(stateDir, cwd, sid, window, null).map((v: { at: number }) => v.at)).toEqual([150]);
  });

  it("ignores a sales.cjs from another folder in the same session", () => {
    const stateDir = temp("csv-sales-c1-");
    const cwd = temp("csv-sales-c1-run-");
    write(stateDir, sid, [{ path: join(cwd, "sub", "sales.cjs"), at: 150, body: "a" }, { path: join(temp("csv-sales-c1-else-"), "sales.cjs"), at: 160, body: "b" }]);
    expect(runner.earlierProgramVersions(stateDir, cwd, sid, window, null)).toEqual([]);
  });

  it("ignores copies taken before the session started or after its last update", () => {
    const stateDir = temp("csv-sales-c1-");
    const cwd = temp("csv-sales-c1-run-");
    write(stateDir, sid, [{ path: join(cwd, "sales.cjs"), at: 99, body: "before" }, { path: join(cwd, "sales.cjs"), at: 201, body: "after" },
      { path: join(cwd, "sales.cjs"), at: 200, body: "last" }]);
    expect(runner.earlierProgramVersions(stateDir, cwd, sid, window, null).map((v: { at: number }) => v.at)).toEqual([200]);
  });
});
