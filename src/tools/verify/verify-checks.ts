/**
 * The `checks` assertion language of `verify.run`.
 *
 *   exit 0 | exit != 0 | exit == 0
 *   stdout contains "x" | stdout not contains "x"     (stderr likewise)
 *   stdout matches /re/flags | stdout not matches /re/flags
 *                                 (stderr likewise; `safe-regex.ts` policy)
 *   status 200                    every request answered with that status
 *   no errors                     page: no uncaught errors, no console errors
 *   missing selectors 0           page: that many failed lookups
 *   probe <name> decreases | increases
 *   probe <name> equals <v> | reaches <v> | stays <v>
 *   games finish                  page `game`: every game reached `over`
 *   game errors <n>               page `game`: errors over all games
 *   game duration < <ms>          every game finished in under that
 *   game moves < <n>              every game finished in fewer moves
 *   game winner in [a, b, none]   every finished game's winner is listed
 *   game winners vary             N >= 3 and not every game the same winner
 *
 * Small on purpose: a check is a sentence the brief's author can write
 * and the model can read back. Anything else fails as `unknown check`
 * rather than passing by accident.
 */

import type { VerifyGameSummary } from "./page-game-harness.js";
import { compileCheckRegex, testCheckRegex } from "./safe-regex.js";

export interface CheckOutcome {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What a check may look at — the union of every runner's outcome. */
export interface CheckSubject {
  readonly kind: import("./verify-run-args.js").VerifyRunKind;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  /** Full captured output (capped), not just the tail in the result. */
  readonly stdout?: string;
  readonly stderr?: string;
  readonly requests?: readonly { readonly status: number | null }[];
  readonly errors?: readonly string[];
  readonly consoleErrors?: readonly string[];
  readonly missingSelectors?: readonly string[];
  readonly probes?: Readonly<Record<string, readonly (readonly [number, unknown])[]>>;
  readonly games?: VerifyGameSummary;
}

const PROBE_OPS: ReadonlySet<string> = new Set(["decreases", "increases", "equals", "reaches", "stays"]);

/** Split on whitespace, keeping double- or single-quoted runs whole. */
export function tokenizeCheck(spec: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  for (const m of spec.matchAll(re)) {
    const quoted = m[1] ?? m[2];
    tokens.push(quoted === undefined ? m[3]! : quoted.replace(/\\(.)/g, "$1"));
  }
  return tokens;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function outcome(check: string, ok: boolean, detail: string): CheckOutcome {
  return { check, ok, detail };
}

function checkExit(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const [, a, b] = tokens;
  const negated = a === "!=";
  const wanted = Number.parseInt((negated || a === "==" ? b : a) ?? "", 10);
  if (!Number.isInteger(wanted)) return outcome(check, false, "unknown check: expected `exit <code>`");
  if (s.timedOut) return outcome(check, false, "killed (timed out)");
  if (s.exitCode === undefined) return outcome(check, false, `no exit code for a ${s.kind} run`);
  const actual = s.exitCode === null ? "killed by signal" : `exit ${s.exitCode}`;
  const ok = negated ? s.exitCode !== wanted : s.exitCode === wanted;
  return outcome(check, ok, actual);
}

/** `stdout [not] matches /re/flags`: the literal is read from the raw check, spaces and all. */
function checkStreamMatches(check: string, s: CheckSubject): CheckOutcome {
  const m = /^(stdout|stderr)\s+(not\s+)?matches\s+(.*)$/s.exec(check);
  if (m === null) return outcome(check, false, "unknown check: expected `stdout [not] matches /pattern/flags`");
  const stream = m[1] as "stdout" | "stderr";
  const negated = m[2] !== undefined;
  const regex = compileCheckRegex(m[3]!);
  if ("error" in regex) return outcome(check, false, `pattern refused: ${regex.error} (expected \`${stream} [not] matches /pattern/flags\`)`);
  const text = s[stream];
  if (text === undefined) return outcome(check, false, `no ${stream} for a ${s.kind} run`);
  const tested = testCheckRegex(regex, text);
  if ("error" in tested) return outcome(check, false, `pattern not evaluated: ${tested.error}`);
  const shown = `/${regex.source}/${regex.flags}`;
  return outcome(check, negated ? !tested.matched : tested.matched, tested.matched ? `${stream} matches ${show(shown)}` : `${stream} does not match ${show(shown)}`);
}

function checkStream(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const stream = tokens[0] as "stdout" | "stderr";
  const negated = tokens[1] === "not";
  const verb = negated ? tokens[2] : tokens[1];
  if (verb === "matches") return checkStreamMatches(check, s);
  const needle = negated ? tokens[3] : tokens[2];
  if (verb !== "contains" || needle === undefined) {
    return outcome(check, false, `unknown check: expected \`${stream} [not] contains "x"\` or \`${stream} [not] matches /pattern/flags\``);
  }
  const text = s[stream];
  if (text === undefined) return outcome(check, false, `no ${stream} for a ${s.kind} run`);
  const found = text.includes(needle);
  return outcome(check, negated ? !found : found, found ? `${stream} contains ${show(needle)}` : `${stream} does not contain ${show(needle)}`);
}

function checkStatus(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const wanted = Number.parseInt(tokens[1] ?? "", 10);
  if (!Number.isInteger(wanted)) return outcome(check, false, "unknown check: expected `status <code>`");
  if (s.requests === undefined || s.requests.length === 0) return outcome(check, false, "no requests were made");
  const statuses = s.requests.map((r) => r.status ?? "no response");
  const ok = statuses.every((st) => st === wanted);
  return outcome(check, ok, `statuses: ${statuses.join(", ")}`);
}

function checkNoErrors(check: string, s: CheckSubject): CheckOutcome {
  if (s.kind !== "page") return outcome(check, false, "`no errors` applies to page runs");
  const errors = s.errors?.length ?? 0;
  const consoleErrors = s.consoleErrors?.length ?? 0;
  return outcome(check, errors === 0 && consoleErrors === 0, `${errors} uncaught error(s), ${consoleErrors} console error(s)`);
}

function checkMissing(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const wanted = Number.parseInt(tokens[2] ?? "", 10);
  if (tokens[1] !== "selectors" || !Number.isInteger(wanted)) {
    return outcome(check, false, "unknown check: expected `missing selectors <n>`");
  }
  if (s.missingSelectors === undefined) return outcome(check, false, "selector lookups are recorded for page runs only");
  const list = s.missingSelectors;
  return outcome(check, list.length === wanted, list.length === 0 ? "no failed lookups" : `${list.length} failed lookup(s): ${list.slice(0, 5).join(", ")}`);
}

function checkProbe(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const [, name, op, rawValue] = tokens;
  if (name === undefined || op === undefined || !PROBE_OPS.has(op)) {
    return outcome(check, false, "unknown check: expected `probe <name> decreases|increases|equals <v>|reaches <v>|stays <v>`");
  }
  const samples = s.probes?.[name];
  if (samples === undefined) return outcome(check, false, `no probe named ${JSON.stringify(name)}`);
  const values = samples.map(([, v]) => v);
  if (values.length === 0) return outcome(check, false, `probe ${name} has no samples`);
  const first = values[0];
  const last = values[values.length - 1];
  const trend = `${name}: ${show(first)} → ${show(last)} over ${values.length} samples`;
  if (op === "decreases" || op === "increases") {
    if (typeof first !== "number" || typeof last !== "number") return outcome(check, false, `${trend} (not numeric)`);
    return outcome(check, op === "decreases" ? last < first : last > first, trend);
  }
  if (rawValue === undefined) return outcome(check, false, `unknown check: \`probe ${name} ${op}\` needs a value`);
  const wanted = parseValue(rawValue);
  if (op === "equals") return outcome(check, same(last, wanted), `${name} ended at ${show(last)}`);
  if (op === "reaches") {
    const hit = values.findIndex((v) => same(v, wanted));
    return outcome(check, hit !== -1, hit === -1 ? `${name} never reached ${show(wanted)} (${trend})` : `${name} reached ${show(wanted)} at sample ${hit}`);
  }
  if (op === "stays") {
    const off = values.findIndex((v) => !same(v, wanted));
    return outcome(check, off === -1, off === -1 ? `${name} stayed ${show(wanted)}` : `${name} was ${show(values[off])} at sample ${off}`);
  }
  return outcome(check, false, `unknown check: probe op ${show(op)}`);
}

const GAME_SYNTAX = "unknown check: expected `games finish`, `game errors <n>`, `game duration < <ms>`, `game moves < <n>`, `game winner in [a, b]` or `game winners vary`";

function gameLabel(index: number): string {
  return `game ${index + 1}`;
}

/** `winner in [X, "O", none]` → `["X", "O", "none"]`. */
function winnerList(raw: string): string[] | null {
  const m = /^\[(.*)\]$/s.exec(raw.trim());
  if (m === null) return null;
  return m[1]!.split(",").map((w) => w.trim().replace(/^(["'])(.*)\1$/s, "$2")).filter((w) => w.length > 0);
}

function checkGame(check: string, tokens: string[], s: CheckSubject): CheckOutcome {
  const games = s.games;
  const unfinishedDetail = (runs: readonly { index: number; finished: boolean }[]): string =>
    runs.filter((r) => !r.finished).map((r) => gameLabel(r.index)).slice(0, 5).join(", ");
  const form = tokens[0] === "games" && tokens[1] === "finish" && tokens.length === 2 ? "finish"
    : tokens[0] === "game" && tokens[1] === "errors" && tokens.length === 3 && /^\d+$/.test(tokens[2]!) ? "errors"
    : tokens[0] === "game" && (tokens[1] === "duration" || tokens[1] === "moves") && tokens[2] === "<" && tokens.length === 4 && /^\d+(\.\d+)?$/.test(tokens[3]!) ? tokens[1]
    : tokens[0] === "game" && tokens[1] === "winner" && tokens[2] === "in" ? "winner"
    : tokens[0] === "game" && tokens[1] === "winners" && tokens[2] === "vary" && tokens.length === 3 ? "vary"
    : null;
  if (form === null) return outcome(check, false, GAME_SYNTAX);
  if (games === undefined) return outcome(check, false, "no games were played (add `game` to a page run)");
  if (games.missingApi !== undefined) return outcome(check, false, games.missingApi);
  const runs = games.runs;
  const all = `${games.finished} of ${games.n} games finished`;
  switch (form) {
    case "finish":
      return outcome(check, games.finished === games.n && runs.length === games.n, games.finished === games.n ? all : `${all}; not over: ${unfinishedDetail(runs) || "(not started)"}`);
    case "errors": {
      const wanted = Number(tokens[2]);
      const first = runs.flatMap((r) => r.errors.map((e) => `${gameLabel(r.index)}: ${e}`)).slice(0, 3);
      return outcome(check, games.errors === wanted, games.errors === 0 ? "no errors in any game" : `${games.errors} error(s): ${first.join("; ")}`);
    }
    case "duration":
    case "moves": {
      const bound = Number(tokens[3]);
      const value = (r: VerifyGameSummary["runs"][number]): number | null => (form === "duration" ? r.durationMs : r.moves);
      const over = runs.filter((r) => !r.finished || value(r) === null || value(r)! >= bound);
      const values = runs.flatMap((r) => (value(r) === null ? [] : [value(r)!]));
      const longest = values.length === 0 ? null : Math.max(...values);
      const unit = form === "duration" ? " ms" : " moves";
      const stats = form === "duration" ? `longest ${longest ?? "?"} ms, median ${games.medianMs ?? "?"} ms` : `most ${longest ?? "?"} moves, median ${games.medianMoves ?? "?"}`;
      if (runs.length < games.n) return outcome(check, false, `${runs.length} of ${games.n} games played; ${stats}`);
      if (over.length === 0) return outcome(check, true, stats);
      const shown = over.slice(0, 3).map((r) => `${gameLabel(r.index)}: ${r.finished ? `${value(r) ?? "?"}${unit}` : "not finished"}`);
      return outcome(check, false, `${shown.join(", ")} (${stats})`);
    }
    case "winner": {
      const raw = /^game\s+winner\s+in\s+(.*)$/s.exec(check)?.[1] ?? "";
      const allowed = winnerList(raw);
      if (allowed === null || allowed.length === 0) return outcome(check, false, "unknown check: expected `game winner in [a, b, none]`");
      const off = runs.filter((r) => !r.finished || !allowed.includes(r.winner ?? "none"));
      if (runs.length < games.n) return outcome(check, false, `${runs.length} of ${games.n} games played`);
      return outcome(check, off.length === 0, off.length === 0 ? `winners: ${JSON.stringify(games.winners)}` : off.slice(0, 3).map((r) => `${gameLabel(r.index)}: ${r.finished ? (r.winner ?? "none") : "not finished"}`).join(", "));
    }
    case "vary": {
      if (games.n < 3) return outcome(check, false, `\`game winners vary\` needs at least 3 games; ${games.n} asked for`);
      const finished = runs.filter((r) => r.finished);
      const distinct = new Set(finished.map((r) => r.winner ?? "none"));
      if (finished.length < 3) return outcome(check, false, `only ${finished.length} game(s) finished; at least 3 are needed`);
      return outcome(check, distinct.size > 1, distinct.size > 1 ? `winners: ${JSON.stringify(games.winners)}` : `the same winner every game: ${[...distinct][0]}`);
    }
  }
  return outcome(check, false, GAME_SYNTAX);
}

export function evaluateCheck(spec: string, subject: CheckSubject): CheckOutcome {
  const check = spec.trim();
  const tokens = tokenizeCheck(check);
  switch (tokens[0]) {
    case "exit":
      return checkExit(check, tokens, subject);
    case "stdout":
    case "stderr":
      return checkStream(check, tokens, subject);
    case "status":
      return checkStatus(check, tokens, subject);
    case "no":
      return tokens[1] === "errors" && tokens.length === 2 ? checkNoErrors(check, subject) : outcome(check, false, "unknown check");
    case "missing":
      return checkMissing(check, tokens, subject);
    case "probe":
      return checkProbe(check, tokens, subject);
    case "games":
    case "game":
      return checkGame(check, tokens, subject);
    default:
      return outcome(check, false, "unknown check");
  }
}

export function evaluateChecks(
  specs: readonly string[],
  subject: CheckSubject,
): CheckOutcome[] {
  return specs.map((spec) => evaluateCheck(spec, subject));
}
