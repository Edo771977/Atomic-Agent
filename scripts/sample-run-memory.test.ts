// Issue #106: a live `run` reached 126 GiB private memory before anyone
// looked. The sampler records a process's memory from outside every
// interval and stops it as soon as a limit says the growth is evident.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isProcessRunning } from "../test/helpers/process-liveness.js";

const SCRIPT = resolve(import.meta.dirname, "sample-run-memory.mjs");

type SampleRecord = Record<string, unknown> & { kind: string; elapsedMs: number };

interface Ran { code: number | null; stderr: string }

function sampler(args: string[]): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const killer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      done({ code, stderr });
    });
  });
}

const read = (path: string): SampleRecord[] =>
  readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as SampleRecord);

/** Still there 3 s on (an orphan killed with its parent is reaped a moment later). */
async function alive(pid: number): Promise<boolean> {
  for (let i = 0; i < 30 && isProcessRunning(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  return isProcessRunning(pid);
}

/** Grows by 8 MiB every 50 ms, up to 800 MiB. Self-cleans if the sampler fails. */
const GROWER = "console.error('pid ' + process.pid); setTimeout(() => process.exit(1), 40_000); const k = []; setInterval(() => { if (k.length < 100) k.push(Buffer.alloc(8 << 20, 1)); }, 50);";

describe("sample-run-memory", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records a normal command's memory and exits with its code", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-sampler-ok-"));
    const out = join(dir, "samples.ndjson");
    const ran = await sampler(["--output", out, "--interval-ms", "200", "--", process.execPath, "-e", "setTimeout(() => process.exit(7), 4000)"]);
    expect(ran.code).toBe(7);
    const records = read(out);
    expect(records[0]).toMatchObject({ kind: "start", platform: process.platform, intervalMs: 200 });
    const samples = records.filter((r) => r.kind === "sample");
    // PowerShell takes a moment to start on Windows.
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const s of samples) {
      expect(typeof s.elapsedMs).toBe("number");
      expect(s.residentBytes as number).toBeGreaterThan(0);
      if (process.platform !== "darwin") expect(s.privateBytes as number).toBeGreaterThan(0);
      expect(Array.isArray(s.processes)).toBe(true);
    }
    expect(records.at(-1)).toMatchObject({ kind: "end", code: 7 });
  }, 45_000);

  it("stops a command whose memory grows past --stop-private-mb, with a final record and a non-zero exit", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-sampler-stop-"));
    const out = join(dir, "samples.ndjson");
    const ran = await sampler(["--output", out, "--interval-ms", "200", "--stop-private-mb", "200", "--", process.execPath, "-e", GROWER]);
    expect(ran.code).toBe(4);
    expect(ran.stderr).toMatch(/sample-run-memory: private memory .* over 200 MB/);
    const records = read(out);
    const stop = records.find((r) => r.kind === "stop")!;
    expect(stop).toMatchObject({ reason: "private-over-limit", limitBytes: 200 * 1024 * 1024 });
    expect(stop.privateBytes as number).toBeGreaterThan(200 * 1024 * 1024);
    // Well before the grower's own 800 MiB ceiling.
    expect(stop.privateBytes as number).toBeLessThan(700 * 1024 * 1024);
    const pid = Number(/pid (\d+)/.exec(ran.stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await alive(pid)).toBe(false);
  }, 45_000);

  it("counts and stops the command's children too (a launcher that starts the real process)", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-sampler-tree-"));
    const out = join(dir, "samples.ndjson");
    const launcher = `const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", ${JSON.stringify(GROWER)}], { stdio: "inherit" }); c.on("exit", (code) => process.exit(code ?? 1));`;
    const ran = await sampler(["--output", out, "--interval-ms", "200", "--stop-private-mb", "200", "--", process.execPath, "-e", launcher]);
    expect(ran.code).toBe(4);
    const stop = read(out).find((r) => r.kind === "stop")!;
    expect((stop.processes as unknown[]).length).toBeGreaterThanOrEqual(2);
    const pid = Number(/pid (\d+)/.exec(ran.stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await alive(pid)).toBe(false);
  }, 45_000);

  it("attaches to a running process with --pid and ends when it does", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-sampler-attach-"));
    const out = join(dir, "samples.ndjson");
    const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "ignore" });
    const ran = await sampler(["--output", out, "--interval-ms", "200", "--pid", String(target.pid)]);
    expect(ran.code).toBe(0);
    const records = read(out);
    expect(records[0]).toMatchObject({ kind: "start", pid: target.pid, attached: true });
    expect(records.filter((r) => r.kind === "sample").length).toBeGreaterThanOrEqual(2);
    expect(records.at(-1)).toMatchObject({ kind: "end" });
  }, 45_000);

  it("refuses a usage error with exit 2", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-sampler-usage-"));
    expect((await sampler(["--", process.execPath, "-e", "0"])).code).toBe(2);
    expect((await sampler(["--output", join(dir, "x"), "--stop-private-mb", "zero", "--", process.execPath])).code).toBe(2);
  }, 45_000);
});
