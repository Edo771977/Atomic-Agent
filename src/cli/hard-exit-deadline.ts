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
  return () => clearTimeout(timer);
}
