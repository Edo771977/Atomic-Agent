import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { coreBinary, CORE_VERSION } from "./core-state.js";

/**
 * Issue #102: Atomic Core is started during a run and outlives it. A
 * process that starts it through the real path (`ensureCore`) must still
 * let its own stdout/stderr pipes close when it exits: a daemon holding
 * an inherited handle keeps a shell's pipeline (PowerShell's `1> out.txt`)
 * open after the CLI is gone. The fake Core is node running a script that
 * only waits and records its pid.
 */
const BOUND_MS = 20_000;

describe("a Core started by a short-lived process (issue #102)", () => {
  let base: string;
  let daemonPid: number | undefined;
  afterEach(() => {
    if (daemonPid !== undefined) {
      try { process.kill(daemonPid); } catch { /* already gone */ }
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("keeps running while the starter exits and its pipes close in bounded time", async () => {
    base = mkdtempSync(join(tmpdir(), "aa-core-handles-"));
    const dataDir = join(base, "data");
    const binary = coreBinary(dataDir, CORE_VERSION);
    mkdirSync(join(binary, ".."), { recursive: true });
    if (process.platform === "win32") copyFileSync(process.execPath, binary);
    else symlinkSync(process.execPath, binary);
    // `node daemon …` runs this file (its cwd is the starter's): wait, say the pid.
    const work = join(base, "work");
    mkdirSync(work);
    const pidFile = join(base, "daemon.pid");
    writeFileSync(join(work, "daemon"), `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
    const starter = join(base, "starter.mts");
    writeFileSync(starter, [
      `import { ensureCore } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "local-llm", "core", "core-client.ts")).href)};`,
      "const controller = new AbortController();",
      // Give the spawn a moment, then stop waiting for a Core that never answers.
      "setTimeout(() => controller.abort(), 1500);",
      `await ensureCore(${JSON.stringify(dataDir)}, ${JSON.stringify(CORE_VERSION)}, controller.signal).catch(() => {});`,
      "process.stdout.write('started\\n');",
    ].join("\n"));
    const started = Date.now();
    // tsx by URL: the starter runs in a folder with no node_modules.
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), starter], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    let err = "";
    child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    const exited = new Promise<number>((resolve) => child.on("exit", () => resolve(Date.now() - started)));
    const closed = new Promise<number>((resolve) => child.on("close", () => resolve(Date.now() - started)));
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), BOUND_MS).unref());
    const exitMs = await Promise.race([exited, timeout]);
    const closeMs = await Promise.race([closed, timeout]);
    if (existsSync(pidFile)) daemonPid = Number(readFileSync(pidFile, "utf8"));
    if (closeMs === "timeout") child.kill();
    expect(out, err).toContain("started");
    expect(exitMs).not.toBe("timeout");
    // The pipes close with the starter, not with the daemon.
    expect(closeMs).not.toBe("timeout");
    expect(daemonPid).toBeGreaterThan(0);
    // And the daemon is meant to keep running.
    expect(() => process.kill(daemonPid!, 0)).not.toThrow();
  }, 40_000);
});
