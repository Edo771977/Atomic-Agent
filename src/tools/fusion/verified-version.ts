import { checkDidNotRun } from "./check-ran.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ContractCheckRunner } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { FILE_WRITING_TOOLS } from "./worker-result.js";
import { ownChecks } from "./worker-self-check.js";

/**
 * A verify-only task's verified version (issue #100), kept strictly. A
 * task marked `verifyOnly` whose own contract checks pass on its declared
 * files when the worker starts holds those bytes as the verified version.
 * When the worker changed one and the task's own checks then actually ran
 * and failed, the row is `failed` with `failure: "regressed-verified"`
 * (never `ok`), and the verified bytes are written back only when every
 * condition holds:
 *  - the worker runs in the project folder, not an isolated workspace
 *    (there the failed task is simply not merged);
 *  - the turn was not cancelled, and a check ran and failed (an exit, not
 *    held, refused, timed out or not run);
 *  - the path is a regular file (lstat, not a symlink) whose realpath is
 *    inside the task's write scope and the project folder;
 *  - its bytes are exactly what the worker's own last write produced, so
 *    an edit by the person or anyone else is never overwritten;
 *  - the write goes to a temp file renamed into place.
 * Otherwise the file is left as it is, and the row says why.
 */

const MAX_BYTES = 2 * 1024 * 1024;

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ownSpecs(task: DelegateTask, contract: DelegateContract | undefined): Record<string, unknown>[] {
  return ownChecks(contract, task.id).map((check) => {
    const { task: _task, ...spec } = check as unknown as Record<string, unknown>;
    return spec;
  });
}

/** A check result that ran and failed on its own exit, not one held, refused, timed out or not run. */
function ranAndFailed(result: { ok: boolean; summary?: string; error?: string }): boolean {
  if (result.ok || result.error !== undefined) return false;
  const text = result.summary ?? "";
  return text.length > 0 && !checkDidNotRun(text);
}

/** The hash of each file as the worker's own write tools left it, by path relative to the working dir. */
export class WorkerWriteHashes {
  private readonly pending = new Map<number, string>();
  private readonly hashes = new Map<string, string>();

  constructor(private readonly workingDir: string) {}

  observeParsed(call: { tool: string; args: Record<string, unknown> }, batchIndex: number): void {
    const path = call.args.path;
    if (FILE_WRITING_TOOLS.has(call.tool) && typeof path === "string" && path.trim().length > 0) this.pending.set(batchIndex, path.trim());
    else this.pending.delete(batchIndex);
  }

  observeExecuted(result: { status: string }, batchIndex: number): void {
    const path = this.pending.get(batchIndex);
    this.pending.delete(batchIndex);
    if (path === undefined || result.status !== "ok") return;
    const full = resolve(this.workingDir, path);
    if (!inside(this.workingDir, full)) return;
    try {
      const info = lstatSync(full);
      if (info.isFile() && info.size <= MAX_BYTES) this.hashes.set(relative(this.workingDir, full), sha(readFileSync(full)));
    } catch {
      // Gone: no write of the worker's to vouch for.
    }
  }

  /** The hash of the worker's last write of `path` (relative to the working dir). */
  last(path: string): string | undefined {
    return this.hashes.get(relative(this.workingDir, resolve(this.workingDir, path)));
  }
}

/** The verified version: declared files' bytes, taken only when the task's own checks pass on them now. */
export async function verifiedSnapshot(
  task: DelegateTask,
  contract: DelegateContract | undefined,
  workingDir: string,
  runChecks: ContractCheckRunner | undefined,
  signal: AbortSignal,
): Promise<Map<string, Buffer> | undefined> {
  if (task.verifyOnly !== true || runChecks === undefined || (task.files ?? []).length === 0) return undefined;
  const specs = ownSpecs(task, contract);
  if (specs.length === 0) return undefined;
  const files = new Map<string, Buffer>();
  for (const path of task.files ?? []) {
    try {
      const full = resolve(workingDir, path);
      const info = lstatSync(full);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      files.set(path, readFileSync(full));
    } catch {
      // Not there yet: nothing verified to keep.
    }
  }
  if (files.size === 0) return undefined;
  try {
    const baseline = await runChecks(specs, { workingDir, signal });
    return baseline.ok && baseline.results.every((r) => r.ok) ? files : undefined;
  } catch {
    return undefined;
  }
}

/**
 * After a verify-only worker: undefined when nothing regressed (no change,
 * the change passes, the checks could not tell, the turn was cancelled);
 * else the row's note, the verified bytes written back only when every
 * condition holds.
 */
export async function guardVerifiedVersion(input: {
  verified: ReadonlyMap<string, Buffer>;
  task: DelegateTask;
  contract: DelegateContract | undefined;
  workingDir: string;
  /** The task's write scope; empty: the working dir. */
  writeScope: readonly string[];
  /** The worker ran in an isolated workspace. */
  isolated: boolean;
  runChecks: ContractCheckRunner | undefined;
  signal: AbortSignal;
  writes: WorkerWriteHashes;
}): Promise<string | undefined> {
  if (input.runChecks === undefined || input.signal.aborted) return undefined;
  const changed = [...input.verified].filter(([path, bytes]) => {
    try {
      const full = resolve(input.workingDir, path);
      return lstatSync(full).isSymbolicLink() || !readFileSync(full).equals(bytes);
    } catch {
      return true;
    }
  });
  if (changed.length === 0) return undefined;
  let results: ReadonlyArray<{ ok: boolean; summary?: string; error?: string }>;
  try {
    results = (await input.runChecks(ownSpecs(input.task, input.contract), { workingDir: input.workingDir, signal: input.signal })).results;
  } catch {
    return undefined;
  }
  if (input.signal.aborted || !results.some(ranAndFailed)) return undefined;
  const names = changed.map(([path]) => path).join(", ");
  const head = `verify-only: the change to ${names} failed its own checks`;
  if (input.isolated) return `${head}; not restored: an isolated workspace; the change is not merged`;
  const root = realpathSync(input.workingDir);
  const scopes = (input.writeScope.length === 0 ? [input.workingDir] : input.writeScope).map((s) => {
    try {
      return realpathSync(resolve(input.workingDir, s));
    } catch {
      return resolve(input.workingDir, s);
    }
  });
  const outcomes: string[] = [];
  for (const [path, bytes] of changed) {
    const full = resolve(input.workingDir, path);
    let why: string | undefined;
    try {
      const info = lstatSync(full);
      if (!info.isFile()) why = `${path} is not a regular file`;
      else {
        const real = realpathSync(full);
        if (!inside(root, real) || !scopes.some((scope) => inside(scope, real))) why = `${path} is outside the task's write scope`;
        else if (statSync(real).size > MAX_BYTES || input.writes.last(path) !== sha(readFileSync(real))) why = `${path} changed after the worker's last write`;
      }
    } catch {
      why = `${path} cannot be read`;
    }
    if (why !== undefined) {
      outcomes.push(`not restored: ${why}`);
      continue;
    }
    const tmp = join(dirname(full), `.${randomUUID()}.verified.tmp`);
    try {
      writeFileSync(tmp, bytes, { flag: "wx" });
      renameSync(tmp, full);
      outcomes.push(`the verified version was restored`);
    } catch (error) {
      rmSync(tmp, { force: true });
      outcomes.push(`not restored: ${error instanceof Error ? error.message.slice(0, 120) : "the write failed"}`);
    }
  }
  return `${head}; ${[...new Set(outcomes)].join("; ")}`;
}
