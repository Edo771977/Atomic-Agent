/**
 * `kind: "page"` — a local HTML file or a URL in a headless browser:
 * scripted input, then `seconds` of runtime with probes sampled.
 *
 * Playwright drives whichever Chromium-family browser the host has
 * (`config.browser.channel` / `executablePath`, else the first found,
 * else a Playwright-managed Chromium if one is installed) — always
 * headless. When none launches the run fails with `no browser
 * available: …`. It never passes for want of a browser.
 */
import { markAgentToolChild } from "../../sandbox/command-env.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";

import type { AtomicAgentConfig } from "../../config/index.js";
import { loadPlaywrightCore } from "../../native/load-playwright-core.js";
import { findChromeExecutable } from "../browser/find-chrome-executable.js";
import {
  MISSING_SELECTOR_GLOBAL,
  MISSING_SELECTOR_INIT_SCRIPT,
  type ProbeSample,
  sampleProbes,
} from "./page-probe-script.js";
import { capturePageJpeg } from "../browser/page-capture.js";
import { GAME_ERROR_CHARS, GAME_INIT_SCRIPT, playGames, type VerifyGameSummary } from "./page-game-harness.js";
import { defaultShotTarget, VERIFY_MAX_SCREENSHOTS, writeShot, type VerifyScreenshot, type VerifyShotTarget } from "./page-screenshots.js";
import type { VerifyRunArgs, VerifyScriptStep } from "./verify-run-args.js";

export type BrowserLauncher = () => Promise<Browser>;

export interface PageRunOutcome {
  readonly target: string;
  readonly launched: boolean;
  readonly loaded: boolean;
  readonly error?: string;
  /** Uncaught exceptions (`pageerror`) and failed script steps. */
  readonly errors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly consoleWarnings: readonly string[];
  readonly requestFailures: readonly string[];
  readonly missingSelectors: readonly string[];
  readonly probes: Readonly<Record<string, ProbeSample[]>>;
  /** The games played through `window.__game` (`args.game`), after the script steps. */
  readonly games?: VerifyGameSummary;
  /** `args.screenshot`: the shots taken (at the end, or after each game). */
  readonly screenshots?: readonly VerifyScreenshot[];
  /** Shots that could not be taken or saved; the run's own verdict stands. */
  readonly screenshotErrors?: readonly string[];
  readonly durationMs: number;
}

const LIST_CAP = 50;
/** Page errors kept for attributing them to games; only the count past it is lost. */
const ERROR_FEED_CAP = 10_000;
/** One page or console error a game keeps, at most this long. */
const ERROR_FEED_ENTRY_CHARS = GAME_ERROR_CHARS;
/**
 * How long a click or type step waits for its control to become actionable.
 * 5 s was too short on a slow machine (the Windows CI runner failed a good
 * page with "page.click: Timeout 5000ms exceeded"); the run's own timeoutMs
 * still bounds the whole check.
 */
const STEP_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 30_000;

/** The host's browser first, then a Playwright-managed one; else a clear error. */
export function defaultBrowserLauncher(
  config: Pick<AtomicAgentConfig, "browser">,
): BrowserLauncher {
  return async () => {
    const pw = await loadPlaywrightCore();
    const reasons: string[] = [];
    const env = markAgentToolChild(process.env);
    const args = config.browser.noSandbox ? ["--no-sandbox"] : [];
    let executable: string | null = null;
    try {
      executable =
        findChromeExecutable({
          executablePath: config.browser.executablePath,
          channel: config.browser.channel,
        })?.path ?? null;
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
    if (executable !== null) {
      try {
        return await pw.chromium.launch({ executablePath: executable, headless: true, args, env });
      } catch (err) {
        reasons.push(`${executable}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    } else if (reasons.length === 0) {
      reasons.push("no Chromium-family browser found (Chrome, Edge, Brave, Chromium)");
    }
    try {
      return await pw.chromium.launch({ headless: true, args, env });
    } catch (err) {
      reasons.push(`playwright chromium: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    throw new Error(`no browser available: ${reasons.join("; ")}`);
  };
}

/** 127.0.0.1 and friends, `localhost`, `::1`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function push(list: string[], entry: string): void {
  if (list.length < LIST_CAP) list.push(entry);
}

async function runStep(page: Page, step: VerifyScriptStep): Promise<void> {
  switch (step.action) {
    case "click":
      await page.click(step.selector ?? "", { timeout: STEP_TIMEOUT_MS });
      return;
    case "key":
      await page.keyboard.press(step.key ?? "");
      return;
    case "type":
      if (step.selector !== undefined) {
        await page.locator(step.selector).pressSequentially(step.text ?? "", { timeout: STEP_TIMEOUT_MS });
      } else {
        await page.keyboard.type(step.text ?? "");
      }
      return;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms ?? 0, 60_000));
      return;
  }
}

function describeStep(step: VerifyScriptStep): string {
  const detail = step.selector ?? step.key ?? step.text ?? (step.ms === undefined ? "" : `${step.ms}ms`);
  return `${step.action} ${JSON.stringify(detail)}`;
}

export async function runPageKind(
  args: VerifyRunArgs,
  ctx: {
    cwd: string;
    signal?: AbortSignal;
    launch: BrowserLauncher;
    /** Where `args.screenshot` shots go; the temp screenshot folder when absent. */
    shots?: VerifyShotTarget;
  },
): Promise<PageRunOutcome> {
  const started = Date.now();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const requestFailures: string[] = [];
  let missingSelectors: string[] = [];
  let probes: Record<string, ProbeSample[]> = {};
  let games: VerifyGameSummary | undefined;
  const screenshots: VerifyScreenshot[] = [];
  const screenshotErrors: string[] = [];
  const shotTarget = args.screenshot === undefined ? undefined : (ctx.shots ?? defaultShotTarget());
  // Every uncaught error and console error, in order: a game owns the
  // ones raised while it ran.
  const errorFeed: string[] = [];
  const feed = (entry: string): void => {
    if (errorFeed.length < ERROR_FEED_CAP) errorFeed.push(entry.length > ERROR_FEED_ENTRY_CHARS ? `${entry.slice(0, ERROR_FEED_ENTRY_CHARS - 1)}…` : entry);
  };
  const done = (partial: Partial<PageRunOutcome> & { target: string; launched: boolean; loaded: boolean }): PageRunOutcome => ({
    errors, consoleErrors, consoleWarnings, requestFailures, missingSelectors, probes,
    ...(games === undefined ? {} : { games }),
    ...(args.screenshot === undefined ? {} : { screenshots }),
    ...(screenshotErrors.length === 0 ? {} : { screenshotErrors }),
    durationMs: Date.now() - started,
    ...partial,
  });

  let target: string;
  if (args.url !== undefined) {
    target = args.url;
  } else {
    const file = resolve(ctx.cwd, args.path ?? "");
    if (!existsSync(file)) {
      return done({ target: file, launched: false, loaded: false, error: `no such file: ${args.path}` });
    }
    target = pathToFileURL(file).href;
  }

  let browser: Browser;
  try {
    browser = await ctx.launch();
  } catch (err) {
    return done({ target, launched: false, loaded: false, error: err instanceof Error ? err.message : String(err) });
  }
  // Closed once, whichever of the deadline, a cancel or the end comes first.
  let closing: Promise<void> | undefined;
  const closeBrowser = (): Promise<void> => (closing ??= browser.close().catch(() => {}));
  const deadline = setTimeout(() => {
    push(errors, `run exceeded timeoutMs (${args.timeoutMs})`);
    void closeBrowser();
  }, args.timeoutMs);
  // A cancel closes the browser: whatever the page is doing (a game step
  // that never ends, a probe) stops with it.
  const onAbort = (): void => {
    push(errors, "the run was cancelled");
    void closeBrowser();
  };
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    if (!args.network) {
      // Loopback stays reachable: a page served by the run's own `start`
      // server (or any local dev server) is not "the network".
      await context.route((url) => /^https?:$/.test(url.protocol) && !isLoopbackHost(url.hostname), (route) => {
        push(requestFailures, `${route.request().url()} blocked (network: false)`);
        return route.abort("blockedbyclient");
      });
    }
    const page = await context.newPage();
    page.on("pageerror", (err) => {
      const message = err.message.split("\n")[0] ?? String(err);
      const text = err.name.length > 0 && !message.startsWith(err.name) ? `${err.name}: ${message}` : message;
      push(errors, text);
      feed(`uncaught: ${text}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        push(consoleErrors, msg.text());
        feed(`console: ${msg.text()}`);
      }
      else if (msg.type() === "warning") push(consoleWarnings, msg.text());
    });
    page.on("requestfailed", (req) => {
      const why = req.failure()?.errorText ?? "failed";
      if (!why.includes("BLOCKED_BY_CLIENT")) push(requestFailures, `${req.url()} ${why}`);
    });
    await page.addInitScript(MISSING_SELECTOR_INIT_SCRIPT);
    if (args.game !== undefined) await page.addInitScript(GAME_INIT_SCRIPT);
    try {
      await page.goto(target, { waitUntil: "load", timeout: Math.min(LOAD_TIMEOUT_MS, args.timeoutMs) });
    } catch (err) {
      return done({ target, launched: true, loaded: false, error: `page load failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
    }
    for (const step of args.script ?? []) {
      if (ctx.signal?.aborted) break;
      try {
        await runStep(page, step);
      } catch (err) {
        push(errors, `script step ${describeStep(step)} failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    const shoot = async (game?: number): Promise<void> => {
      if (args.screenshot === undefined || shotTarget === undefined || screenshots.length >= VERIFY_MAX_SCREENSHOTS || ctx.signal?.aborted) return;
      try {
        const shot = await capturePageJpeg(page, { fullPage: args.screenshot.fullPage });
        const path = await writeShot(shotTarget, shot.buffer);
        screenshots.push({
          path, bytes: shot.buffer.length, width: shot.width, height: shot.height,
          ...(shot.clipped ? { clipped: true as const } : {}),
          ...(game === undefined ? {} : { game }),
        });
      } catch (err) {
        push(screenshotErrors, `screenshot${game === undefined ? "" : ` after game ${game + 1}`}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    };
    if (args.game !== undefined && !ctx.signal?.aborted) {
      games = await playGames(page, args.game, { seen: () => errorFeed }, ctx.signal, (index) => shoot(index));
    }
    probes = await sampleProbes(args.probes ?? [], args.seconds, (expr) => page.evaluate(expr), ctx.signal);
    // Without games, one shot at the end of the run (after the script
    // steps and the probes' runtime).
    if (args.game === undefined) await shoot();
    try {
      const recorded = await page.evaluate(`window[${JSON.stringify(MISSING_SELECTOR_GLOBAL)}]`);
      missingSelectors = Array.isArray(recorded) ? recorded.map(String) : [];
    } catch {
      // The page navigated away or closed; nothing to read.
    }
    return done({ target, launched: true, loaded: true });
  } catch (err) {
    return done({ target, launched: true, loaded: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
  } finally {
    clearTimeout(deadline);
    ctx.signal?.removeEventListener("abort", onAbort);
    await closeBrowser();
  }
}
