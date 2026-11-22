import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute as isAbsolutePath, relative as relativePath, resolve as resolvePath, sep as pathSep } from "node:path";

import { resolveUserPath } from "../os/expand-home.js";
import {
  describeProvide,
  provideSearchPaths,
  type ContractCheck,
  type ContractProvide,
  type DelegateContract,
} from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { describeNegative, negativeCheckOf } from "./contract-check-negative.js";
import { CHECK_LINT_PREFIX } from "./contract-check-lint.js";
import { parseTestOutput, type ExecutedTest } from "./test-output.js";
import type { WorkerTaskResult } from "./worker-result.js";
import type { VerificationInputIntegrity } from "../verify/verify-input-integrity.js";
import type { VerifyGameSummary } from "../verify/page-game-harness.js";
import type { VerifyScreenshot } from "../verify/page-screenshots.js";
import {
  knownSecretsFromEnv,
  maskSecrets,
  type KnownSecret,
} from "../../error-reporting/secret-detector.js";

/**
 * What the disk says about the contract once the workers are done.
 *
 * Every check here is language-agnostic on purpose: a file exists, a
 * literal appears in a file, an `id="…"` attribute appears in the
 * markup. That is enough to catch the failures the contract was written
 * for — a symbol nobody exported, an id spelled two ways — and it is
 * all a grep can honestly claim. Whether the symbol has the right shape
 * is what `checks` (a runtime, through `runChecks`) are for.
 */
export interface ContractFinding {
  task: string;
  kind: ContractProvide["kind"];
  name: string;
  /** The paths that were searched, as the contract named them. */
  where: string[];
  present: boolean;
  /** Why nothing could be said, when `present` is false for a reason other than absence. */
  detail?: string;
}

/**
 * One check's verdict as the wired runner reports it. The runner is
 * `verify`'s `runChecks`; this is the least it has to return.
 */
interface ImpeccableCheckEvidence {
  artifactStatus?: "pass" | "fail" | "uncheckable";
  impeccableVersion?: string;
  impeccableFindings?: readonly string[];
  impeccableSuppressions?: readonly string[];
}

export interface ContractCheckResult extends ImpeccableCheckEvidence {
  ok: boolean;
  summary?: string;
  error?: string;
  /**
   * The command's output tails, as `verify.run` keeps them. Where the
   * assertion and the stack trace are; the summary's head is
   * boilerplate ("verify.run command: FAILED", "exit 1 after N ms").
   */
  stderrTail?: string;
  stdoutTail?: string;
  /** A command check's exit code and the command line it ran (issue #104), as `verify.run` reports them. */
  exitCode?: number | null;
  commandLine?: string;
  /** A page check's games (`verify.run` `game`), per game (issue #40). */
  games?: VerifyGameSummary;
  /** A page check's screenshots (`verify.run` `screenshot`), at most four. */
  screenshots?: readonly VerifyScreenshot[];
  /** Screenshots asked for but not taken, one line each. */
  screenshotErrors?: readonly string[];
}

/** The fusion run a batch of checks belongs to (`<stateDir>/fusion-runs/<runId>`). */
export interface ContractCheckRun {
  readonly runId: string;
  readonly sessionId: string;
}

/**
 * The seam to `verify.run`. Injected because the runner lives in
 * another module family; absent, the checks are reported as not run —
 * never as passed.
 */
export type ContractCheckRunner = ((
  specs: readonly Record<string, unknown>[],
  ctx: {
    workingDir: string;
    signal: AbortSignal;
    inputIntegrity?: VerificationInputIntegrity;
    /**
     * Told when a held runner (`contract-check-hold.ts`) starts and ends
     * authorizing the batch, an operator prompt included: a worker's
     * self-check records that time as `heldMs` (issue #30).
     */
    onHold?: { start(): void; end(): void };
    /**
     * The task each spec is attributed to, aligned with `specs` by index
     * (`undefined` for a call-level check): a page check's screenshots
     * are named by it (issue #40).
     */
    checkTasks?: readonly (string | undefined)[];
    /** The fusion run the checks belong to: its screenshots are kept with the run. */
    run?: ContractCheckRun;
  },
) => Promise<{ ok: boolean; results: readonly ContractCheckResult[] }>) & { readonly supportsInputIntegrity?: true };

/** The note a held batch carries: on the contract line, rows, the candidate's rejection. */
export const CONTRACT_CHECKS_HELD = "contract checks held after outside content: not run";

/**
 * Thrown by a check runner that was held back instead of run: the
 * delegate's checks after outside content without a yes
 * (`contract-check-hold.ts`). `runContractChecks` reports its message as
 * the reason the checks did not run, never as a runner failure.
 */
export class ContractChecksHeldError extends Error {
  override readonly name = "ContractChecksHeldError";
}

export interface ContractCheckOutcome extends ImpeccableCheckEvidence {
  /** The task the check was attributed to; absent for a call-level check. */
  task?: string;
  ok: boolean;
  /** The runner's summary or error, head only, on one line. */
  detail: string;
  /**
   * A failing check's output tail (stderr, then stdout), whitespace
   * kept, at most `CHECK_OUTPUT_CHARS` — what a worker fixes from.
   * Absent on a pass and when the head already said everything.
   */
  output?: string;
  /** The success-criterion ids the check verifies (its spec's `criteria`, issue #40). */
  criteria?: string[];
  /** The check's games, page texts masked (issue #40). */
  games?: VerifyGameSummary;
  /** The check's screenshots: paths of JPEGs on this machine (issue #40). */
  screenshots?: readonly VerifyScreenshot[];
  /** Screenshots the check asked for but did not get, one line each. */
  screenshotErrors?: readonly string[];
  /** The check's spec asked for a vision judgement of its screenshots. */
  judge?: "vision";
  /**
   * The check's negative control also passed (issue #110): one line
   * saying so. The check is unreliable; a criterion it names is not
   * `passed` (`criteria-facts.ts`). Absent when it has no negative or
   * the negative failed as it should.
   */
  unreliable?: string;
  /** Why the check's negative control said nothing (`not run: …`), when it could not run. */
  negative?: string;
  /**
   * A command check's run as the runtime saw it (issue #104), pass or
   * fail: the command line, the exit code, its output (stdout, then
   * stderr; at most `CHECK_RUN_OUTPUT_CHARS`, the tail kept) and the
   * cases the output named. The reviewer reads it; secrets masked.
   */
  run?: CheckRunRecord;
}

/** How much of a command check's output the reviewer gets (issue #104): `verify.run`'s own tail, whole. */
export const CHECK_RUN_OUTPUT_CHARS = 8_000;

/** A command check's run, kept for the reviewer (`ContractCheckOutcome.run`). */
export interface CheckRunRecord {
  command: string;
  exitCode: number | null;
  output: string;
  /** A stream was longer than its share of {@link CHECK_RUN_OUTPUT_CHARS}: its head was cut. */
  clipped?: true;
  tests: ExecutedTest[];
  counts?: { pass: number; fail: number; total: number };
  /** The task's declared files as the check ran on them (issue #104 review), hashed just before the run. */
  files?: Array<{ path: string; sha256?: string }>;
}

export type CheckRunRecorder = (check: ContractCheck, record: CheckRunRecord, ok: boolean) => void;

const MAX_HASHED_BYTES = 8 * 1024 * 1024;

/** The SHA-256 of each of `paths` inside `dir` as it is now; a path outside it is left out, an unreadable one has no hash. */
function hashFiles(dir: string, paths: readonly string[]): Array<{ path: string; sha256?: string }> {
  return paths.flatMap((path) => {
    const full = resolvePath(dir, path);
    const rel = relativePath(resolvePath(dir), full);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolutePath(rel)) return [];
    const display = rel.split(pathSep).join("/");
    try {
      if (statSync(full).size > MAX_HASHED_BYTES) return [{ path: display }];
      return [{ path: display, sha256: createHash("sha256").update(readFileSync(full)).digest("hex") }];
    } catch {
      return [{ path: display }];
    }
  });
}

/** A command check's command line as its spec writes it (`cmd` and `args`, or `command`). */
export function commandLineOf(check: ContractCheck): string {
  const cmd = typeof check.cmd === "string" ? check.cmd : typeof check.command === "string" ? check.command : "";
  const args = Array.isArray(check.args) ? check.args.filter((a): a is string => typeof a === "string") : [];
  return [cmd, ...args].join(" ").trim();
}

/** The run record of a command check's result; undefined for a result that carries no command output. */
/** Of {@link CHECK_RUN_OUTPUT_CHARS}, what stderr gets at most (issue #104 review): stdout, where TAP is, keeps the larger share. */
export const CHECK_RUN_STDERR_CHARS = 2_000;

export function checkRunOf(check: ContractCheck, result: ContractCheckResult, files?: Array<{ path: string; sha256?: string }>): CheckRunRecord | undefined {
  if ((check.kind ?? "command") !== "command") return undefined;
  if (result.stdoutTail === undefined && result.stderrTail === undefined && result.exitCode === undefined) return undefined;
  // Separate budgets, so a long stderr never pushes the TAP out; a share one stream leaves goes to the other.
  const stdout = result.stdoutTail ?? "";
  const stderr = result.stderrTail ?? "";
  const errBudget = Math.min(stderr.length, Math.max(CHECK_RUN_STDERR_CHARS, CHECK_RUN_OUTPUT_CHARS - stdout.length));
  const outBudget = CHECK_RUN_OUTPUT_CHARS - errBudget;
  const out = stdout.length > outBudget ? stdout.slice(-outBudget) : stdout;
  const err = stderr.length > errBudget ? stderr.slice(-errBudget) : stderr;
  const clipped = out.length < stdout.length || err.length < stderr.length;
  const output = [out, ...(err.length === 0 ? [] : [`--- stderr ---\n${err}`])].filter((t) => t.length > 0).join("\n");
  const text = [stdout, stderr].filter((t) => t.length > 0).join("\n");
  return {
    command: (result.commandLine ?? commandLineOf(check)).slice(0, 300),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    output,
    ...(clipped ? { clipped: true as const } : {}),
    ...parseTestOutput(text),
    ...(files === undefined || files.length === 0 ? {} : { files }),
  };
}

/**
 * What `inspectContractProvides` could and could not say. The shape
 * mirrors `runContractChecks`: the verdicts it reached, plus the reason
 * for the ones it did not reach — never silence, which reads as "all
 * clear", and never a "missing" it did not earn.
 */
export interface ContractProvideReport {
  findings: ContractFinding[];
  /** Why some provides were not inspected, when some were not. */
  providesSkipped?: string;
}

export interface ContractReport {
  findings: ContractFinding[];
  /** Why some provides were not inspected — `ContractProvideReport`. */
  providesSkipped?: string;
  checks: ContractCheckOutcome[];
  /** Why the checks did not run, when they did not. */
  checksSkipped?: string;
  /**
   * What the contract declared that could not be honoured and was run
   * anyway — a `requires` no task provides (`contractWarnings`). The
   * workers were told; this is the orchestrator's copy.
   */
  warnings?: string[];
}

/** Files above this are not searched; a provide is not that big. */
const MAX_SEARCHED_FILE_BYTES = 8 * 1024 * 1024;
/** How much of a check's verdict a row carries. */
const CHECK_DETAIL_CHARS = 400;
/**
 * How much of a failing check's output travels with it, and with each
 * task's row: enough for an assertion and the top of a stack trace.
 * Tail-biased — the end of a test run is where the failure is.
 */
export const CHECK_OUTPUT_CHARS = 1_500;
/** Where `verify.run`'s summary starts its output tails. */
const TAIL_MARKER = /\n(?:stderr|stdout) \(tail\):\n/;
/** How many check lint lines the `contract:` line shows (issue #110). */
const CONTRACT_LINE_LINT_LINES = 3;
/** Bound on the `contract:` line of the status table. */
const CONTRACT_LINE_CHARS = 1200;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `content` carries the provide. A symbol is matched as a whole
 * word so `HD.Ship` does not pass on `HD.Shipyard`; the boundaries are
 * lookarounds because `\b` misreads names that start or end in `$`. An
 * id is the attribute, in either quote. Everything else is the literal.
 */
export function contentProvides(
  content: string,
  provide: Pick<ContractProvide, "kind" | "name">,
): boolean {
  const name = escapeRegExp(provide.name);
  if (provide.kind === "symbol") {
    return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(content);
  }
  if (provide.kind === "id") {
    return new RegExp(`\\bid\\s*=\\s*(?:"${name}"|'${name}')`).test(content);
  }
  return content.includes(provide.name);
}

/**
 * Whether the task that owns a provide got far enough for the disk to
 * mean anything. A task that was cancelled, or that is absent from the
 * results because its wave never started, produced nothing and was
 * never given the chance to — grepping for its output and calling the
 * absence "missing" accuses a worker of doing the job wrong when the
 * job never started. Every other status ran: `failed`, `no_changes`,
 * `max_steps` and `needs_orchestrator` all had their turn, and a task
 * that ran and provided nothing is exactly what this scan is for.
 *
 * With no results to consult — the function is called outside a
 * fan-out, or by a caller that has no rows — every provide is
 * assessed, as it always was.
 */
function ownerRan(
  task: string,
  results: readonly WorkerTaskResult[] | undefined,
): boolean {
  if (results === undefined) return true;
  const own = results.find((r) => r.id === task);
  return own !== undefined && own.status !== "cancelled";
}

/**
 * Check every provide against the working directory. Never throws: a
 * path that cannot be read counts as not providing, with the reason on
 * the finding. A non-file provide with nowhere to be looked for gets no
 * finding at all — it is the parser's warning (`contractWarnings`), on
 * the `contract:` line already, and a "missing" verdict over a search
 * that never happened would read as the worker's failure.
 *
 * The same reasoning covers a provide whose owner never ran: it gets no
 * finding either, and `providesSkipped` says so, the way
 * `runContractChecks` says why its checks did not run.
 */
export async function inspectContractProvides(
  contract: DelegateContract,
  tasks: readonly DelegateTask[],
  workingDir: string,
  options: {
    /** The rows the fan-out produced, to tell a real miss from a task that never ran. */
    results?: readonly WorkerTaskResult[];
    /** The turn's signal, so an aborted turn is named as the reason rather than the tasks. */
    signal?: AbortSignal;
  } = {},
): Promise<ContractProvideReport> {
  const findings: ContractFinding[] = [];
  /** Owners whose provides were passed over, in the order they were met. */
  const notRun: string[] = [];
  let skipped = 0;
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string): Promise<string | null> => {
    let pending = cache.get(path);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const absolute = resolveUserPath(path, workingDir);
          const info = await stat(absolute);
          if (!info.isFile() || info.size > MAX_SEARCHED_FILE_BYTES) {
            return null;
          }
          return await readFile(absolute, "utf8");
        } catch {
          return null;
        }
      })();
      cache.set(path, pending);
    }
    return pending;
  };

  for (const provide of contract.provides ?? []) {
    const base = { task: provide.task, kind: provide.kind, name: provide.name };
    if (!ownerRan(provide.task, options.results)) {
      skipped += 1;
      if (!notRun.includes(provide.task)) notRun.push(provide.task);
      continue;
    }
    if (provide.kind === "file") {
      let present = false;
      try {
        present = (await stat(resolveUserPath(provide.name, workingDir))).isFile();
      } catch {
        present = false;
      }
      findings.push({ ...base, where: [provide.name], present });
      continue;
    }
    const task = tasks.find((t) => t.id === provide.task);
    const where = provideSearchPaths(provide, contract, task);
    if (where.length === 0) continue;
    let present = false;
    let unreadable = 0;
    for (const path of where) {
      const content = await read(path);
      if (content === null) {
        unreadable += 1;
        continue;
      }
      if (contentProvides(content, provide)) {
        present = true;
        break;
      }
    }
    findings.push({
      ...base,
      where,
      present,
      ...(!present && unreadable === where.length
        ? { detail: "file missing or unreadable" }
        : {}),
    });
  }
  if (skipped === 0) return { findings };
  // Named the way `runContractChecks` names its own skip: what was not
  // looked at, then the reason. An aborted turn is the reason for all of
  // them at once, so say that rather than listing every task the abort
  // cancelled.
  const plural = `${skipped} provide${skipped === 1 ? "" : "s"}`;
  const why =
    options.signal?.aborted === true
      ? "the turn was cancelled"
      : `task${notRun.length === 1 ? "" : "s"} ${notRun.join(", ")} did not run`;
  return { findings, providesSkipped: `${plural} not checked — ${why}` };
}

/** `[ship_js] symbol HD.Ship.reset not in js/ship.js` */
export function describeMissing(finding: ContractFinding): string {
  if (finding.kind === "file") {
    return `[${finding.task}] file ${finding.name} does not exist`;
  }
  const what = describeProvide({
    task: finding.task,
    kind: finding.kind,
    name: finding.name,
  });
  const where =
    finding.where.length > 0 ? `not in ${finding.where.join(", ")}` : "nowhere";
  const detail = finding.detail === undefined ? "" : ` (${finding.detail})`;
  return `[${finding.task}] ${what} ${where}${detail}`;
}

/**
 * Put each missing provide on its owner's row as a note. The status is
 * not changed: presence by grep is evidence for the orchestrator's
 * review, not a verdict on the task — that is what `checks` decide.
 */
export function applyContractFindings(
  results: readonly WorkerTaskResult[],
  findings: readonly ContractFinding[],
): WorkerTaskResult[] {
  return results.map((result) => {
    const missing = findings.filter((f) => !f.present && f.task === result.id);
    if (missing.length === 0) return result;
    const notes = [
      ...(result.notes ?? []),
      `contract: ${missing.map((f) => describeMissing(f).replace(/^\[[^\]]*\] /, "")).join("; ")}`,
    ];
    return { ...result, notes };
  });
}

function head(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** The last `cap` chars of `text`, marked when cut; whitespace kept. */
export function tailClip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap <= 1) return "…";
  return `…${text.slice(-(cap - 1))}`;
}

function labelled(label: string, text: string, cap: number): string {
  const prefix = `${label} (tail):\n`;
  return `${prefix}${tailClip(text, Math.max(1, cap - prefix.length))}`;
}

/**
 * A failing check's output, bounded: the runner's stderr and stdout
 * tails when it kept them (stderr gets the larger share — it is where a
 * runtime puts the failure), else whatever of its summary the one-line
 * head could not hold.
 */
function checkOutput(result: ContractCheckResult, headText: string): string | undefined {
  const stderr = result.stderrTail?.trim() ? result.stderrTail.trimEnd() : undefined;
  const stdout = result.stdoutTail?.trim() ? result.stdoutTail.trimEnd() : undefined;
  if (stderr !== undefined || stdout !== undefined) {
    if (stderr === undefined) return labelled("stdout", stdout!, CHECK_OUTPUT_CHARS);
    if (stdout === undefined) return labelled("stderr", stderr, CHECK_OUTPUT_CHARS);
    const outCap = Math.min(stdout.length + 20, Math.floor(CHECK_OUTPUT_CHARS / 3));
    const errBlock = labelled("stderr", stderr, CHECK_OUTPUT_CHARS - outCap - 1);
    const outBlock = labelled("stdout", stdout, CHECK_OUTPUT_CHARS - errBlock.length - 1);
    return `${errBlock}\n${outBlock}`;
  }
  const text = result.error ?? result.summary;
  if (text === undefined) return undefined;
  const at = text.search(TAIL_MARKER);
  if (at >= 0) return tailClip(text.slice(at + 1).trimEnd(), CHECK_OUTPUT_CHARS);
  // No tails: only what the head had to cut is worth repeating.
  if (headText.replace(/\s+/g, " ").trim().length <= CHECK_DETAIL_CHARS) return undefined;
  return tailClip(text.trim(), CHECK_OUTPUT_CHARS);
}

/** `result`'s texts with their secrets masked (`maskSecrets`). */
function maskResult(
  result: ContractCheckResult,
  known: readonly KnownSecret[],
): ContractCheckResult {
  const mask = (text: string | undefined): { value?: string } =>
    text === undefined ? {} : { value: maskSecrets(text, known) };
  const summary = mask(result.summary).value;
  const error = mask(result.error).value;
  const stderrTail = mask(result.stderrTail).value;
  const stdoutTail = mask(result.stdoutTail).value;
  const games = result.games === undefined ? undefined : maskGames(result.games, known);
  return {
    ok: result.ok,
    ...(result.artifactStatus === undefined ? {} : { artifactStatus: result.artifactStatus }),
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
    ...(stderrTail === undefined ? {} : { stderrTail }),
    ...(stdoutTail === undefined ? {} : { stdoutTail }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.commandLine === undefined ? {} : { commandLine: maskSecrets(result.commandLine, known) }),
    ...(games === undefined ? {} : { games }),
    ...(result.impeccableVersion === undefined ? {} : { impeccableVersion: maskSecrets(result.impeccableVersion, known) }),
    ...(result.impeccableFindings === undefined ? {} : { impeccableFindings: result.impeccableFindings.map(e => maskSecrets(e, known)) }),
    ...(result.impeccableSuppressions === undefined ? {} : { impeccableSuppressions: result.impeccableSuppressions.map(e => maskSecrets(e, known)) }),
    ...(result.screenshots === undefined ? {} : { screenshots: result.screenshots }),
    ...(result.screenshotErrors === undefined ? {} : { screenshotErrors: result.screenshotErrors.map((e) => maskSecrets(e, known)) }),
  };
}

/** Keep whole evidence lines within the contract report budget. */
function boundedImpeccableLines(lines: readonly string[], budget: number): string[] {
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = head(line, CHECK_DETAIL_CHARS);
    const remaining = lines.length - shown.length - 1;
    const suffix = remaining === 0 ? 0 : `\n+${remaining} more`.length;
    if (used + next.length + suffix > budget) {
      shown.push(`+${remaining + 1} more`);
      break;
    }
    shown.push(next);
    used += next.length + 1;
  }
  return shown;
}

/** The page-written texts of a game summary (errors, winners) masked. */
function maskGames(games: VerifyGameSummary, known: readonly KnownSecret[]): VerifyGameSummary {
  const mask = (text: string): string => maskSecrets(text, known);
  const winners: Record<string, number> = {};
  for (const [winner, count] of Object.entries(games.winners)) winners[mask(winner)] = (winners[mask(winner)] ?? 0) + count;
  return {
    ...games,
    winners,
    runs: games.runs.map((run) => ({ ...run, winner: run.winner === null ? null : mask(run.winner), errors: run.errors.map(mask) })),
    ...(games.missingApi === undefined ? {} : { missingApi: mask(games.missingApi) }),
  };
}

/**
 * Run the contract's checks through the wired runner. Never throws and
 * never invents a pass: no runner, an aborted turn or a runner that
 * threw all come back as `checksSkipped` with the reason.
 *
 * The runner is called directly, not through the tool registry, so
 * nothing has masked its output (ATO-1077). Every text it returns is
 * masked here, whole, before any of it is cut to a head or a tail: a
 * key the clip cut in half matches no shape and no exact value, and its
 * other half would reach the orchestrator, a worker's notice and a
 * judge's retry brief (the same order `compressToolResult` keeps,
 * ATO-1176). `knownSecrets` are the agent's own keys; absent, the
 * environment's.
 */
export async function runContractChecks(
  checks: readonly ContractCheck[],
  runner: ContractCheckRunner | undefined,
  ctx: {
    workingDir: string;
    signal: AbortSignal;
    knownSecrets?: readonly KnownSecret[];
    inputIntegrity?: VerificationInputIntegrity;
    /** A task's declared files, hashed as each of its checks runs on them (issue #104 review). */
    filesOf?: (taskId: string) => readonly string[];
    recordCheckRun?: CheckRunRecorder;
  },
): Promise<{ outcomes: ContractCheckOutcome[]; checksSkipped?: string }> {
  if (checks.length === 0) return { outcomes: [] };
  const plural = `${checks.length} check${checks.length === 1 ? "" : "s"}`;
  if (runner === undefined) {
    return {
      outcomes: [],
      checksSkipped: `${plural} not run — no check runner is wired`,
    };
  }
  if (ctx.signal.aborted) {
    return { outcomes: [], checksSkipped: `${plural} not run — the turn was cancelled` };
  }
  const specs = checks.map(({ task: _task, criteria: _criteria, judge: _judge, negative: _negative, ...spec }) => spec);
  // Issue #110: each negative control first, one spec per batch through
  // the same runner (approval, scope, egress, integrity, cancellation),
  // so one result never stands for another's.
  const negatives = checks.map(negativeCheckOf);
  const known = ctx.knownSecrets ?? knownSecretsFromEnv();
  // The files each check runs on, hashed right before the runner copies them.
  const runFiles = new Map<string, Array<{ path: string; sha256?: string }>>();
  for (const id of new Set(checks.flatMap((c) => (c.task === undefined ? [] : [c.task])))) {
    const paths = ctx.filesOf?.(id) ?? [];
    if (paths.length > 0) runFiles.set(id, hashFiles(ctx.workingDir, paths));
  }
  let results: readonly ContractCheckResult[];
  const negativeResults = new Map<number, ContractCheckResult | undefined>();
  try {
    for (const [i, negative] of negatives.entries()) {
      if (negative === undefined) continue;
      ctx.signal.throwIfAborted();
      const { task: negativeTask, ...negativeSpec } = negative;
      const ran = await runner([negativeSpec], { workingDir: ctx.workingDir, signal: ctx.signal, ...(ctx.inputIntegrity === undefined ? {} : { inputIntegrity: ctx.inputIntegrity }), checkTasks: [negativeTask] });
      negativeResults.set(i, ran.results[0]);
    }
    results = (
      await runner(specs, { workingDir: ctx.workingDir, signal: ctx.signal, ...(ctx.inputIntegrity === undefined ? {} : { inputIntegrity: ctx.inputIntegrity }), checkTasks: checks.map((check) => check.task) })
    ).results;
  } catch (error) {
    // Held after outside content (`contract-check-hold.ts`): its own note,
    // not a runner failure. A turn cancelled while it waited says so.
    if (error instanceof ContractChecksHeldError) {
      return { outcomes: [], checksSkipped: maskSecrets(`${plural} not run — ${error.message}`, known) };
    }
    if (ctx.signal.aborted) {
      return { outcomes: [], checksSkipped: `${plural} not run — the turn was cancelled` };
    }
    return {
      outcomes: [],
      checksSkipped: maskSecrets(
        `${plural} not run — the check runner failed: ${error instanceof Error ? error.message : String(error)}`,
        known,
      ),
    };
  }
  const outcomes = checks.map((check, i): ContractCheckOutcome => {
    const raw = results[i];
    const task = check.task === undefined ? {} : { task: check.task };
    if (raw === undefined) {
      return {
        ...task, ok: false, detail: "the runner returned no result",
        ...(check.criteria === undefined || check.criteria.length === 0 ? {} : { criteria: [...check.criteria] }),
        ...(check.judge === "vision" ? { judge: "vision" as const } : {}),
      };
    }
    const result = maskResult(raw, known);
    // The head is the summary before its output tails, on one line;
    // the tails ride separately, whitespace kept, so the assertion is
    // not lost behind "verify.run command: FAILED … exit 1 after N ms".
    const text = result.error ?? result.summary ?? (result.ok ? "passed" : "failed");
    const at = text.search(TAIL_MARKER);
    const headText = at >= 0 ? text.slice(0, at) : text;
    const detail = head(headText, CHECK_DETAIL_CHARS);
    const output = result.ok ? undefined : checkOutput(result, headText);
    const criteria = check.criteria === undefined || check.criteria.length === 0 ? {} : { criteria: [...check.criteria] };
    const run = checkRunOf(check, result, check.task === undefined ? undefined : runFiles.get(check.task));
    if (run !== undefined) ctx.recordCheckRun?.(check, run, result.ok);
    const control = negativeVerdict(check, negativeResults.has(i), negativeResults.get(i), known);
    const findingsBudget = result.impeccableSuppressions?.length ? Math.floor(CHECK_OUTPUT_CHARS / 2) : CHECK_OUTPUT_CHARS;
    const suppressionsBudget = result.impeccableFindings?.length ? Math.floor(CHECK_OUTPUT_CHARS / 2) : CHECK_OUTPUT_CHARS;
    return {
      ...task, ok: result.ok, detail: control.unreliable === undefined ? detail : head(`${detail} — unreliable: ${control.unreliable}`, CHECK_DETAIL_CHARS),
      ...(output === undefined ? {} : { output }), ...criteria, ...control,
      ...(run === undefined ? {} : { run }),
      ...((check.kind ?? check.type) !== "ui" || result.artifactStatus === undefined ? {} : { artifactStatus: result.artifactStatus }),
      ...(result.impeccableVersion === undefined ? {} : { impeccableVersion: head(result.impeccableVersion, CHECK_DETAIL_CHARS) }),
      ...(result.impeccableFindings === undefined ? {} : { impeccableFindings: boundedImpeccableLines(result.impeccableFindings, findingsBudget) }),
      ...(result.impeccableSuppressions === undefined ? {} : { impeccableSuppressions: boundedImpeccableLines(result.impeccableSuppressions, suppressionsBudget) }),
      ...(result.games === undefined ? {} : { games: result.games }),
      ...(result.screenshots === undefined ? {} : { screenshots: result.screenshots }),
      ...(result.screenshotErrors === undefined || result.screenshotErrors.length === 0 ? {} : { screenshotErrors: [...result.screenshotErrors] }),
      ...(check.judge === "vision" ? { judge: "vision" as const } : {}),
    };
  });
  return { outcomes };
}

/**
 * What a check's negative control said (issue #110): `unreliable` when
 * it passed too, `negative: "not run: …"` when it could not run (no
 * result, an error, refused or held), nothing when it failed as it should
 * or the check has none.
 */
function negativeVerdict(
  check: ContractCheck,
  ran: boolean,
  result: ContractCheckResult | undefined,
  known: readonly KnownSecret[],
): { unreliable?: string; negative?: string } {
  if (!ran || check.negative === undefined) return {};
  if (result === undefined) return { negative: "not run: the runner returned no result" };
  if (result.error !== undefined) return { negative: maskSecrets(head(`not run: ${result.error}`, CHECK_DETAIL_CHARS), known) };
  if (!result.ok) return {};
  return { unreliable: `its negative control (${describeNegative(check.negative)}) passed too, so this check passes on an input it should fail on` };
}

/**
 * The failing checks' output for one task, inside `CHECK_OUTPUT_CHARS`
 * however many failed: each gets an equal share, its own tail kept.
 */
export function taskCheckOutput(
  failed: readonly ContractCheckOutcome[],
): string | undefined {
  const outputs = failed.flatMap((o) => (o.output === undefined ? [] : [o.output]));
  if (outputs.length === 0) return undefined;
  if (outputs.length === 1) return tailClip(outputs[0]!, CHECK_OUTPUT_CHARS);
  const share = Math.floor(CHECK_OUTPUT_CHARS / outputs.length) - 1;
  return outputs.map((o) => tailClip(o, share)).join("\n");
}

/**
 * Fold the checks into the rows. A task whose declared check failed
 * becomes `failed` with `checks: …` as its error — unless it was
 * cancelled, which says the operator ended it and outranks a check that
 * could not have passed. Call-level checks (no task) stay on the
 * contract line.
 */
export function applyCheckOutcomes(
  results: readonly WorkerTaskResult[],
  outcomes: readonly ContractCheckOutcome[],
): WorkerTaskResult[] {
  return results.map((row) => {
    const own = outcomes.filter((o) => o.task === row.id);
    if (own.length === 0) return row;
    // A check that passes on its negative input too (issue #110) is said on the row.
    const unreliable = own.filter((o) => o.ok && o.unreliable !== undefined);
    const uncontrolled = own.filter((o) => o.ok && o.negative !== undefined);
    const extra = [
      ...unreliable.map((o) => `checks: unreliable — ${o.detail}`),
      ...uncontrolled.map((o) => `checks: negative control not run — ${o.detail} (${o.negative})`),
    ];
    const result = extra.length === 0 ? row : { ...row, notes: [...(row.notes ?? []), ...extra] };
    const failed = own.filter((o) => !o.ok);
    const detail =
      failed.length > 0 ? failed.map((o) => o.detail).join("; ") : undefined;
    const output = taskCheckOutput(failed);
    const checks = {
      total: own.length,
      failed: failed.length,
      ...(detail === undefined ? {} : { detail }),
      ...(output === undefined ? {} : { output }),
    };
    // A task that stopped to ask (ATO-945) before writing could not have
    // passed its checks either; its question is the row's next step, not
    // a failure. One that wrote files is judged on them like any other,
    // and keeps its question when they fail.
    const askedBeforeWriting =
      result.status === "needs_input" &&
      result.tools.writes === 0 &&
      (result.changes?.length ?? 0) === 0;
    if (
      failed.length === 0 ||
      result.status === "cancelled" ||
      askedBeforeWriting
    ) {
      return { ...result, checks };
    }
    const error = `checks: ${detail}`;
    return {
      ...result,
      status: "failed",
      checks,
      error: result.error === undefined ? error : `${error}; ${result.error}`,
    };
  });
}

/**
 * The `contract:` line of the status table — presence first, then why
 * some provides could not be judged at all, then the checks that belong
 * to no task, then why the checks did not run, then
 * the warnings the call was run with (an unprovided require, so the
 * orchestrator fixes the contract on its next call instead of wondering
 * why a worker never found it). Nothing when the contract declared
 * nothing checkable and raised no warning.
 */
export function renderContractLine(report: ContractReport): string | undefined {
  const parts: string[] = [];
  if (report.findings.length > 0) {
    const missing = report.findings.filter((f) => !f.present);
    parts.push(
      missing.length === 0
        ? `all ${report.findings.length} provide${report.findings.length === 1 ? "" : "s"} present`
        : `${missing.length} missing — ${missing.map(describeMissing).join("; ")}`,
    );
  }
  if (report.providesSkipped !== undefined) parts.push(report.providesSkipped);
  const callLevel = report.checks.filter((o) => o.task === undefined);
  if (callLevel.length > 0) {
    const failed = callLevel.filter((o) => !o.ok);
    parts.push(
      failed.length === 0
        ? `call-level checks: ${callLevel.length} of ${callLevel.length} passed`
        : `call-level checks: ${failed.length} of ${callLevel.length} failed — ${failed.map((o) => o.detail).join("; ")}`,
    );
  } else if (report.checks.length > 0) {
    const failed = report.checks.filter((o) => !o.ok).length;
    parts.push(
      failed === 0
        ? `checks: ${report.checks.length} of ${report.checks.length} passed`
        : `checks: ${failed} of ${report.checks.length} failed (see the task rows)`,
    );
  }
  const unreliable = report.checks.filter((o) => o.ok && o.unreliable !== undefined).length;
  if (unreliable > 0) parts.push(`${unreliable} check${unreliable === 1 ? "" : "s"} unreliable: the negative control passed too`);
  const uncontrolled = report.checks.filter((o) => o.ok && o.negative !== undefined).length;
  if (uncontrolled > 0) parts.push(`${uncontrolled} negative control${uncontrolled === 1 ? "" : "s"} not run`);
  if (report.checksSkipped !== undefined) parts.push(report.checksSkipped);
  // The check lint's lines (issue #110), at most a few: the rest are in the details.
  const warnings = report.warnings ?? [];
  const lint = warnings.filter((w) => w.startsWith(CHECK_LINT_PREFIX));
  parts.push(...warnings.filter((w) => !w.startsWith(CHECK_LINT_PREFIX)), ...lint.slice(0, CONTRACT_LINE_LINT_LINES));
  if (lint.length > CONTRACT_LINE_LINT_LINES) parts.push(`+${lint.length - CONTRACT_LINE_LINT_LINES} more check lint findings in details.contract.warnings`);
  if (parts.length === 0) return undefined;
  return `contract: ${head(parts.join("; "), CONTRACT_LINE_CHARS)}`;
}
