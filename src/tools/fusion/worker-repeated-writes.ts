import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isAlreadyApplied } from "./attempt-evidence.js";
import { FILE_WRITING_TOOLS } from "./worker-result.js";

/**
 * A worker that keeps writing the same bytes to the same file (issue
 * #95). The live case: a test-writing worker overwrote its test file
 * again and again, often with identical content, while the file was
 * usable all along; the agent loop logged a no-progress warning and the
 * task ran on to its ten-minute limit.
 *
 * An identical rewrite is itself the no-progress signal: the file did
 * not change. After {@link REPEATED_WRITE_LIMIT} consecutive rewrites of
 * one path that each produce a version already written in the same run
 * (the same SHA-256 of the content as one of the last
 * {@link REPEATED_WRITE_RECENT_HASHES}, each call `ok`, with no other
 * progress in between: see {@link RepeatedWritesTracker}; the path is
 * resolved under the working dir, so `./a`, `/repo/a` and `a` are one)
 * the runner stops the worker the way the watch does (`failure:
 * "stuck"`) and hands the director the file, its hash and the worker's
 * last check (`WorkerTaskResult.stalled`), so it can verify the file or
 * reassign the task. Out of scope: writes through the shell, and
 * content that differs only by a timestamp, are not seen as repeats.
 */
export const REPEATED_WRITE_LIMIT = 3;

/** Versions of a path remembered within a run of writes: alternating between them is no progress. */
export const REPEATED_WRITE_RECENT_HASHES = 4;

/** Why and on what a worker was stopped for repeating itself. */
export interface StalledWrite {
  reason: "repeated identical writes";
  /** The file, as the worker named it (trimmed, without a leading `./`). */
  path: string;
  /** SHA-256 (hex) of the bytes written each time. */
  sha256: string;
  /** Successful writes of these bytes in a row, the first included. */
  writes: number;
  /**
   * The worker's last `verify.run`: its spec, whether it passed, whether
   * it ran after the worker's last change (an identical rewrite is not a
   * change), and whether its spec names the file.
   */
  lastCheck?: { spec: string; ok: boolean; sinceLastChange: boolean; coversFile: boolean };
}

type Pending = { kind: "write"; path: string; sha256: string } | { kind: "other"; tool: string; paths: readonly string[] | null };

/** Calls that change nothing a stall is about: a check, a reply, a finish. */
const NEUTRAL_TOOLS: ReadonlySet<string> = new Set(["verify.run", "reply", "finish"]);

/**
 * Counts consecutive identical writes to one path. Any other successful
 * call that is not read-only (a write to another file, an edit, a shell
 * command) is progress and ends the run of repeats; failed calls,
 * read-only ones and checks (`verify.run`) do not. `reset` starts over
 * (the runner calls it when the self-check's grace turn begins).
 */
export class RepeatedWritesTracker {
  private readonly pending = new Map<number, Pending>();
  /** The last bytes written to each path, for `identical`. */
  private readonly lastHash = new Map<string, string>();
  /**
   * The current run of writes to one path since the last progress: the
   * versions it wrote (newest last, at most {@link REPEATED_WRITE_RECENT_HASHES}),
   * how many writes, and how many in a row produced a version already seen.
   */
  private streak: { path: string; recent: string[]; writes: number; repeats: number } | undefined;

  constructor(
    private readonly readOnlyTools: ReadonlySet<string> = new Set(),
    private readonly workingDir?: string,
  ) {}

  /** A path as one key whatever its spelling: resolved under the working dir, relative to it when inside. */
  private key(path: string): string {
    const trimmed = path.trim();
    if (this.workingDir === undefined) return normalise(trimmed);
    const full = resolve(this.workingDir, trimmed);
    const rel = relative(this.workingDir, full);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : full;
  }

  observeParsed(call: { tool: string; args: Record<string, unknown> }, batchIndex: number): void {
    const path = typeof call.args.path === "string" && call.args.path.trim().length > 0 ? this.key(call.args.path) : null;
    if (call.tool === "os.fs.write" && path !== null && typeof call.args.content === "string") {
      this.pending.set(batchIndex, { kind: "write", path, sha256: createHash("sha256").update(call.args.content).digest("hex") });
      return;
    }
    this.pending.set(batchIndex, { kind: "other", tool: call.tool, paths: path === null ? null : [path] });
  }

  /** Forget the run of repeats (a new turn the runner gave the worker). */
  reset(): void {
    this.streak = undefined;
  }

  /**
   * The call's outcome: `identical` when it rewrote the bytes the file
   * already held; `repeat` when this one reaches the limit.
   */
  observeExecuted(
    result: { tool: string; status: string; details?: Record<string, unknown> },
    batchIndex: number,
  ): { identical: boolean; repeat?: Omit<StalledWrite, "reason" | "lastCheck"> } {
    const pending = this.pending.get(batchIndex);
    this.pending.delete(batchIndex);
    if (result.status !== "ok") return { identical: false };
    // An edit the tool found already applied changed nothing (issue #95).
    if (isAlreadyApplied(result)) return { identical: true };
    if (pending === undefined || pending.kind === "other") {
      const tool = pending?.tool ?? result.tool;
      if (NEUTRAL_TOOLS.has(tool) || this.readOnlyTools.has(tool)) return { identical: false };
      // Progress: the run of repeats ends, and a changed file's bytes are unknown now.
      this.streak = undefined;
      if (FILE_WRITING_TOOLS.has(tool)) {
        if (pending?.paths == null) this.lastHash.clear();
        else for (const path of pending.paths) this.lastHash.delete(path);
      }
      return { identical: false };
    }
    const identical = this.lastHash.get(pending.path) === pending.sha256;
    this.lastHash.set(pending.path, pending.sha256);
    const streak = this.streak !== undefined && this.streak.path === pending.path ? this.streak : undefined;
    // A version this run of writes already produced is no progress; a new one restarts the count.
    const seen = streak?.recent.includes(pending.sha256) === true;
    const recent = [...(streak?.recent ?? []).filter((h) => h !== pending.sha256), pending.sha256].slice(-REPEATED_WRITE_RECENT_HASHES);
    const next = { path: pending.path, recent, writes: (streak?.writes ?? 0) + 1, repeats: seen ? streak!.repeats + 1 : 0 };
    this.streak = next;
    return next.repeats >= REPEATED_WRITE_LIMIT
      ? { identical, repeat: { path: pending.path, sha256: pending.sha256, writes: next.writes } }
      : { identical };
  }
}

/** Whether a check's canonical spec names the file (its path or its base name). */
export function specNames(spec: string, path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return spec.includes(path) || (base.length > 0 && spec.includes(base));
}

function normalise(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

/** The row's error for a stalled worker: short enough for the replan line (300 characters). */
export function describeStalledWrite(stalled: StalledWrite): string {
  const last = stalled.lastCheck;
  const check =
    last === undefined
      ? "no check run"
      : !last.sinceLastChange
        ? `last check not run since the last change (${last.spec.slice(0, 60)})`
        : `last check ${last.ok ? "passed" : "failed"}${last.coversFile ? "" : `, but its spec does not name ${stalled.path}`}: ${last.spec.slice(0, 60)}`;
  // Only a fresh pass of a check naming the file says the file may be usable.
  const usable = last !== undefined && last.sinceLastChange && last.ok && last.coversFile ? " It may already be usable." : "";
  return `stalled: ${stalled.reason}: ${stalled.path} (sha256 ${stalled.sha256.slice(0, 12)}) written ${stalled.writes} times with the same bytes; ${check}.${usable} The file is kept: verify it or reassign the task`;
}
