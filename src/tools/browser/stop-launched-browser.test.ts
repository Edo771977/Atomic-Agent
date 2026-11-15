import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PlaywrightBackend } from "./playwright-backend.js";

/** A Playwright context/browser pair that records its own teardown. */
function fakeBrowser() {
  const closed = { context: 0, browser: 0 };
  const browser = {
    contexts: () => [context],
    close: vi.fn(async () => { closed.browser += 1; }),
    newContext: vi.fn(),
    isConnected: () => true,
  };
  const context = {
    browser: () => browser,
    close: vi.fn(async () => { closed.context += 1; }),
    pages: () => [],
  };
  return { browser, closed };
}

const options = {
  userDataDir: "/tmp/never-used",
  channel: "chrome" as const,
  headless: true,
  launchTimeoutMs: 1_000,
};

describe("PlaywrightBackend.stopLaunchedBrowser (ATO-1084)", () => {
  it("leaves a browser it attached to over cdpUrl alone", async () => {
    const fake = fakeBrowser();
    const backend = new PlaywrightBackend({
      ...options,
      cdpUrl: "http://127.0.0.1:9222",
      connectOverCdp: async () => fake.browser as never,
    });
    await backend.ensureReady();
    expect(await backend.stopLaunchedBrowser()).toBe(false);
    expect(fake.closed).toEqual({ context: 0, browser: 0 });
  });

  it("is a no-op before anything was launched", async () => {
    const backend = new PlaywrightBackend(options);
    expect(await backend.stopLaunchedBrowser()).toBe(false);
  });

  it("stops the Chrome it spawned and closes its context", async () => {
    const fake = fakeBrowser();
    const backend = new PlaywrightBackend({
      ...options,
      userDataDir: mkdtempSync(join(tmpdir(), "stop-launched-")),
      connectOverCdp: async () => fake.browser as never,
    });
    // Stand in for launchOwnChrome: a process the backend owns.
    const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    const internals = backend as unknown as {
      launchOwnChrome: () => Promise<string>;
      spawnedProc: unknown;
      spawnedUserDataDir: string | null;
    };
    internals.launchOwnChrome = async () => {
      internals.spawnedProc = proc;
      return "http://127.0.0.1:1";
    };
    await backend.ensureReady();
    expect(await backend.stopLaunchedBrowser()).toBe(true);
    expect(fake.closed).toEqual({ context: 1, browser: 1 });
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  });
});
