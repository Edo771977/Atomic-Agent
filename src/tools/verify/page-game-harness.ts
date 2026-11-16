/**
 * The game harness of a page run (issue #40): the same fixed driver for
 * every game, run IN THE PAGE. No model- or director-written code plays
 * the game; the page only has to expose the documented API:
 *
 *   window.__game = {
 *     start(opts?: { seed?: number, mode?: "auto" }): void | Promise<void>,
 *     step(): void | Promise<void>,   // one move/turn, computer vs itself
 *     state(): { over: boolean, winner: string | null, moves: number, error?: string },
 *   }
 *
 * Game `i` (0-based) starts with `{ seed: i + 1, mode: "auto" }`, then
 * `step()` is called until `state().over`, `maxMsPerGame` has passed or
 * `state().moves` reached `maxMoves`. The loop yields to the page's event
 * loop every few steps so timers and error events still run. Per game the
 * harness records its duration, winner, moves and errors: a throw from
 * `start`/`step`/`state`, a `state().error`, and every uncaught page error
 * or console error the page raised while that game ran (counted by the
 * Node side, which sees `pageerror`/`console`).
 */
import type { Page } from "playwright-core";

import type { VerifyGameSpec } from "./verify-run-args.js";

export const GAME_API_MISSING = "the page exposes no window.__game API; the brief requires it";
/** How many errors one game keeps (the count is exact). */
const GAME_ERRORS_KEPT = 5;
const WINNER_CHARS = 40;
/** Node-side slack over `maxMsPerGame` before a game that never returns is given up. */
const GAME_RETURN_SLACK_MS = 5_000;

export interface VerifyGameRun {
  /** 0-based. */
  readonly index: number;
  readonly seed: number;
  /** `state().over` was reached. */
  readonly finished: boolean;
  readonly winner: string | null;
  readonly moves: number | null;
  readonly durationMs: number;
  /** At most 5 kept; `errorCount` is exact. */
  readonly errors: readonly string[];
  readonly errorCount?: number;
  /** Stopped at `maxMsPerGame`. */
  readonly timedOut?: true;
  /** Stopped at `maxMoves`. */
  readonly movesCapped?: true;
}

export interface VerifyGameSummary {
  /** Games asked for. */
  readonly n: number;
  /** Games started. */
  readonly played: number;
  readonly finished: number;
  /** Errors over every game. */
  readonly errors: number;
  readonly medianMs: number | null;
  readonly medianMoves: number | null;
  /** Finished games per winner; a `null` winner (a draw) counts as `"none"`. */
  readonly winners: Readonly<Record<string, number>>;
  readonly runs: readonly VerifyGameRun[];
  /** The page has no usable `window.__game`: why, and no game was played. */
  readonly missingApi?: string;
}

/** What the page-side driver returns for one game. */
interface InPageGame {
  readonly missing?: string;
  readonly over?: boolean;
  readonly winner?: unknown;
  readonly moves?: unknown;
  readonly durationMs?: number;
  readonly errors?: readonly string[];
  readonly timedOut?: boolean;
  readonly movesCapped?: boolean;
}

/**
 * The driver, evaluated in the page with `{seed, maxMs, maxMoves}`. Kept
 * as source so it runs in the page's realm, never in Node.
 */
export const GAME_DRIVER_SOURCE = `async ({ seed, maxMs, maxMoves }) => {
  const g = window.__game;
  const missing = [];
  if (g === null || typeof g !== "object" && typeof g !== "function") return { missing: "window.__game is " + (g === null ? "null" : typeof g) };
  for (const name of ["start", "step", "state"]) if (typeof g[name] !== "function") missing.push(name + "()");
  if (missing.length > 0) return { missing: "window.__game has no " + missing.join(", ") };
  const errors = [];
  const say = (where, e) => errors.push(where + " threw: " + (e && e.message ? e.message : String(e)));
  const t0 = performance.now();
  let st = null, timedOut = false, movesCapped = false, steps = 0;
  try { await g.start({ seed, mode: "auto" }); } catch (e) { say("start()", e); }
  const read = () => {
    try {
      const s = g.state();
      if (s === null || typeof s !== "object") { errors.push("state() returned " + (s === null ? "null" : typeof s)); return null; }
      if (typeof s.error === "string" && s.error.length > 0) errors.push("state().error: " + s.error.slice(0, 200));
      return s;
    } catch (e) { say("state()", e); return null; }
  };
  while (errors.length === 0) {
    st = read();
    if (st === null || st.over === true) break;
    if (performance.now() - t0 > maxMs) { timedOut = true; break; }
    if (maxMoves !== null && typeof st.moves === "number" && st.moves >= maxMoves) { movesCapped = true; break; }
    try { await g.step(); } catch (e) { say("step()", e); break; }
    steps += 1;
    if (steps % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (errors.length > 0 && st === null) st = read();
  await new Promise((r) => setTimeout(r, 0));
  return {
    over: st !== null && st.over === true,
    winner: st === null ? null : st.winner,
    moves: st === null ? null : st.moves,
    durationMs: Math.round(performance.now() - t0),
    errors,
    timedOut,
    movesCapped,
  };
}`;

/** The page's error stream the harness reads per game: everything seen so far. */
export interface GameErrorFeed {
  /** Every uncaught page error and console error, in order, uncapped count. */
  readonly seen: () => readonly string[];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function winnerOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
  return text.length > WINNER_CHARS ? `${text.slice(0, WINNER_CHARS - 1)}…` : text;
}

export function summarizeGames(n: number, runs: readonly VerifyGameRun[], missingApi?: string): VerifyGameSummary {
  const winners: Record<string, number> = {};
  for (const run of runs) {
    if (!run.finished) continue;
    const key = run.winner ?? "none";
    winners[key] = (winners[key] ?? 0) + 1;
  }
  return {
    n,
    played: runs.length,
    finished: runs.filter((r) => r.finished).length,
    errors: runs.reduce((sum, r) => sum + (r.errorCount ?? r.errors.length), 0),
    medianMs: median(runs.map((r) => r.durationMs)),
    medianMoves: median(runs.flatMap((r) => (r.moves === null ? [] : [r.moves]))),
    winners,
    runs,
    ...(missingApi === undefined ? {} : { missingApi }),
  };
}

/** Play `spec.games` games in `page`, one after another. Never throws. */
export async function playGames(
  page: Pick<Page, "evaluate">,
  spec: VerifyGameSpec,
  feed: GameErrorFeed,
  signal?: AbortSignal,
  /** Told after each game that was played (a screenshot of its end). */
  afterGame?: (index: number) => Promise<void>,
): Promise<VerifyGameSummary> {
  const runs: VerifyGameRun[] = [];
  for (let index = 0; index < spec.games; index += 1) {
    if (signal?.aborted) break;
    const seed = index + 1;
    const before = feed.seen().length;
    const started = Date.now();
    let result: InPageGame;
    let stuck = false;
    try {
      const play = page.evaluate(
        `(${GAME_DRIVER_SOURCE})(${JSON.stringify({ seed, maxMs: spec.maxMsPerGame, maxMoves: spec.maxMoves ?? null })})`,
      ) as Promise<InPageGame>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const giveUp = new Promise<InPageGame>((resolve) => {
        timer = setTimeout(() => {
          stuck = true;
          resolve({ errors: [`the game did not return within ${spec.maxMsPerGame + GAME_RETURN_SLACK_MS} ms (a step that never ends?)`], timedOut: true });
        }, spec.maxMsPerGame + GAME_RETURN_SLACK_MS);
        // A cancel does not wait for the page.
        onAbort = () => {
          stuck = true;
          resolve({ errors: ["the run was cancelled during the game"] });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      result = await Promise.race([play, giveUp]);
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      play.catch(() => {});
    } catch (err) {
      result = { errors: [`the harness failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`] };
    }
    if (result.missing !== undefined) {
      return summarizeGames(spec.games, runs, `${GAME_API_MISSING} (${result.missing})`);
    }
    const pageErrors = feed.seen().slice(before);
    const errors = [...(result.errors ?? []), ...pageErrors];
    const moves = typeof result.moves === "number" && Number.isFinite(result.moves) ? result.moves : null;
    runs.push({
      index,
      seed,
      finished: result.over === true,
      winner: result.over === true ? winnerOf(result.winner) : null,
      moves,
      durationMs: result.durationMs ?? Date.now() - started,
      errors: errors.slice(0, GAME_ERRORS_KEPT),
      ...(errors.length > GAME_ERRORS_KEPT ? { errorCount: errors.length } : {}),
      ...(result.timedOut === true ? { timedOut: true as const } : {}),
      ...(result.movesCapped === true ? { movesCapped: true as const } : {}),
    });
    // A page stuck inside a step cannot play another game.
    if (stuck) break;
    await afterGame?.(index);
  }
  return summarizeGames(spec.games, runs);
}
