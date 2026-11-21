import { closeSync, openSync, writeSync } from "node:fs";
import { Worker } from "node:worker_threads";

/**
 * Opt-in memory trace of one `run` (issue #106). A live run was found at
 * 126 GiB private memory after `pending` with nothing to say when the
 * growth began or what the process was doing. With
 * `ATOMIC_AGENT_RUN_MEMORY_TRACE=<file>` the run appends NDJSON to that
 * file, synchronously (one `writeSync` per line on a descriptor opened
 * once), so the lines are on disk even when the main loop stops turning
 * or the process is killed:
 *
 * - `start`: pid, platform, Node version, the flag names given (no values);
 * - `phase`: each phase of the run entering and exiting (`ms`, `ok`);
 * - `main`: every second from the main thread, rss and the JS heap
 *   (`heapUsed`, `heapTotal`), `external`, `arrayBuffers`, and how late
 *   the tick fired (`lagMs`);
 * - `worker`: every second from a worker thread, the process's rss, how
 *   long ago the main thread last showed a sign of life
 *   (`heartbeatAgeMs`) and the phase it was in, read from shared memory
 *   the main thread writes. A main loop that stops ticking stops the
 *   `main` lines; the `worker` lines go on and say where it stopped.
 * - `exit`: the code, when the process ends through `process.exit`.
 *
 * A JS heap that grows tells a heap growth; rss growing with a flat heap
 * points at buffers or native memory. Unset, nothing is opened or started.
 */
export const RUN_MEMORY_TRACE_ENV = "ATOMIC_AGENT_RUN_MEMORY_TRACE";
export const RUN_MEMORY_TRACE_INTERVAL_MS = 1_000;

export type PhaseHook = (phase: string, edge: "enter" | "exit", ok?: boolean) => void;

export interface RunMemoryTrace {
  readonly path: string;
  /** Mark `phase` entered; the returned function marks it exited (once). */
  enter(phase: string, extra?: Readonly<Record<string, string | number>>): (ok?: boolean) => void;
  /** `fn` inside `phase`: sync or async, `ok: false` when it throws or rejects. */
  span<T>(phase: string, fn: () => T, extra?: Readonly<Record<string, string | number>>): T;
  /** An enter/exit hook (`runtime.shutdown({ onPhase })`) whose phases are named `<prefix><phase>`. */
  phaseHook(prefix: string): PhaseHook;
  /** Stop sampling and close the file. A `run` never calls it: the trace lasts until the process ends. */
  stop(): Promise<void>;
}

export interface RunMemoryTraceOptions {
  /** The command's own arguments; only flag names are written. */
  argv?: readonly string[];
  intervalMs?: number;
}

/** The trace named by `env`, or null (nothing opened, no timer, no worker) when unset. */
export function startRunMemoryTrace(env: NodeJS.ProcessEnv, options: RunMemoryTraceOptions = {}): RunMemoryTrace | null {
  const path = env[RUN_MEMORY_TRACE_ENV];
  if (path === undefined || path.trim() === "") return null;
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (err) {
    process.stderr.write(`atomic-agent: memory trace off: cannot open ${path} (${err instanceof Error ? err.message : String(err)})\n`);
    return null;
  }
  return createTrace(path, fd, options);
}

/** Shared slots: main heartbeat (epoch ms), current phase index, last phase index (-1: none). */
const HEARTBEAT = 0;
const CURRENT = 1;
const LAST = 2;
/**
 * Phase names, written into shared memory once each, before their index
 * is published with `Atomics.store`: the worker reads them without a
 * message, which a busy or starved main thread may never get to send.
 */
const NAME_SLOTS = 128;
const NAME_BYTES = 64;

function createTrace(path: string, fd: number, options: RunMemoryTraceOptions): RunMemoryTrace {
  const intervalMs = options.intervalMs ?? RUN_MEMORY_TRACE_INTERVAL_MS;
  const epochMs = Date.now();
  let open = true;
  const write = (record: Record<string, unknown>): void => {
    if (!open) return;
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } catch {
      // a full disk never ends the run
    }
  };
  const t = (): number => Date.now() - epochMs;

  const shared = new BigInt64Array(new SharedArrayBuffer(3 * BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(shared, HEARTBEAT, BigInt(epochMs));
  Atomics.store(shared, CURRENT, -1n);
  Atomics.store(shared, LAST, -1n);
  const nameTable = new Uint8Array(new SharedArrayBuffer(NAME_SLOTS * NAME_BYTES));
  const beat = (): void => {
    Atomics.store(shared, HEARTBEAT, BigInt(Date.now()));
  };

  const argv = options.argv ?? [];
  write({
    t: 0, kind: "start", epochMs, pid: process.pid, ppid: process.ppid, platform: process.platform, arch: process.arch,
    node: process.version, flags: argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]), argCount: argv.length, intervalMs,
  });

  let worker: Worker | null = null;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { fd, epochMs, intervalMs, shared, nameTable, nameBytes: NAME_BYTES }, stdout: false, stderr: false });
    worker.on("error", (err) => write({ t: t(), kind: "note", note: `worker sampler failed: ${err instanceof Error ? err.message : String(err)}` }));
    worker.unref();
  } catch (err) {
    write({ t: t(), kind: "note", note: `worker sampler unavailable: ${err instanceof Error ? err.message : String(err)}` });
  }

  const names: string[] = [];
  const indexes = new Map<string, number>();
  const indexOf = (phase: string): number => {
    let index = indexes.get(phase);
    if (index === undefined) {
      index = names.length;
      names.push(phase);
      indexes.set(phase, index);
      if (index < NAME_SLOTS) {
        const bytes = new TextEncoder().encode(phase).subarray(0, NAME_BYTES - 1);
        nameTable.set(bytes, index * NAME_BYTES);
      }
    }
    return index;
  };
  const stack: Array<{ index: number }> = [];
  const current = (): string | null => {
    const top = stack[stack.length - 1];
    return top === undefined ? null : names[top.index] ?? null;
  };

  const enter: RunMemoryTrace["enter"] = (phase, extra) => {
    const index = indexOf(phase);
    const entry = { index };
    stack.push(entry);
    const started = Date.now();
    beat();
    Atomics.store(shared, CURRENT, BigInt(index));
    Atomics.store(shared, LAST, BigInt(index));
    write({ t: t(), kind: "phase", phase, edge: "enter", ...extra });
    let exited = false;
    return (ok = true) => {
      if (exited) return;
      exited = true;
      const at = stack.lastIndexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      beat();
      const top = stack[stack.length - 1];
      Atomics.store(shared, CURRENT, BigInt(top === undefined ? -1 : top.index));
      Atomics.store(shared, LAST, BigInt(index));
      write({ t: t(), kind: "phase", phase, edge: "exit", ok, ms: Date.now() - started, ...extra });
    };
  };

  const span: RunMemoryTrace["span"] = (phase, fn, extra) => {
    const exit = enter(phase, extra);
    let result;
    try {
      result = fn();
    } catch (err) {
      exit(false);
      throw err;
    }
    if (result instanceof Promise) {
      return result.then((value: unknown) => {
        exit(true);
        return value;
      }, (err: unknown) => {
        exit(false);
        throw err;
      }) as typeof result;
    }
    exit(true);
    return result;
  };

  const phaseHook: RunMemoryTrace["phaseHook"] = (prefix) => {
    const entered = new Map<string, Array<(ok?: boolean) => void>>();
    return (phase, edge, ok) => {
      const name = `${prefix}${phase}`;
      if (edge === "enter") {
        const exits = entered.get(name) ?? [];
        exits.push(enter(name));
        entered.set(name, exits);
        return;
      }
      entered.get(name)?.pop()?.(ok);
    };
  };

  let expected = Date.now();
  const sample = (): void => {
    const now = Date.now();
    const m = process.memoryUsage();
    beat();
    write({
      t: now - epochMs, kind: "main", rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external,
      arrayBuffers: m.arrayBuffers, lagMs: Math.max(0, now - expected), phase: current(),
    });
    expected = now + intervalMs;
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  const onExit = (code: number): void => write({ t: t(), kind: "exit", code, phase: current() });
  process.on("exit", onExit);

  return {
    path,
    enter,
    span,
    phaseHook,
    stop: async () => {
      if (!open) return;
      clearInterval(timer);
      process.off("exit", onExit);
      await worker?.terminate().catch(() => {});
      write({ t: t(), kind: "stop" });
      open = false;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    },
  };
}

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const { fd, epochMs, intervalMs, shared, nameTable, nameBytes } = workerData;
const decoder = new TextDecoder();
const name = (slot) => {
  const i = Number(Atomics.load(shared, slot));
  if (i < 0) return null;
  if ((i + 1) * nameBytes > nameTable.length) return "#" + i;
  const bytes = nameTable.slice(i * nameBytes, (i + 1) * nameBytes);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
};
const sample = () => {
  const now = Date.now();
  const line = JSON.stringify({
    t: now - epochMs, kind: "worker", rss: process.memoryUsage.rss(),
    heartbeatAgeMs: now - Number(Atomics.load(shared, 0)), phase: name(1), lastPhase: name(2),
  });
  try { writeSync(fd, line + "\\n"); } catch {}
};
sample();
setInterval(sample, intervalMs);
`;
