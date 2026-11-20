import { createHash } from "node:crypto";

import { FILE_WRITING_TOOLS } from "./worker-result.js";

/**
 * A worker that keeps writing the same bytes to the same file (issue
 * #95). The live case: a test-writing worker overwrote its test file
 * again and again, often with identical content, while the file was
 * usable all along; the agent loop logged a no-progress warning and the
 * task ran on to its ten-minute limit.
 *
 * An identical rewrite is itself the no-progress signal: the file did
 * not change. After {@link REPEATED_WRITE_LIMIT} identical rewrites of
 * one path (the same path, the same SHA-256 of the content, each call
 * `ok`) the runner stops the worker the way the watch does (`failure:
 * "stuck"`) and hands the director the file, its hash and the worker's
 * last check (`WorkerTaskResult.stalled`), so it can verify the file or
 * reassign the task. Any other successful write to the path (an edit, a
 * patch, different bytes) starts its count again.
 */
export const REPEATED_WRITE_LIMIT = 3;

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

type Pending = { kind: "write"; path: string; sha256: string } | { kind: "other"; paths: readonly string[] | null };

export class RepeatedWritesTracker {
  private readonly pending = new Map<number, Pending>();
  private readonly last = new Map<string, { sha256: string; writes: number }>();

  observeParsed(call: { tool: string; args: Record<string, unknown> }, batchIndex: number): void {
    if (!FILE_WRITING_TOOLS.has(call.tool)) {
      this.pending.delete(batchIndex);
      return;
    }
    const path = typeof call.args.path === "string" && call.args.path.trim().length > 0 ? normalise(call.args.path) : null;
    if (call.tool === "os.fs.write" && path !== null && typeof call.args.content === "string") {
      this.pending.set(batchIndex, { kind: "write", path, sha256: createHash("sha256").update(call.args.content).digest("hex") });
      return;
    }
    this.pending.set(batchIndex, { kind: "other", paths: path === null ? null : [path] });
  }

  /**
   * The write's outcome: `identical` when it rewrote the bytes the file
   * already held; `repeat` when this one reaches the limit.
   */
  observeExecuted(
    result: { tool: string; status: string },
    batchIndex: number,
  ): { identical: boolean; repeat?: Omit<StalledWrite, "reason" | "lastCheck"> } {
    const pending = this.pending.get(batchIndex);
    this.pending.delete(batchIndex);
    if (pending === undefined || result.status !== "ok") return { identical: false };
    if (pending.kind === "other") {
      // Another change to the file (or to files it cannot name): the bytes may differ now.
      if (pending.paths === null) this.last.clear();
      else for (const path of pending.paths) this.last.delete(path);
      return { identical: false };
    }
    const prev = this.last.get(pending.path);
    const identical = prev?.sha256 === pending.sha256;
    const writes = identical ? prev!.writes + 1 : 1;
    this.last.set(pending.path, { sha256: pending.sha256, writes });
    return writes - 1 >= REPEATED_WRITE_LIMIT ? { identical, repeat: { path: pending.path, sha256: pending.sha256, writes } } : { identical };
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
