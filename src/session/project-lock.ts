import { randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";

/**
 * The lock file a fusion project's store writes under (issue #109). It
 * holds its owner (`pid`, `host`, `at`, a `token`); a lock is taken over
 * when its time is in the future (a clock moved back, a file copied from
 * elsewhere), its owner on this host is gone, or it is older than
 * `staleMs`. The takeover renames the stale file aside and checks it is
 * the one it judged before removing it, so two processes cannot both take
 * the same stale lock; a release removes the lock only while it is still
 * this owner's.
 */

export interface FileLockOptions {
  /** How long to wait for a live holder; default 2 s. */
  waitMs?: number;
  /** A lock older than this is a crashed writer's; default 30 s. */
  staleMs?: number;
  now?: () => number;
  /** This machine's name, as the lock records it (tests). */
  host?: string;
}

interface LockBody {
  pid?: unknown;
  host?: unknown;
  at?: unknown;
  token?: unknown;
}

const FUTURE_SLACK_MS = 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readBody(path: string): { text: string; body: LockBody | null; mtimeMs: number } | null {
  try {
    const text = readFileSync(path, "utf8");
    const mtimeMs = statSync(path).mtimeMs;
    try {
      const parsed = JSON.parse(text) as unknown;
      return { text, body: typeof parsed === "object" && parsed !== null ? (parsed as LockBody) : null, mtimeMs };
    } catch {
      return { text, body: null, mtimeMs };
    }
  } catch {
    return null;
  }
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function isStale(read: NonNullable<ReturnType<typeof readBody>>, now: number, staleMs: number, host: string): boolean {
  const at = typeof read.body?.at === "number" ? read.body.at : read.mtimeMs;
  if (at > now + FUTURE_SLACK_MS || read.mtimeMs > now + FUTURE_SLACK_MS) return true;
  if (now - at > staleMs) return true;
  const pid = read.body?.pid;
  return read.body?.host === host && typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processGone(pid);
}

/** Take over `lock` if it is still exactly the stale file `seen`; true when it was removed. */
function takeOver(lock: string, seen: string): boolean {
  const aside = `${lock}.stale-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(lock, aside);
  } catch {
    return false; // Another process took it (or released it) first.
  }
  let text: string | null = null;
  try {
    text = readFileSync(aside, "utf8");
  } catch {
    // Unreadable: treat as not the one we judged.
  }
  if (text === seen) {
    rmSync(aside, { force: true });
    return true;
  }
  // A fresh lock was renamed by mistake: put it back unless a new one exists already.
  try {
    linkSync(aside, lock);
  } catch {
    // A new lock is in place; the moved one's owner will find its lock gone.
  }
  rmSync(aside, { force: true });
  return false;
}

export type FileLockResult<T> = { ok: true; value: T } | { ok: false; locked: true };

/** Run `fn` holding `lock`; `locked` when a live holder keeps it past `waitMs`. */
function acquireFileLock(lock: string, options: FileLockOptions): (() => void) | null {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const host = options.host ?? hostname();
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host, at: now(), token });
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx");
      writeSync(fd, body);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const read = readBody(lock);
      if (read !== null && isStale(read, now(), staleMs, host) && takeOver(lock, read.text)) continue;
      if (Date.now() >= deadline) return null;
      sleepSync(25);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return () => {
    const mine = readBody(lock);
    if (mine?.body?.token === token) rmSync(lock, { force: true });
  };
}

export function withFileLock<T>(lock: string, fn: () => T, options: FileLockOptions = {}): FileLockResult<T> {
  const release = acquireFileLock(lock, options);
  if (!release) return { ok: false, locked: true };
  try { return { ok: true, value: fn() }; }
  finally { release(); }
}

export async function withAsyncFileLock<T>(lock: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<FileLockResult<T>> {
  const release = acquireFileLock(lock, options);
  if (!release) return { ok: false, locked: true };
  try { return { ok: true, value: await fn() }; }
  finally { release(); }
}
