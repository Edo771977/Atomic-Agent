import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { FILE_WRITING_TOOLS } from "./worker-result.js";

/**
 * Evidence bound to the attempt that produced it (issue #95). In the live
 * run an edit succeeded, a later attempt tried the same edit again and
 * reported "old text not found" because it was already applied, and the
 * reviewer, shown only the files, asked for "evidence of the requested
 * edit". Each worker run of a task (the first and every review pass) is
 * an attempt: what it wrote (path and SHA-256 of the file as it left it),
 * the edits that found their new text already present, and which version
 * its checks tested. The reviewer's prompt lists them, so "already
 * present from attempt 1" counts as evidence.
 *
 * An edit is recorded as already applied only when the edit tool says so
 * itself (`os.fs.edit`'s `details.matchedBy: "already-applied"`, a no-op);
 * an error such as "not found" stays a miss whatever the file holds.
 */

/** One worker run's file evidence, set on its row (`WorkerTaskResult.attempt`). */
export interface AttemptFiles {
  /** Files the run wrote (`ok` writes), with the SHA-256 of each as the run left it (absent: gone or unreadable). */
  wrote: Array<{ path: string; sha256?: string }>;
  /** Files whose `os.fs.edit` found its new text already present: a no-op, not a failure. */
  alreadyApplied: string[];
}

/** One attempt in the delegate's ledger: its files, and what its checks tested. */
export interface AttemptRecord extends AttemptFiles {
  attempt: number;
  tested?: { passed: number; total: number; versions: Array<{ path: string; sha256?: string }> };
}

const MAX_HASHED_BYTES = 8 * 1024 * 1024;

/**
 * A path the evidence may read and name: resolved under the first root
 * (the working dir), kept only when inside one of `roots` (the working
 * dir, the session's read roots). `display` is relative to the working
 * dir when inside it, else the full path; undefined outside every root.
 */
export function evidencePath(roots: readonly string[], path: string): { display: string; full: string } | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0 || roots.length === 0) return undefined;
  const full = resolve(roots[0]!, trimmed);
  for (const [i, root] of roots.entries()) {
    const rel = relative(resolve(root), full);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) continue;
    return { display: i === 0 ? rel.split(sep).join("/") : full, full };
  }
  return undefined;
}

/** SHA-256 of a file inside `dir`, or undefined when it is outside it, cannot be read, or is huge. */
export function fileSha256(dir: string, path: string): string | undefined {
  const inside = evidencePath([dir], path);
  if (inside === undefined) return undefined;
  return sha256Of(inside.full);
}

/** SHA-256 of a file at a full path already checked against the roots; undefined when unreadable or huge. */
export function sha256Of(full: string): string | undefined {
  try {
    if (statSync(full).size > MAX_HASHED_BYTES) return undefined;
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    return undefined;
  }
}

/** The edit tool's own word that the edit was already in place (a no-op). */
export function isAlreadyApplied(result: { tool: string; status: string; details?: Record<string, unknown> }): boolean {
  return result.tool === "os.fs.edit" && result.status === "ok" && result.details?.matchedBy === "already-applied";
}

type Pending = { path: string | null };

/** Fed from one worker run's `tool_call_parsed` / `tool_call_executed` events. */
export class AttemptFilesTracker {
  private readonly pending = new Map<number, Pending>();
  private readonly wrote = new Set<string>();
  private readonly alreadyApplied = new Set<string>();

  constructor(private readonly workingDir: string) {}

  observeParsed(call: { tool: string; args: Record<string, unknown> }, batchIndex: number): void {
    if (!FILE_WRITING_TOOLS.has(call.tool) || (call.tool === "os.fs.patch" && call.args.apply !== true)) {
      this.pending.delete(batchIndex);
      return;
    }
    // Only a path inside the worker's working dir is read and named.
    const path = typeof call.args.path === "string" ? (evidencePath([this.workingDir], call.args.path)?.display ?? null) : null;
    this.pending.set(batchIndex, { path });
  }

  observeExecuted(result: { tool: string; status: string; details?: Record<string, unknown> }, batchIndex: number): void {
    const pending = this.pending.get(batchIndex);
    this.pending.delete(batchIndex);
    if (pending === undefined || pending.path === null || result.status !== "ok") return;
    if (isAlreadyApplied(result)) {
      if (!this.wrote.has(pending.path)) this.alreadyApplied.add(pending.path);
      return;
    }
    this.wrote.add(pending.path);
    this.alreadyApplied.delete(pending.path);
  }

  /** The run's evidence, hashed as the files stand now; undefined when it touched no file. */
  finish(): AttemptFiles | undefined {
    if (this.wrote.size === 0 && this.alreadyApplied.size === 0) return undefined;
    return {
      wrote: [...this.wrote].map((path) => {
        const sha256 = fileSha256(this.workingDir, path);
        return sha256 === undefined ? { path } : { path, sha256 };
      }),
      alreadyApplied: [...this.alreadyApplied],
    };
  }
}

const short = (sha: string | undefined): string => (sha === undefined ? "unreadable" : sha.slice(0, 12));

/** The attempts section's own budget in the reviewer's prompt (outside `JUDGE_EVIDENCE_CHARS`). */
export const ATTEMPT_EVIDENCE_CHARS = 4_000;
/** Files named per attempt line, and in the version list; the rest is counted. */
const FILES_PER_LINE = 5;
const VERSION_FILES = 8;

/** The task's own files first (in its order), then the rest as they came. */
function taskFirst<T extends { path: string }>(files: readonly T[], taskFiles: readonly string[]): T[] {
  const rank = (path: string): number => {
    const i = taskFiles.indexOf(path);
    return i < 0 ? taskFiles.length : i;
  };
  return files.map((file, i) => ({ file, i })).sort((a, b) => rank(a.file.path) - rank(b.file.path) || a.i - b.i).map((x) => x.file);
}

const more = (n: number): string => (n > 0 ? `, +${n} file${n === 1 ? "" : "s"}` : "");

/**
 * The reviewer's section on a task's attempts and the version under
 * review (`current`: the files as the reviewer reads them now, hashed),
 * within {@link ATTEMPT_EVIDENCE_CHARS}: the task's files (`taskFiles`)
 * are named first, the rest counted ("+N files"), and when the attempts
 * still do not fit, the earliest are left out and counted. Empty when the
 * task has a single attempt that wrote nothing.
 */
export function renderAttemptEvidence(
  attempts: readonly AttemptRecord[],
  current: ReadonlyArray<{ path: string; sha256?: string }>,
  taskFiles: readonly string[] = [],
): string {
  if (attempts.length === 0) return "";
  if (attempts.length === 1 && attempts[0]!.wrote.length === 0 && attempts[0]!.alreadyApplied.length === 0) return "";
  const tested = (a: AttemptRecord): string => (a.tested === undefined ? "" : `; checks ${a.tested.passed}/${a.tested.total} passed`);
  const lineOf = (a: AttemptRecord): string => {
    const wrote = taskFirst(a.wrote, taskFiles);
    const named = wrote.slice(0, FILES_PER_LINE).map((w) => `${w.path} (sha256 ${short(w.sha256)})`);
    const wroteText = wrote.length === 0 ? "wrote nothing" : `wrote ${named.join(", ")}${more(wrote.length - named.length)}`;
    const noops = taskFirst(a.alreadyApplied.map((path) => ({ path })), taskFiles);
    const noopText = noops
      .slice(0, FILES_PER_LINE)
      .map((n) => `os.fs.edit on ${n.path} found its new text already present: already applied (a no-op, not a failure)`);
    const noopMore = noops.length > FILES_PER_LINE ? [`+${noops.length - FILES_PER_LINE} more already applied`] : [];
    return `- attempt ${a.attempt}: ${[wroteText, ...noopText, ...noopMore].join("; ")}${tested(a)}`;
  };
  const shown = taskFirst(current, taskFiles);
  const versions = shown.slice(0, VERSION_FILES).map((file) => {
    const by = [...attempts].reverse().find((a) => a.wrote.some((w) => w.path === file.path && w.sha256 !== undefined && w.sha256 === file.sha256));
    const testedIn = attempts.filter((a) => a.tested?.versions.some((v) => v.path === file.path && v.sha256 !== undefined && v.sha256 === file.sha256));
    const origin = by === undefined ? "not written by these attempts (as it was before, or changed elsewhere)" : `written by attempt ${by.attempt}`;
    const tests = testedIn.length === 0 ? "" : `; tested in attempt ${testedIn.map((a) => `${a.attempt} (checks ${a.tested!.passed}/${a.tested!.total} passed)`).join(", ")}`;
    return `- ${file.path} sha256 ${short(file.sha256)}: ${origin}${tests}`.slice(0, 240);
  });
  if (shown.length > VERSION_FILES) versions.push(`- +${shown.length - VERSION_FILES} files`);
  const head = "## Attempts (this task's runs in this call; each keeps the evidence it produced)";
  const tail = [
    "",
    "## Version under review",
    ...(versions.length === 0 ? ["(no file to show)"] : versions),
    "A change already present from an earlier attempt is evidence the change was made: rule on the version under review, not on whether the last attempt edited it.",
  ].join("\n");
  // The newest attempts first into the budget; the earliest are counted when they do not fit.
  let budget = ATTEMPT_EVIDENCE_CHARS - head.length - tail.length - 80;
  const lines: string[] = [];
  for (const a of [...attempts].reverse()) {
    const line = lineOf(a).slice(0, 600);
    if (line.length + 1 > budget) break;
    budget -= line.length + 1;
    lines.unshift(line);
  }
  const left = attempts.length - lines.length;
  const omitted = left > 0 ? [`- ${left} earlier attempt${left === 1 ? "" : "s"} not shown`] : [];
  return [head, ...omitted, ...lines, tail].join("\n").slice(0, ATTEMPT_EVIDENCE_CHARS);
}
