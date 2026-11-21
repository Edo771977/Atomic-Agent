import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Issue #106: after `run` printed `pending`, the live process spun for
 * minutes, its private memory grew past 126 GiB and the 15 s deadline
 * (a timer on the main event loop) never fired. The watchdog runs on its
 * own thread: it ends the process even when the main loop never yields,
 * and early when memory grows past its cap.
 */
const MODULE = JSON.stringify(join(process.cwd(), "src", "cli", "hard-exit-deadline.ts"));

interface Ended { code: number | null; signal: NodeJS.Signals | null; stderr: string; ms: number }

function runFixture(dir: string, body: string[]): Promise<Ended> {
  const fixture = join(dir, "fixture.mts");
  writeFileSync(fixture, [`import { armHardExitDeadline } from ${MODULE};`, ...body].join("\n"));
  const started = Date.now();
  const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  // Keep only the end: the spinning fixture writes without pause.
  proc.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-20_000); });
  return new Promise((resolve) => {
    const killer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    proc.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stderr, ms: Date.now() - started });
    });
  });
}

describe("the exit watchdog (issue #106)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ends a process whose main loop spins on microtasks after `pending`, and says so", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-watchdog-spin-"));
    const ended = await runFixture(dir, [
      "armHardExitDeadline(() => 3, { ms: 1_000, watchdogGraceMs: 500 });",
      `process.stderr.write('"status": "pending"\\n');`,
      // Never yields to the event loop: timers on this thread never fire.
      "for (;;) { await Promise.resolve(); }",
    ]);
    expect(ended.ms).toBeLessThan(20_000);
    expect(ended.code === 0).toBe(false);
    expect(ended.stderr).toContain("atomic-agent watchdog:");
    expect(ended.stderr).toMatch(/main thread did not end the process.*exit code 3/);
  }, 40_000);

  it("ends a process whose memory grows past the cap, before the deadline, with the figures", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-watchdog-mem-"));
    const ended = await runFixture(dir, [
      "armHardExitDeadline(() => 3, { ms: 60_000, rssLimitBytes: 400 * 1024 * 1024 });",
      "const kept: Buffer[] = [];",
      // Grows steadily, but stops at 800 MiB so a missing cap cannot exhaust the machine running the test.
      "while (process.memoryUsage.rss() < 800 * 1024 * 1024) { kept.push(Buffer.alloc(8 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 20)); }",
      "setInterval(() => {}, 1000);",
    ]);
    expect(ended.ms).toBeLessThan(20_000);
    expect(ended.code === 0).toBe(false);
    expect(ended.stderr).toMatch(/atomic-agent watchdog: memory .* over the cap of 400 MiB/);
    expect(ended.stderr).toMatch(/rss \d/);
  }, 40_000);
});
