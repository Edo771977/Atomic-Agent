import { evidencePath, fileSha256 } from "./attempt-evidence.js";

/**
 * Execution evidence (issue #102): what a worker's own test runs showed,
 * recorded by the runtime from the tool results as they came, not from
 * the worker's summary. In the live run the reviewer saw that the suite
 * passed but not which cases ran, and a worker that timed out before its
 * summary left nothing at all. Each `verify.run`, and each `os.shell.run`
 * that is a test command, keeps its command, the exit code, the SHA-256
 * of the task's declared files when it finished, and the test names with
 * their outcomes (`node --test` TAP or spec output; else the counts).
 */

/** One test case as the run reported it. */
export interface ExecutedTest {
  name: string;
  ok: boolean;
  skipped?: true;
}

/** One recorded test run of a worker. */
export interface ExecutionRun {
  tool: "verify.run" | "os.shell.run";
  command: string;
  /** The process's exit code; null when it reported none (killed, a page check). */
  exitCode: number | null;
  ok: boolean;
  /** The task's declared files as they were when the run finished. */
  files: Array<{ path: string; sha256?: string }>;
  /** The cases the output named, in order (at most {@link MAX_TESTS}). */
  tests: ExecutedTest[];
  /** The totals the output reported, when it did. */
  counts?: { pass: number; fail: number; total: number };
}

const MAX_TESTS = 60;
const MAX_NAME = 120;
const MAX_RUNS = 6;
const TEST_COMMAND = /(^|[\s/\\])(test|tests|--test)\b|\b(jest|vitest|mocha|pytest|ava|tap)\b|\bnpm\s+(run\s+)?test\b|\.test\.[cm]?[jt]s\b/i;

/**
 * The cases and totals in a test runner's output: TAP (`ok 1 - name`,
 * `not ok 2 - name`, `# pass 9`) and `node --test`'s spec reporter
 * (`✔ name (1ms)`, `✖ name`, `ℹ pass 9`). Subtests are kept as their own
 * lines; a `# Subtest:` header is not a case. Nothing found: no tests.
 */
export function parseTestOutput(text: string): { tests: ExecutedTest[]; counts?: { pass: number; fail: number; total: number } } {
  const tests: ExecutedTest[] = [];
  const totals: Record<string, number> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tap = /^(not ok|ok)\s+\d+(?:\s+-)?\s*(.*?)\s*(?:#\s*(SKIP|TODO)\b.*)?$/i.exec(line);
    if (tap !== null) {
      const name = (tap[2] ?? "").trim();
      if (name.length > 0) tests.push({ name: name.slice(0, MAX_NAME), ok: tap[1]!.toLowerCase() === "ok", ...(tap[3] === undefined ? {} : { skipped: true as const }) });
      continue;
    }
    const spec = /^([✔✓✖✗﹣-])\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?(?:\s+#\s*(SKIP|TODO)\b.*)?$/u.exec(line);
    if (spec !== null && spec[1] !== "-" && spec[1] !== "﹣") {
      tests.push({ name: spec[2]!.slice(0, MAX_NAME), ok: spec[1] === "✔" || spec[1] === "✓", ...(spec[3] === undefined ? {} : { skipped: true as const }) });
      continue;
    }
    const total = /^(?:#|ℹ)\s*(tests|pass|fail)\s+(\d+)\s*$/u.exec(line);
    if (total !== null) totals[total[1]!] = Number(total[2]);
  }
  // A suite line (spec reporter) repeats its cases' outcome: keep the
  // cases, which come before it, and drop a later duplicate name.
  const seen = new Set<string>();
  const unique = tests.filter((t) => {
    const key = `${t.name}\u0000${t.ok}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const counts = totals.pass !== undefined && totals.fail !== undefined
    ? { pass: totals.pass, fail: totals.fail, total: totals.tests ?? totals.pass + totals.fail }
    : undefined;
  return { tests: unique.slice(0, MAX_TESTS), ...(counts === undefined ? {} : { counts }) };
}

function commandOf(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  const cmd = typeof args.cmd === "string" ? args.cmd : "";
  const rest = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
  return [cmd, ...rest].join(" ").trim();
}

function outputOf(result: { summary: string; details?: Record<string, unknown>; fullOutput?: string }): string {
  if (typeof result.fullOutput === "string" && result.fullOutput.length > 0) return result.fullOutput;
  const d = result.details ?? {};
  const tails = [d.stdoutTail, d.stderrTail].filter((t): t is string => typeof t === "string" && t.length > 0);
  return tails.length > 0 ? tails.join("\n") : result.summary;
}

/** Fed from one worker run's `tool_call_parsed` / `tool_call_executed` events. */
export class ExecutionEvidenceTracker {
  private readonly pending = new Map<number, { tool: ExecutionRun["tool"]; command: string }>();
  private readonly runs: ExecutionRun[] = [];

  constructor(private readonly workingDir: string, private readonly declaredFiles: readonly string[]) {}

  observeParsed(call: { tool: string; args: Record<string, unknown> }, batchIndex: number): void {
    if (call.tool !== "verify.run" && call.tool !== "os.shell.run") {
      this.pending.delete(batchIndex);
      return;
    }
    this.pending.set(batchIndex, { tool: call.tool, command: commandOf(call.args).slice(0, 300) });
  }

  observeExecuted(result: { tool: string; status: string; summary: string; details?: Record<string, unknown>; fullOutput?: string }, batchIndex: number): void {
    const pending = this.pending.get(batchIndex);
    this.pending.delete(batchIndex);
    if (pending === undefined || pending.tool !== result.tool) return;
    const parsed = parseTestOutput(outputOf(result));
    // A shell command counts only when it is a test run: one whose output
    // names cases or totals, or whose command reads as a test command.
    if (pending.tool === "os.shell.run" && parsed.tests.length === 0 && parsed.counts === undefined && !TEST_COMMAND.test(pending.command)) return;
    const exit = result.details?.exitCode;
    const files = this.declaredFiles.flatMap((path) => {
      const inside = evidencePath([this.workingDir], path);
      if (inside === undefined) return [];
      const sha256 = fileSha256(this.workingDir, inside.display);
      return [sha256 === undefined ? { path: inside.display } : { path: inside.display, sha256 }];
    });
    this.runs.push({
      tool: pending.tool,
      command: pending.command,
      exitCode: typeof exit === "number" ? exit : null,
      ok: result.status === "ok",
      files,
      ...parsed,
    });
    if (this.runs.length > MAX_RUNS) this.runs.shift();
  }

  /** The runs recorded so far, oldest first; the newest {@link MAX_RUNS}. */
  recorded(): ExecutionRun[] {
    return this.runs.map((r) => ({ ...r, files: [...r.files], tests: [...r.tests] }));
  }
}

/**
 * Whether a recorded run is a clean pass: it exited ok and no case it
 * named failed. A run that named no case passes on its exit alone.
 */
export function runPassed(run: ExecutionRun): boolean {
  return run.ok && (run.exitCode === null || run.exitCode === 0) && !run.tests.some((t) => !t.ok && t.skipped !== true) && (run.counts?.fail ?? 0) === 0;
}

/** The reviewer's execution section's own budget (outside the other evidence budgets). */
export const EXECUTION_EVIDENCE_CHARS = 3_000;

const short = (sha: string | undefined): string => (sha === undefined ? "unreadable" : sha.slice(0, 12));

/**
 * The reviewer's `## Execution evidence`: each recorded run of the task
 * (newest first into the budget), its command and exit, the file
 * versions it ran against (and whether they are the version under
 * review), and every case it named with its outcome. Empty with no run.
 */
export function renderExecutionEvidence(
  runs: ReadonlyArray<ExecutionRun & { attempt: number }>,
  current: ReadonlyArray<{ path: string; sha256?: string }>,
): string {
  if (runs.length === 0) return "";
  const head = "## Execution evidence (recorded by the runtime from the tool results, not from the worker's summary)";
  const blockOf = (run: ExecutionRun & { attempt: number }): string => {
    const exit = run.exitCode === null ? (run.ok ? "passed" : "failed") : `exit ${run.exitCode}`;
    const counts = run.counts === undefined ? "" : `; ${run.counts.pass} passed, ${run.counts.fail} failed of ${run.counts.total}`;
    const versions = run.files.map((f) => {
      const now = current.find((c) => c.path === f.path);
      const same = now !== undefined && now.sha256 !== undefined && now.sha256 === f.sha256;
      return `${f.path} sha256 ${short(f.sha256)}${same ? " (the version under review)" : " (not the version under review)"}`;
    });
    const tests = run.tests.map((t) => `  - ${t.skipped === true ? "skipped" : t.ok ? "ok" : "not ok"}: ${t.name}`);
    return [
      `- attempt ${run.attempt}, ${run.tool}: ${run.command} — ${exit}${counts}`,
      ...(versions.length === 0 ? [] : [`  ran against: ${versions.join(", ")}`]),
      ...(tests.length === 0 ? ["  (the output named no test case)"] : tests),
    ].join("\n");
  };
  let budget = EXECUTION_EVIDENCE_CHARS - head.length - 60;
  const blocks: string[] = [];
  for (const run of [...runs].reverse()) {
    let block = blockOf(run);
    if (block.length + 1 > budget) {
      if (blocks.length > 0) break;
      block = `${block.slice(0, Math.max(0, budget - 20))}\n  [clipped]`;
    }
    budget -= block.length + 1;
    blocks.unshift(block);
  }
  const left = runs.length - blocks.length;
  return [head, ...(left > 0 ? [`- ${left} earlier run${left === 1 ? "" : "s"} not shown`] : []), ...blocks].join("\n").slice(0, EXECUTION_EVIDENCE_CHARS);
}
