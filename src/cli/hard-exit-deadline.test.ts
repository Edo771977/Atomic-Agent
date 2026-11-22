import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { describeActiveHandles } from "./hard-exit-deadline.js";

/**
 * Issue #104: after `run` has saved the session and printed its summary,
 * a ref'd hard deadline ends the process with the run's exit code, saying
 * what was still alive, whatever holds the event loop.
 */
describe("armHardExitDeadline (issue #104)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("exits with the run's code within the deadline and names what was still alive", async () => {
    dir = mkdtempSync(join(tmpdir(), "aa-hard-exit-"));
    const fixture = join(dir, "fixture.mts");
    writeFileSync(fixture, [
      `import { spawn } from "node:child_process";`,
      `import { armHardExitDeadline } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "cli", "hard-exit-deadline.ts")).href)};`,
      // What would keep a process alive for good: a ref'd interval and a child that never exits.
      "setInterval(() => {}, 1000);",
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      "process.stdout.write(`child ${child.pid}\\n`);",
      "armHardExitDeadline(() => 3, { ms: 800 });",
    ].join("\n"));
    const started = Date.now();
    const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    const code = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => { proc.kill("SIGKILL"); resolve(null); }, 15_000);
      proc.on("exit", (c) => { clearTimeout(killer); resolve(c); });
    });
    const childPid = Number(/child (\d+)/.exec(out)?.[1]);
    try { process.kill(childPid); } catch { /* gone */ }
    expect(code).toBe(3);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(err).toContain("still running");
    expect(err).toMatch(/Timeout/);
    expect(err).toContain(`ChildProcess ${process.execPath} pid ${childPid}`);
  }, 30_000);

  it("describes handles by constructor, and a child by its program and pid", () => {
    const text = describeActiveHandles({
      resources: ["Timeout", "TTYWrap", "Timeout"],
      handles: [{ constructor: { name: "ChildProcess" }, spawnfile: "codex", pid: 42 }, { constructor: { name: "Socket" } }],
    });
    expect(text).toContain("Timeout x2");
    expect(text).toContain("ChildProcess codex pid 42");
    expect(text).toContain("Socket");
  });
});
