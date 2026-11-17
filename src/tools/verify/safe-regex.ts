/**
 * The regex policy of the `stdout|stderr [not] matches /re/flags` checks
 * (issue #40).
 *
 * The pattern is model- or brief-written and the subject is up to 1 MB
 * of a program's output, so a backtracking engine is a denial-of-service
 * waiting to happen. Three layers, cheapest first:
 *
 * 1. Shape: a `/source/flags` literal, source at most
 *    `MAX_CHECK_REGEX_CHARS` characters, flags only `i`, `m`, `s`, `u`
 *    (no `g`/`y`: a check is one test, not a scan with state).
 * 2. Refusal of the classic catastrophic shapes: a group repeated by an
 *    unbounded quantifier (`*`, `+`, `{n,}`, `{n,m}`) whose body itself
 *    repeats or alternates (`(a+)+`, `(\w*)*`, `(a|aa)*`), and every
 *    backreference (`\1`, `\k<name>`). Escaped characters and character
 *    classes are skipped, so `([+*|])+` is fine; a `?`-optional group is
 *    bounded and allowed.
 * 3. A time bound: the test runs in a fresh `vm` context with a
 *    `CHECK_REGEX_TIMEOUT_MS` timeout, which interrupts the engine. A
 *    pattern that still runs too long (polynomial ones such as
 *    `\s*\s*\s*x` the shape rule does not see) fails the check with a
 *    reason; it never hangs the run and never passes.
 */
import { createContext, runInContext } from "node:vm";

export const MAX_CHECK_REGEX_CHARS = 256;
export const CHECK_REGEX_TIMEOUT_MS = 200;
const ALLOWED_FLAGS = new Set(["i", "m", "s", "u"]);

export interface CheckRegex {
  readonly source: string;
  readonly flags: string;
}

/** Whether a quantifier starts at `source[i]` and is unbounded (`*`, `+`, `{n,}`, `{n,m}` with m > 1). */
function unboundedQuantifierAt(source: string, i: number): boolean {
  const c = source[i];
  if (c === "*" || c === "+") return true;
  if (c !== "{") return false;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
  if (m === null) return false;
  if (m[2] === undefined) return Number(m[1]) > 1;
  return m[3] === "" || Number(m[3]) > 1;
}

/** Why `source` is refused by the shape rule, or `null`. */
function catastrophicShape(source: string): string | null {
  // Per open group: whether its body (so far) repeats or alternates.
  const stack: { risky: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]!;
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || next === "k")) return "backreferences are not allowed";
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ risky: false });
      continue;
    }
    if (c === ")") {
      const group = stack.pop();
      if (group === undefined) continue;
      if (group.risky && unboundedQuantifierAt(source, i + 1)) {
        return "a repeated group that itself repeats or alternates (nested quantifier) is not allowed";
      }
      // The enclosing group repeats whatever this one does.
      const parent = stack[stack.length - 1];
      if (parent !== undefined && (group.risky || unboundedQuantifierAt(source, i + 1))) parent.risky = true;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined && (c === "|" || unboundedQuantifierAt(source, i))) top.risky = true;
  }
  return null;
}

/** A `/source/flags` literal read and vetted, or why it is refused. */
export function compileCheckRegex(literal: string): CheckRegex | { error: string } {
  const text = literal.trim();
  const end = text.lastIndexOf("/");
  if (!text.startsWith("/") || end <= 0) return { error: "expected a /pattern/flags literal" };
  const source = text.slice(1, end);
  const flags = text.slice(end + 1);
  if (source.length === 0) return { error: "the pattern is empty" };
  if (source.length > MAX_CHECK_REGEX_CHARS) return { error: `the pattern is longer than ${MAX_CHECK_REGEX_CHARS} characters` };
  for (const [i, f] of [...flags].entries()) {
    if (!ALLOWED_FLAGS.has(f)) return { error: `flag ${JSON.stringify(f)} is not allowed (only i, m, s, u)` };
    if (flags.indexOf(f) !== i) return { error: `flag ${JSON.stringify(f)} is repeated` };
  }
  try {
    new RegExp(source, flags);
  } catch (err) {
    return { error: `invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }
  const shape = catastrophicShape(source);
  if (shape !== null) return { error: shape };
  return { source, flags };
}

/** Test `regex` on `subject` under the time bound. */
export function testCheckRegex(
  regex: CheckRegex,
  subject: string,
  timeoutMs = CHECK_REGEX_TIMEOUT_MS,
): { matched: boolean } | { error: string } {
  const sandbox = createContext({ source: regex.source, flags: regex.flags, subject });
  try {
    const matched = runInContext("new RegExp(source, flags).test(subject)", sandbox, { timeout: timeoutMs }) as unknown;
    return { matched: matched === true };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { error: `the pattern ran longer than its ${timeoutMs} ms time bound` };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
