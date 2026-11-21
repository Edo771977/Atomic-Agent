import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_MEMORY_TRACE_ENV, startRunMemoryTrace } from "./run-memory-trace.js";

/**
 * Issue #106: the live run was found at 126 GiB after `pending` with no
 * record of when the memory grew or what the process was doing. The trace
 * says it, and keeps saying it from a worker thread when the main loop
 * stops turning.
 */
type TraceRecord = Record<string, unknown> & { kind: string; t: number };

const readTrace = (path: string): TraceRecord[] =>
  readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as TraceRecord);

const MAIN_FIELDS = ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers", "lagMs"];
const WORKER_FIELDS = ["rss", "heartbeatAgeMs"];

function expectNumbers(record: TraceRecord, fields: string[]): void {
  for (const field of fields) expect(typeof record[field], `${record.kind}.${field}`).toBe("number");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the run memory trace (issue #106)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is off when the variable is unset or empty: nothing opened, no worker", () => {
    dir = mkdtempSync(join(tmpdir(), "aa-trace-off-"));
    expect(startRunMemoryTrace({})).toBeNull();
    expect(startRunMemoryTrace({ [RUN_MEMORY_TRACE_ENV]: "  " })).toBeNull();
  });

  it("writes a start record, phase pairs in order, and main and worker samples", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-trace-unit-"));
    const path = join(dir, "trace.ndjson");
    const trace = startRunMemoryTrace({ [RUN_MEMORY_TRACE_ENV]: path }, { argv: ["--cwd", "/secret/place", "--allow-command=x y"], intervalMs: 100 });
    expect(trace).not.toBeNull();
    const outer = trace!.enter("outer");
    await trace!.span("inner", async () => sleep(250), { n: 1 });
    expect(() => trace!.span("throws", () => { throw new Error("no"); })).toThrow("no");
    const hook = trace!.phaseHook("shutdown:");
    hook("mcp", "enter");
    hook("mcp", "exit", false);
    outer();
    await sleep(250);
    await trace!.stop();
    const records = readTrace(path);
    const start = records[0]!;
    expect(start).toMatchObject({ kind: "start", pid: process.pid, platform: process.platform, node: process.version, flags: ["--cwd", "--allow-command"], argCount: 3 });
    expect(JSON.stringify(start)).not.toContain("/secret/place");
    const phases = records.filter((r) => r.kind === "phase").map((r) => `${String(r.edge)}:${String(r.phase)}${r.edge === "exit" ? `:${String(r.ok)}` : ""}`);
    expect(phases).toEqual([
      "enter:outer", "enter:inner", "exit:inner:true", "enter:throws", "exit:throws:false",
      "enter:shutdown:mcp", "exit:shutdown:mcp:false", "exit:outer:true",
    ]);
    const innerExit = records.find((r) => r.kind === "phase" && r.phase === "inner" && r.edge === "exit")!;
    expect(innerExit.n).toBe(1);
    expect(innerExit.ms as number).toBeGreaterThanOrEqual(200);
    const main = records.filter((r) => r.kind === "main");
    expect(main.length).toBeGreaterThanOrEqual(3);
    for (const sample of main) expectNumbers(sample, MAIN_FIELDS);
    expect(main.some((sample) => sample.phase === "inner")).toBe(true);
    const worker = records.filter((r) => r.kind === "worker");
    expect(worker.length).toBeGreaterThanOrEqual(2);
    for (const sample of worker) expectNumbers(sample, WORKER_FIELDS);
    expect(worker.some((sample) => sample.phase === "inner" || sample.lastPhase === "inner")).toBe(true);
    expect(records.at(-1)!.kind).toBe("stop");
  });

  it("keeps sampling from the worker while the main thread spins, with the phase and a growing heartbeat age", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-trace-spin-"));
    const path = join(dir, "trace.ndjson");
    const fixture = join(dir, "fixture.mts");
    writeFileSync(fixture, [
      `import { startRunMemoryTrace } from ${JSON.stringify(join(process.cwd(), "src", "cli", "run-memory-trace.ts"))};`,
      `const trace = startRunMemoryTrace({ ${RUN_MEMORY_TRACE_ENV}: ${JSON.stringify(path)} }, { intervalMs: 250 });`,
      // Let the worker come up and sample a calm process first.
      "await new Promise((r) => setTimeout(r, 700));",
      "trace.enter(\"spin-phase\");",
      // Never yields to the event loop for 3 s; allocates up to 300 MiB on the way.
      "const kept = []; const until = Date.now() + 3_000; let i = 0;",
      "while (Date.now() < until) { await Promise.resolve(); if (++i % 2_000 === 0 && kept.length < 300) kept.push(Buffer.alloc(1024 * 1024, 1)); }",
      "process.exit(0);",
    ].join("\n"));
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { stdio: "ignore" });
      const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", (exitCode) => {
        clearTimeout(killer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    const records = readTrace(path);
    const entered = records.find((r) => r.kind === "phase" && r.phase === "spin-phase")!;
    expect(entered).toBeDefined();
    const during = records.filter((r) => r.kind === "worker" && r.t > entered.t + 300);
    expect(during.length).toBeGreaterThanOrEqual(4);
    for (const sample of during) expect(sample.phase).toBe("spin-phase");
    const ages = during.map((sample) => sample.heartbeatAgeMs as number);
    for (let i = 1; i < ages.length; i += 1) expect(ages[i]!).toBeGreaterThan(ages[i - 1]!);
    expect(ages.at(-1)!).toBeGreaterThan(2_000);
    // The main thread wrote nothing while it spun.
    expect(records.filter((r) => r.kind === "main" && r.t > entered.t + 300 && r.t < entered.t + 2_900)).toEqual([]);
    // The worker saw the process grow while the heap's own samples stopped.
    const before = records.filter((r) => r.kind === "worker" && r.t < entered.t).at(-1)!;
    expect((during.at(-1)!.rss as number) - (before.rss as number)).toBeGreaterThan(50 * 1024 * 1024);
    expect(records.at(-1)).toMatchObject({ kind: "exit", code: 0, phase: "spin-phase" });
  }, 40_000);
});

/** The real `run` entry, spawned with stdin closed: the variable is read by the command itself. */
describe("run with ATOMIC_AGENT_RUN_MEMORY_TRACE (issue #106)", () => {
  let stateDir: string;
  let workingDir: string;
  let dir: string;
  afterEach(() => {
    for (const path of [stateDir, workingDir, dir]) rmSync(path, { recursive: true, force: true });
  });

  const runCli = (env: NodeJS.ProcessEnv): Promise<number | null> => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli", "index.ts"), "run", "--cwd", workingDir], {
      env, stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve(code);
    });
  });

  const baseEnv = (): NodeJS.ProcessEnv => {
    stateDir = mkdtempSync(join(tmpdir(), "aa-trace-cli-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "aa-trace-cli-cwd-"));
    dir = mkdtempSync(join(tmpdir(), "aa-trace-cli-out-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATOMIC_AGENT_STATE_DIR: stateDir,
      ATOMIC_AGENT_GRAMMARS_DIR: join(process.cwd(), "grammars"),
      ATOMIC_AGENT_ANALYTICS: "off",
    };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env[RUN_MEMORY_TRACE_ENV];
    return env;
  };

  it("traces the run from boot through every shutdown step, with samples from both threads", async () => {
    const env = baseEnv();
    const path = join(dir, "run.ndjson");
    expect(await runCli({ ...env, [RUN_MEMORY_TRACE_ENV]: path })).toBe(0);
    const records = readTrace(path);
    expect(records[0]).toMatchObject({ kind: "start", flags: ["--cwd"] });
    const entered = records.filter((r) => r.kind === "phase" && r.edge === "enter").map((r) => r.phase as string);
    const main = entered.filter((phase) => !phase.startsWith("shutdown:"));
    expect(main).toEqual(["boot", "stdin-read", "settle-gates", "session-save", "result-print", "hard-exit-arm", "stdin-close", "shutdown"]);
    const steps = entered.filter((phase) => phase.startsWith("shutdown:"));
    for (const step of ["shutdown:compaction", "shutdown:mcp", "shutdown:browser", "shutdown:consolidator", "shutdown:analytics", "shutdown:error-reporter", "shutdown:trace-export"]) {
      expect(steps).toContain(step);
    }
    // Each phase exits after it entered, and the shutdown steps lie inside the shutdown.
    const at = (phase: string, edge: string): number => records.findIndex((r) => r.kind === "phase" && r.phase === phase && r.edge === edge);
    for (const phase of entered) expect(at(phase, "exit")).toBeGreaterThan(at(phase, "enter"));
    expect(at("shutdown:compaction", "enter")).toBeGreaterThan(at("shutdown", "enter"));
    expect(at("shutdown:trace-export", "exit")).toBeLessThan(at("shutdown", "exit"));
    for (const sample of records.filter((r) => r.kind === "main")) expectNumbers(sample, MAIN_FIELDS);
    expect(records.some((r) => r.kind === "main")).toBe(true);
    const worker = records.filter((r) => r.kind === "worker");
    expect(worker.length).toBeGreaterThanOrEqual(1);
    for (const sample of worker) expectNumbers(sample, WORKER_FIELDS);
    expect(records.at(-1)).toMatchObject({ kind: "exit", code: 0 });
  }, 60_000);
});
