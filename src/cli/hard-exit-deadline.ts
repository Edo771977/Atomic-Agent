import { Worker } from "node:worker_threads";

/**
 * The last safety net of `run` (issue #104): once the session is saved
 * and the summary printed, the process ends within `HARD_EXIT_DEADLINE_MS`
 * whatever is still holding the event loop or the exit path, with the
 * run's own exit code. When it fires it says, on one stderr line, what was
 * still alive (`process.getActiveResourcesInfo()`, and the handles behind
 * them with each one's constructor, plus program and pid for a child), so
 * the next leak can be named instead of guessed.
 *
 * The timer is referenced on purpose: it must fire even when nothing else
 * would wake the process. The normal exit (teardown bounded at 5 s, then
 * `exitAfterFlush`, at most 5 s more) ends well before it.
 */
export const HARD_EXIT_DEADLINE_MS = 15_000;

interface HandleLike {
  constructor?: { name?: string };
  spawnfile?: unknown;
  pid?: unknown;
}

export interface ActiveHandles {
  resources: readonly string[];
  handles: readonly HandleLike[];
}

/** `Timeout x2, TTYWrap; handles: ChildProcess codex pid 42, Socket`. */
export function describeActiveHandles(active: ActiveHandles): string {
  const counts = new Map<string, number>();
  for (const name of active.resources) counts.set(name, (counts.get(name) ?? 0) + 1);
  const resources = [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(", ");
  const handles = active.handles.map((handle) => {
    const name = handle.constructor?.name ?? "unknown";
    if (name === "ChildProcess") return `${name} ${String(handle.spawnfile ?? "?")} pid ${String(handle.pid ?? "?")}`;
    return name;
  });
  return `${resources || "none"}${handles.length > 0 ? `; handles: ${handles.join(", ")}` : ""}`;
}

function activeNow(): ActiveHandles {
  const resources = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
  const getHandles = (process as unknown as { _getActiveHandles?: () => HandleLike[] })._getActiveHandles;
  let handles: HandleLike[] = [];
  try {
    handles = typeof getHandles === "function" ? getHandles.call(process) : [];
  } catch {
    handles = [];
  }
  return { resources, handles };
}

export interface HardExitOptions {
  ms?: number;
  /** How long after `ms` the watchdog thread waits for the main thread before it ends the process. */
  watchdogGraceMs?: number;
  /** The watchdog's memory cap (resident set size); `ATOMIC_AGENT_RUN_RSS_LIMIT_MB` or `RUN_RSS_LIMIT_BYTES` by default. */
  rssLimitBytes?: number;
  write?: (line: string) => void;
  exit?: (code: number) => void;
}

/**
 * Arm the deadline. `code` is read when it fires, so a code set after
 * arming (the run's final one) is the one used. Returns a disarm.
 */
export function armHardExitDeadline(code: () => number, options: HardExitOptions = {}): () => void {
  // In-process tests drive `run` inside the test runner's own process,
  // which this must never end; a spawned CLI (no VITEST) or an explicit
  // `ms` arms it.
  if (options.ms === undefined && process.env.VITEST !== undefined) return () => {};
  const ms = options.ms ?? HARD_EXIT_DEADLINE_MS;
  const write = options.write ?? ((line: string) => {
    try {
      process.stderr.write(line);
    } catch {
      // nothing left to tell
    }
  });
  const exit = options.exit ?? ((value: number) => process.exit(value));
  const timer = setTimeout(() => {
    const value = code();
    write(`atomic-agent: still running ${ms / 1000} s after the run ended; exiting with code ${value}. Still alive: ${describeActiveHandles(activeNow())}\n`);
    exit(value);
  }, ms);
  const watchdog = startExitWatchdog({
    deadlineMs: ms + (options.watchdogGraceMs ?? WATCHDOG_GRACE_MS),
    code: code(),
    rssLimitBytes: options.rssLimitBytes ?? rssLimitFromEnv(),
  });
  return () => {
    clearTimeout(timer);
    watchdog?.terminate().catch(() => {});
  };
}

/**
 * Issue #106: on the live run the process was still alive 178 s after it
 * printed `pending`, at 126 GiB private memory, and the timer above never
 * ended it. What held it is not known: one hypothesis is a main loop that
 * never yields (an async loop whose awaits resolve only through
 * microtasks), which would starve a timer on that loop; the opt-in memory
 * trace (`run-memory-trace.ts`, `ATOMIC_AGENT_RUN_MEMORY_TRACE`) is there
 * to confirm or rule it out. Whatever the cause, the watchdog contains the
 * damage: it runs on a worker thread with its own loop. It samples the process's resident
 * memory and ends the process when that passes the cap, or when the
 * deadline plus `WATCHDOG_GRACE_MS` passes and the main thread has not
 * ended it, after one diagnostic line on fd 2 (time elapsed, rss, the
 * worker's view of heap and external memory).
 *
 * A worker cannot run the main thread's exit, so it kills the process
 * (`process.kill(process.pid)`): on POSIX with SIGKILL, which the parent
 * sees as a signal, not a code; on Windows TerminateProcess, which ends it
 * with code 1. The run's own code is said in the line. The worker is
 * unref'd: it never keeps a process alive that would otherwise exit.
 */
export const WATCHDOG_GRACE_MS = 5_000;

/** Default memory cap: far above a healthy run, far below exhausting a machine. */
export const RUN_RSS_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

function rssLimitFromEnv(): number {
  const raw = Number(process.env.ATOMIC_AGENT_RUN_RSS_LIMIT_MB);
  return Number.isFinite(raw) && raw > 0 ? raw * 1024 * 1024 : RUN_RSS_LIMIT_BYTES;
}

const WATCHDOG_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const { deadlineMs, code, rssLimitBytes, sampleMs } = workerData;
const started = Date.now();
const mib = (n) => (n / 1024 / 1024).toFixed(1) + " MiB";
const end = (why) => {
  const m = process.memoryUsage();
  const line = "atomic-agent watchdog: " + why + "; " + ((Date.now() - started) / 1000).toFixed(1) + " s after the run ended; rss " + mib(m.rss) +
    ", worker heap " + mib(m.heapUsed) + ", external " + mib(m.external) + ", array buffers " + mib(m.arrayBuffers) +
    "; ending the process (the run's exit code was " + code + ")\\n";
  try { writeSync(2, line); } catch {}
  process.kill(process.pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
};
setInterval(() => {
  const rss = process.memoryUsage.rss();
  if (rss > rssLimitBytes) return end("memory " + mib(rss) + " is over the cap of " + mib(rssLimitBytes).replace(".0 MiB", " MiB"));
  if (Date.now() - started >= deadlineMs) end("the main thread did not end the process within " + (deadlineMs / 1000) + " s");
}, sampleMs);
`;

function startExitWatchdog(options: { deadlineMs: number; code: number; rssLimitBytes: number }): Worker | null {
  try {
    const worker = new Worker(WATCHDOG_SOURCE, {
      eval: true,
      workerData: { ...options, sampleMs: 200 },
      stdout: false,
      stderr: false,
    });
    worker.on("error", () => {});
    worker.unref();
    return worker;
  } catch {
    // No worker threads here: the main-loop timer still stands.
    return null;
  }
}
