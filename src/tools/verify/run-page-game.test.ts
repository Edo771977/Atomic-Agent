import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { defaultBrowserLauncher, type BrowserLauncher } from "./run-page-kind.js";
import { runVerify, type VerifyRunContext } from "./run-verify.js";

/**
 * The game harness under a real headless Chromium (issue #40). The host's
 * browser first, else a Playwright-managed headless shell or Chromium
 * from the browsers directory; skipped where none launches.
 */
function managedExecutables(): string[] {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(root).sort().reverse()) {
    for (const rel of [["chrome-headless-shell-linux64", "chrome-headless-shell"], ["chrome-linux64", "chrome"], ["chrome-linux", "chrome"]]) {
      const path = join(root, dir, ...rel);
      if (existsSync(path)) out.push(path);
    }
  }
  return out;
}

function config(executablePath: string | null): Pick<AtomicAgentConfig, "browser"> {
  return {
    browser: {
      enabled: true, channel: "chrome", headless: true, cdpUrl: null, connect: "agent", userChromeDataDir: null,
      executablePath, noSandbox: false, launchTimeoutMs: 20_000, blockedDomains: [], allowedDomains: [],
    },
  };
}

let launch: BrowserLauncher | undefined;
let work: string;

beforeAll(async () => {
  for (const executable of [null, ...managedExecutables()]) {
    const candidate = defaultBrowserLauncher(config(executable));
    try {
      await (await candidate()).close();
      launch = candidate;
      return;
    } catch {
      // next candidate
    }
  }
}, 60_000);

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "atag-verify-game-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function ctx(): VerifyRunContext {
  return { workingDir: work, config: config(null), ...(launch === undefined ? {} : { launchBrowser: launch }) };
}

/** A stub game: a counter race whose winner follows the seed. */
const STUB_GAME = `<html><body><script>
  let s = null;
  window.__game = {
    start(opts) { s = { seed: opts.seed, mode: opts.mode, moves: 0, over: false, winner: null }; window.__lastOpts = opts; },
    step() {
      s.moves += 1;
      if (s.seed === 2 && s.moves === 3) console.error("illegal move by O");
      if (s.moves >= 4 + s.seed) { s.over = true; s.winner = s.seed % 3 === 0 ? null : (s.seed % 2 ? "X" : "O"); }
    },
    state() { return { over: s.over, winner: s.winner, moves: s.moves }; },
  };
</script></body></html>`;

describe("runVerify — page games under a real browser", () => {
  it("plays N games through window.__game in the page and reports duration, winner, moves and errors per game", async (test) => {
    if (launch === undefined) return test.skip();
    await writeFile(join(work, "game.html"), STUB_GAME);
    const out = await runVerify({
      kind: "page", path: "game.html", seconds: 0.1,
      game: { games: 4, maxMsPerGame: 5_000 },
      checks: ["games finish", "game moves < 10", "game winner in [X, O, none]", "game winners vary", "game duration < 5000", "game errors 0"],
    }, ctx());
    expect(out.games).toMatchObject({ n: 4, played: 4, finished: 4, errors: 1, winners: { X: 1, O: 2, none: 1 } });
    expect(out.games!.runs.map((r) => [r.seed, r.winner, r.moves, r.finished])).toEqual([
      [1, "X", 5, true], [2, "O", 6, true], [3, null, 7, true], [4, "O", 8, true],
    ]);
    // A console error during game 2 counts against game 2 only.
    expect(out.games!.runs[1]!.errors).toEqual(["console: illegal move by O"]);
    expect(out.games!.runs[0]!.errors).toEqual([]);
    expect(out.games!.medianMoves).toBe(6.5);
    expect(typeof out.games!.medianMs).toBe("number");
    expect(out.checks!.map((c) => [c.check, c.ok])).toEqual([
      ["games finish", true], ["game moves < 10", true], ["game winner in [X, O, none]", true],
      ["game winners vary", true], ["game duration < 5000", true], ["game errors 0", false],
    ]);
    expect(out.summary).toContain("games: 4 of 4 finished");
  }, 60_000);

  it("stops a game at maxMoves or maxMsPerGame and counts an uncaught error thrown by step", async (test) => {
    if (launch === undefined) return test.skip();
    await writeFile(join(work, "endless.html"), `<html><body><script>
      let m = 0, seed = 0;
      window.__game = {
        start(o) { m = 0; seed = o.seed; },
        async step() { m += 1; if (seed === 2 && m === 2) throw new Error("board is null"); await new Promise(r => setTimeout(r, 1)); },
        state() { return { over: false, winner: null, moves: m }; },
      };
    </script></body></html>`);
    const out = await runVerify({
      kind: "page", path: "endless.html", seconds: 0.1,
      game: { games: 3, maxMsPerGame: 400, maxMoves: 50 },
      checks: ["games finish"],
    }, ctx());
    const [first, second, third] = out.games!.runs;
    expect(first).toMatchObject({ finished: false, moves: 50, movesCapped: true });
    expect(second).toMatchObject({ finished: false });
    expect(second!.errors.join(" ")).toContain("board is null");
    expect(third).toMatchObject({ finished: false });
    expect(out.games!.finished).toBe(0);
    expect(out.checks![0]).toMatchObject({ ok: false, detail: expect.stringContaining("0 of 3 games finished") });
    expect(out.ok).toBe(false);
  }, 60_000);

  it("fails with a clear reason when the page exposes no window.__game", async (test) => {
    if (launch === undefined) return test.skip();
    await writeFile(join(work, "plain.html"), "<html><body>no game here</body></html>");
    const out = await runVerify({
      kind: "page", path: "plain.html", seconds: 0.1,
      game: { games: 2, maxMsPerGame: 1_000 },
      checks: ["games finish", "no errors"],
    }, ctx());
    expect(out.ok).toBe(false);
    expect(out.games?.missingApi).toContain("the page exposes no window.__game API; the brief requires it");
    expect(out.checks![0]).toMatchObject({ ok: false, detail: expect.stringContaining("no window.__game API") });
    // The page itself had no errors; the run fails for the missing API.
    expect(out.checks![1]).toMatchObject({ ok: true });
    expect(out.summary).toContain("no window.__game API");
  }, 60_000);

  it("passes {seed, mode: 'auto'} to start", async (test) => {
    if (launch === undefined) return test.skip();
    await writeFile(join(work, "game.html"), STUB_GAME.replace("</script>", "window.addEventListener('load', () => {});</script>"));
    const out = await runVerify({
      kind: "page", path: "game.html", seconds: 0.3,
      game: { games: 1, maxMsPerGame: 2_000 },
      probes: [{ name: "opts", expr: "JSON.stringify(window.__lastOpts)" }],
    }, ctx());
    expect(out.probes!.opts!.at(-1)![1]).toBe(JSON.stringify({ seed: 1, mode: "auto" }));
  }, 60_000);
});
