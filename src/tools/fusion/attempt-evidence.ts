import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
 * The edit tool (`os.fs.edit`) reports a missing `oldString` as an error
 * whether or not the edit is already in the file; this tracker tells
 * them apart after the fact: a not-found edit whose `newString` is in the
 * file and whose `oldString` is not is recorded as already applied.
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

/** SHA-256 of a file under `dir`, or undefined when it cannot be read (or is huge). */
export function fileSha256(dir: string, path: string): string | undefined {
  try {
    const full = isAbsolute(path) ? path : join(dir, path);
    if (statSync(full).size > MAX_HASHED_BYTES) return undefined;
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    return undefined;
  }
}

function normalise(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

type Pending = { path: string | null; edit?: { oldString: string; newString: string } };

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
    const path = typeof call.args.path === "string" && call.args.path.trim().length > 0 ? normalise(call.args.path) : null;
    const { oldString, newString } = call.args;
    this.pending.set(batchIndex, {
      path,
      ...(call.tool === "os.fs.edit" && typeof oldString === "string" && typeof newString === "string" ? { edit: { oldString, newString } } : {}),
    });
  }

  observeExecuted(result: { tool: string; status: string; summary?: string }, batchIndex: number): void {
    const pending = this.pending.get(batchIndex);
    this.pending.delete(batchIndex);
    if (pending === undefined || pending.path === null) return;
    if (result.status === "ok") {
      this.wrote.add(pending.path);
      this.alreadyApplied.delete(pending.path);
      return;
    }
    if (pending.edit === undefined || !/was not found/.test(result.summary ?? "")) return;
    let body: string;
    try {
      body = readFileSync(join(this.workingDir, pending.path), "utf8");
    } catch {
      return;
    }
    const { oldString, newString } = pending.edit;
    if (newString.length > 0 && body.includes(newString) && (oldString.length === 0 || !body.includes(oldString))) {
      this.alreadyApplied.add(pending.path);
    }
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

/**
 * The reviewer's section on a task's attempts and the version under
 * review (`current`: the files as the reviewer reads them now, hashed).
 * Empty when the task has a single attempt that wrote nothing.
 */
export function renderAttemptEvidence(attempts: readonly AttemptRecord[], current: ReadonlyArray<{ path: string; sha256?: string }>): string {
  if (attempts.length === 0) return "";
  if (attempts.length === 1 && attempts[0]!.wrote.length === 0 && attempts[0]!.alreadyApplied.length === 0) return "";
  const tested = (a: AttemptRecord): string => (a.tested === undefined ? "" : `; checks ${a.tested.passed}/${a.tested.total} passed`);
  const lines = attempts.map((a) => {
    const wrote = a.wrote.length === 0 ? "wrote nothing" : `wrote ${a.wrote.map((w) => `${w.path} (sha256 ${short(w.sha256)})`).join(", ")}`;
    const noop = a.alreadyApplied.map((p) => `os.fs.edit on ${p} found its new text already present: already applied (a no-op, not a failure)`);
    return `- attempt ${a.attempt}: ${[wrote, ...noop].join("; ")}${tested(a)}`;
  });
  const versions = current.map((file) => {
    const by = [...attempts].reverse().find((a) => a.wrote.some((w) => w.path === file.path && w.sha256 !== undefined && w.sha256 === file.sha256));
    const testedIn = attempts.filter((a) => a.tested?.versions.some((v) => v.path === file.path && v.sha256 !== undefined && v.sha256 === file.sha256));
    const origin = by === undefined ? "not written by these attempts (as it was before, or changed elsewhere)" : `written by attempt ${by.attempt}`;
    const tests = testedIn.length === 0 ? "" : `; tested in ${testedIn.map((a) => `attempt ${a.attempt} (checks ${a.tested!.passed}/${a.tested!.total} passed)`).join(", ")}`;
    return `- ${file.path} sha256 ${short(file.sha256)}: ${origin}${tests}`;
  });
  return [
    "## Attempts (this task's runs in this call; each keeps the evidence it produced)",
    ...lines,
    "",
    "## Version under review",
    ...(versions.length === 0 ? ["(no file to show)"] : versions),
    "A change already present from an earlier attempt is evidence the change was made: rule on the version under review, not on whether the last attempt edited it.",
  ].join("\n");
}
