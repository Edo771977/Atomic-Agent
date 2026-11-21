/**
 * Contract checks that cannot fail (issue #110).
 *
 * A contract's `checks` and its provides' `example.expect` are written
 * by the director. Approving a check says the command MAY run; nothing
 * said it CAN FAIL. A check that passes whatever the workers wrote is a
 * green that feeds the criteria facts (`criteria-facts.ts`) and the
 * "only green tasks" delivery, so it is worse than no check.
 *
 * This is a static reading of the contract, before anything runs: it
 * never executes a command, loads a file or evaluates an expression. It
 * reads the spec the way a reviewer would and sorts what it finds:
 *
 *  - `severe`: provably cannot fail without running anything. The
 *    command only prints fixed text (`echo`, `printf`, `Write-Output`,
 *    `node -e` / `python -c` printing literals, `true`, `exit 0`, the
 *    same behind `cmd /c`, `sh -c`, `powershell -Command`) and that text
 *    satisfies the check's own assertions; or an example `expect` that
 *    does not read anything (`true`, `1 === 1`), is a tautology
 *    (`r === r`) or ends in `|| true`. The call is refused with the
 *    reason. Conservative on purpose: a pipe, a redirect, a variable, a
 *    glob, a command substitution, a file that is run, or any code that
 *    is not a literal print is never severe.
 *  - `warning`: the check can fail, but may also pass on the wrong
 *    thing. An output assertion that the usual failure output also
 *    satisfies (`stdout contains "passed"` accepts "0 passed", `ok`
 *    accepts "not ok 1"); a check that only asserts absences (`stdout
 *    not contains "Error"`, `no errors`), which passes on a wrong file or
 *    path; an example `expect` that only checks that the call returned
 *    something (`r !== undefined`). A criterion that only checks with a
 *    warning support is "verified with reservations" (`criteria-facts.ts`).
 *  - `hint`: worth a look, never a reservation. A number the check
 *    expects that its own command line or stdin already contains: the
 *    check may echo the answer it is meant to measure. A number copied
 *    from the brief is NOT a hint on its own: the brief's examples are
 *    legitimate expected outputs (the CSV e2e's `{"X":0}`).
 *
 * A check that declares it expects a failure (`exit != 0`, `exit 1`)
 * observes an error on purpose, so error phrases in its expectations
 * are what it is for and raise nothing. A visual check (`judge:
 * "vision"`) is proved by its screenshot, not by its assertions.
 *
 * Out of scope: real shell parsing and what the files a check runs do.
 */

import { compileCheckRegex, testCheckRegex } from "../verify/safe-regex.js";
import { evaluateChecks, tokenizeCheck, type CheckSubject } from "../verify/verify-checks.js";
import type { ContractCheck, DelegateContract } from "./contract.js";

export type CheckLintSeverity = "severe" | "warning" | "hint";

export type CheckLintRule =
  | "fixed-output"
  | "constant-example"
  | "error-output-match"
  | "absence-only"
  | "existence-only-example"
  | "echoed-number";

export interface CheckLintFinding {
  rule: CheckLintRule;
  severity: CheckLintSeverity;
  /** The field it is about: `contract.checks[0]`, `contract.provides[2].example.expect`. */
  where: string;
  /** Index into `contract.checks`, for a check's finding. */
  checkIndex?: number;
  /** One sentence the director can act on. */
  message: string;
}

/** Output a failing or empty run commonly prints: an expectation it satisfies proves little. */
export const ERROR_OUTPUT_SAMPLES: readonly string[] = [
  "0 passed",
  "0 tests passed",
  "passed: 0",
  "# pass 0",
  "# fail 1",
  "not ok 1 - test",
  "1 failed",
  "FAILED",
  "Failed",
  "failed",
  "Error: Cannot find module './index.js'",
  "error",
  "ERROR",
  "TypeError: x is not a function",
  "Traceback (most recent call last):",
  "not found",
  "sh: 1: node: not found",
  "command not found",
  "No such file or directory",
  "ENOENT: no such file or directory",
  "SyntaxError: Unexpected token",
];

// ------------------------------------------------------------ fixed output

/** What a command prints, when it is a fixed print. */
interface FixedOutput {
  stdout: string;
}

/** Characters a shell gives a meaning to outside quotes: never severe through them. */
const SHELL_META = /[|&;<>()$`*?[\]{}~!#\\]/;

/**
 * A one-line command split into words, the way a plain shell would for
 * plain input: single and double quotes kept whole. Null for anything a
 * shell could expand or redirect (a metacharacter outside quotes, `$`
 * or a backtick inside double quotes) or an unterminated quote.
 */
export function splitPlainCommand(line: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      current += line.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) return null;
      const inner = line.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return null;
      current += inner;
      inWord = true;
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    if (SHELL_META.test(ch)) return null;
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}

/** `node`, `/usr/bin/node`, `NODE.EXE` → `node`. */
function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** A JS string, number or keyword literal at `at`, or null. */
function readJsLiteral(code: string, at: number): { value: string; end: number } | null {
  const ch = code[at];
  if (ch === "'" || ch === '"' || ch === "`") {
    let out = "";
    for (let i = at + 1; i < code.length; i += 1) {
      const c = code[i]!;
      if (c === ch) return { value: out, end: i + 1 };
      if (ch === "`" && c === "$" && code[i + 1] === "{") return null;
      if (c === "\\") {
        const next = code[i + 1];
        const escapes: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"', "`": "`" };
        if (next === undefined || escapes[next] === undefined) return null;
        out += escapes[next];
        i += 1;
        continue;
      }
      if (c === "\n" && ch !== "`") return null;
      out += c;
    }
    return null;
  }
  const number = /^-?\d+(?:\.\d+)?/.exec(code.slice(at));
  if (number !== null) return { value: String(Number(number[0])), end: at + number[0].length };
  const keyword = /^(?:true|false|null)\b/.exec(code.slice(at));
  if (keyword !== null) return { value: keyword[0], end: at + keyword[0].length };
  return null;
}

function skipSpace(code: string, at: number): number {
  while (at < code.length && /\s/.test(code[at]!)) at += 1;
  return at;
}

/**
 * Literal arguments of a call whose name was just read, up to its `)`:
 * `('ok', 3)` → `["ok", "3"]`. Null for anything that is not a literal.
 */
function readLiteralArgs(code: string, at: number): { values: string[]; end: number } | null {
  let i = skipSpace(code, at);
  if (code[i] !== "(") return null;
  i = skipSpace(code, i + 1);
  const values: string[] = [];
  if (code[i] === ")") return { values, end: i + 1 };
  for (;;) {
    const literal = readJsLiteral(code, i);
    if (literal === null) return null;
    values.push(literal.value);
    i = skipSpace(code, literal.end);
    if (code[i] === ",") {
      i = skipSpace(code, i + 1);
      continue;
    }
    if (code[i] === ")") return { values, end: i + 1 };
    return null;
  }
}

/**
 * What `node -e <code>` prints when the code is nothing but literal
 * prints (`console.log('ok')`, `process.stdout.write("done")`) and an
 * optional `process.exit(0)`; null for any other code.
 */
function fixedJsPrints(code: string): FixedOutput | null {
  let stdout = "";
  let i = 0;
  let printed = false;
  for (;;) {
    i = skipSpace(code, i);
    while (code[i] === ";") i = skipSpace(code, i + 1);
    if (i >= code.length) break;
    const rest = code.slice(i);
    const call = /^(console\.(?:log|info)|process\.stdout\.write|process\.exit)\b/.exec(rest);
    if (call === null) return null;
    const args = readLiteralArgs(code, i + call[0].length);
    if (args === null) return null;
    if (call[1] === "process.exit") {
      if (!(args.values.length === 0 || (args.values.length === 1 && args.values[0] === "0"))) return null;
      i = args.end;
      break;
    }
    if (call[1] === "process.stdout.write") {
      if (args.values.length !== 1) return null;
      stdout += args.values[0];
    } else {
      stdout += `${args.values.join(" ")}\n`;
    }
    printed = true;
    i = args.end;
  }
  i = skipSpace(code, i);
  while (code[i] === ";") i = skipSpace(code, i + 1);
  if (i < code.length) return null;
  return printed || code.trim().length > 0 ? { stdout } : null;
}

/** `python -c "print('ok')"`: literal prints only, `;` or newlines between. */
function fixedPythonPrints(code: string): FixedOutput | null {
  let stdout = "";
  let i = 0;
  let printed = false;
  for (;;) {
    i = skipSpace(code, i);
    while (code[i] === ";") i = skipSpace(code, i + 1);
    if (i >= code.length) break;
    if (!code.slice(i).startsWith("print")) return null;
    const args = readLiteralArgs(code, i + "print".length);
    if (args === null) return null;
    stdout += `${args.values.join(" ")}\n`;
    printed = true;
    i = args.end;
  }
  return printed ? { stdout } : null;
}

/** `printf` with a format and no arguments: `%%` and the common escapes only. */
function fixedPrintf(format: string): string | null {
  if (/%(?!%)/.test(format)) return null;
  let out = "";
  for (let i = 0; i < format.length; i += 1) {
    const c = format[i]!;
    if (c === "%") {
      out += "%";
      i += 1;
      continue;
    }
    if (c === "\\") {
      const next = format[i + 1];
      const escapes: Record<string, string> = { n: "\n", t: "\t", "\\": "\\" };
      if (next === undefined || escapes[next] === undefined) return null;
      out += escapes[next];
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

const POWERSHELL_FLAGS = new Set(["-noprofile", "-nop", "-noninteractive", "-nologo"]);

/**
 * What `words` print, when the command is a fixed print and exits 0.
 * Null for everything else — including every command that runs a file
 * or reads anything — so a null is never a finding.
 */
export function fixedOutputOf(words: readonly string[], depth = 0): FixedOutput | null {
  if (words.length === 0 || depth > 3) return null;
  const [head, ...rest] = words;
  const program = programName(head!);
  switch (program) {
    case "echo": {
      let args = rest;
      let newline = true;
      if (args[0] === "-n") {
        newline = false;
        args = args.slice(1);
      }
      if (args[0] === "-e" || args[0] === "-E") return null;
      return { stdout: `${args.join(" ")}${newline ? "\n" : ""}` };
    }
    case "printf": {
      if (rest.length !== 1) return null;
      const out = fixedPrintf(rest[0]!);
      return out === null ? null : { stdout: out };
    }
    case "write-output":
    case "write-host":
      return { stdout: rest.map((w) => `${w}\n`).join("") };
    case "true":
    case ":":
      return rest.length === 0 ? { stdout: "" } : null;
    case "exit":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "0") ? { stdout: "" } : null;
    case "cmd": {
      if (rest.length < 2 || !/^\/[ck]$/i.test(rest[0]!)) return null;
      const inner = rest.length === 2 ? splitPlainCommand(rest[1]!) : rest.slice(1);
      return inner === null ? null : fixedOutputOf(inner, depth + 1);
    }
    case "sh":
    case "bash":
    case "dash":
    case "zsh": {
      if (rest.length !== 2 || rest[0] !== "-c") return null;
      const inner = splitPlainCommand(rest[1]!);
      return inner === null ? null : fixedOutputOf(inner, depth + 1);
    }
    case "powershell":
    case "pwsh": {
      let i = 0;
      while (i < rest.length && POWERSHELL_FLAGS.has(rest[i]!.toLowerCase())) i += 1;
      const flag = rest[i]?.toLowerCase();
      if (flag !== "-command" && flag !== "-c") return null;
      const body = rest.slice(i + 1);
      if (body.length === 0) return null;
      const inner = body.length === 1 ? splitPlainCommand(body[0]!) : body;
      return inner === null ? null : fixedOutputOf(inner, depth + 1);
    }
    case "node": {
      if (rest.length !== 2) return null;
      const [flag, code] = rest as [string, string];
      if (flag === "-e" || flag === "--eval") return fixedJsPrints(code);
      if (flag === "-p" || flag === "--print") {
        const literal = readJsLiteral(code.trim(), 0);
        return literal !== null && literal.end === code.trim().length ? { stdout: `${literal.value}\n` } : null;
      }
      return null;
    }
    case "python":
    case "python3":
    case "py": {
      if (rest.length !== 2 || rest[0] !== "-c") return null;
      return fixedPythonPrints(rest[1]!);
    }
    default:
      return null;
  }
}

/** A command check's words: `cmd` + `args`, or the one line split; null when unreadable. */
function commandWords(check: ContractCheck): string[] | null {
  const raw = typeof check.cmd === "string" ? check.cmd : typeof check.command === "string" ? check.command : undefined;
  if (raw === undefined || raw.trim().length === 0) return null;
  const args = check.args;
  if (args !== undefined && args !== null) {
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
    if (args.length > 0) {
      // `cmd: "node -e", args: [...]` is neither spelling: not read.
      if (/\s/.test(raw.trim())) return null;
      return [raw.trim(), ...(args as string[])];
    }
  }
  return splitPlainCommand(raw.trim());
}

function checkKind(check: ContractCheck): string {
  const kind = check.kind ?? check.type;
  return typeof kind === "string" ? kind : "command";
}

function assertionsOf(check: ContractCheck): string[] {
  return Array.isArray(check.checks) ? check.checks.filter((c): c is string => typeof c === "string") : [];
}

/** Whether the check declares it expects the command to fail: `exit != 0`, `exit 1`. */
export function expectsFailure(check: ContractCheck): boolean {
  return assertionsOf(check).some((spec) => {
    const tokens = tokenizeCheck(spec.trim());
    if (tokens[0] !== "exit") return false;
    if (tokens[1] === "!=") return tokens[2] === "0";
    const code = tokens[1] === "==" ? tokens[2] : tokens[1];
    return code !== undefined && /^\d+$/.test(code) && Number(code) !== 0;
  });
}

function show(text: string, cap = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat);
}

function fixedOutputFinding(check: ContractCheck, where: string, index: number): CheckLintFinding | null {
  if (checkKind(check) !== "command") return null;
  const words = commandWords(check);
  if (words === null) return null;
  const fixed = fixedOutputOf(words);
  if (fixed === null) return null;
  const subject: CheckSubject = { kind: "command", exitCode: 0, timedOut: false, stdout: fixed.stdout, stderr: "" };
  const assertions = assertionsOf(check);
  if (!evaluateChecks(assertions, subject).every((o) => o.ok)) return null;
  const line = words.join(" ");
  return {
    rule: "fixed-output",
    severity: "severe",
    where,
    checkIndex: index,
    message: `cannot fail: \`${line.length > 80 ? `${line.slice(0, 79)}…` : line}\` only prints fixed text (${show(fixed.stdout)}) that its own checks accept, whatever the tasks wrote; run what the tasks produce (the program on an input, its tests) and assert on what that prints`,
  };
}

// ------------------------------------------------------- weak assertions

/** A positive output assertion's needle and how to test a sample with it. */
function positiveOutputAssertions(spec: string): Array<{ text: string; test: (sample: string) => boolean }> {
  const check = spec.trim();
  const tokens = tokenizeCheck(check);
  if (tokens[0] !== "stdout" && tokens[0] !== "stderr") return [];
  if (tokens[1] === "not") return [];
  if (tokens[1] === "contains" && tokens[2] !== undefined) {
    const needle = tokens[2];
    return [{ text: `${tokens[0]} contains ${JSON.stringify(needle)}`, test: (sample) => sample.includes(needle) }];
  }
  if (tokens[1] === "matches") {
    const m = /^(?:stdout|stderr)\s+matches\s+(.*)$/s.exec(check);
    if (m === null) return [];
    const regex = compileCheckRegex(m[1]!);
    if ("error" in regex) return [];
    return [{
      text: `${tokens[0]} matches /${regex.source}/${regex.flags}`,
      test: (sample) => {
        const tested = testCheckRegex(regex, sample);
        return !("error" in tested) && tested.matched;
      },
    }];
  }
  return [];
}

function errorOutputFindings(check: ContractCheck, where: string, index: number): CheckLintFinding[] {
  if (expectsFailure(check)) return [];
  const out: CheckLintFinding[] = [];
  for (const spec of assertionsOf(check)) {
    for (const assertion of positiveOutputAssertions(spec)) {
      const sample = ERROR_OUTPUT_SAMPLES.find((s) => assertion.test(s));
      if (sample === undefined) continue;
      out.push({
        rule: "error-output-match",
        severity: "warning",
        where,
        checkIndex: index,
        message: `\`${assertion.text}\` also accepts failure output such as ${JSON.stringify(sample)}; assert on what only a correct run prints (an exact value, a count above zero), or add \`exit 0\` and a \`not contains\` for the failure`,
      });
    }
  }
  return out;
}

/** An assertion that only says something is absent. */
function isAbsence(spec: string): boolean {
  const tokens = tokenizeCheck(spec.trim());
  if ((tokens[0] === "stdout" || tokens[0] === "stderr") && tokens[1] === "not") return true;
  if (tokens[0] === "no" && tokens[1] === "errors") return true;
  if (tokens[0] === "missing" && tokens[1] === "selectors" && tokens[2] === "0") return true;
  if (tokens[0] === "game" && tokens[1] === "errors" && tokens[2] === "0") return true;
  return false;
}

function absenceFinding(check: ContractCheck, where: string, index: number): CheckLintFinding | null {
  // A visual check's proof is its screenshot, judged against its criteria.
  if (check.judge === "vision") return null;
  const assertions = assertionsOf(check);
  if (assertions.length === 0 || !assertions.every(isAbsence)) return null;
  return {
    rule: "absence-only",
    severity: "warning",
    where,
    checkIndex: index,
    message: `only asserts absences (${assertions.map((a) => `\`${a}\``).join(", ")}), which also pass on a wrong file, path or page; add one assertion of what a correct run shows`,
  };
}

/** Numbers of two digits or more, as they appear. */
function numbersIn(text: string): string[] {
  return [...new Set(text.match(/\d{2,}(?:\.\d+)?/g) ?? [])];
}

function echoedNumberFinding(check: ContractCheck, where: string, index: number): CheckLintFinding | null {
  if (checkKind(check) !== "command") return null;
  const input = [
    typeof check.cmd === "string" ? check.cmd : "",
    typeof check.command === "string" ? check.command : "",
    ...(Array.isArray(check.args) ? check.args.filter((a): a is string => typeof a === "string") : []),
    typeof check.stdin === "string" ? check.stdin : "",
  ].join("\n");
  for (const spec of assertionsOf(check)) {
    const tokens = tokenizeCheck(spec.trim());
    if ((tokens[0] !== "stdout" && tokens[0] !== "stderr") || tokens[1] !== "contains" || tokens[2] === undefined) continue;
    const echoed = numbersIn(tokens[2]).find((n) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d.])`).test(input));
    if (echoed === undefined) continue;
    return {
      rule: "echoed-number",
      severity: "hint",
      where,
      checkIndex: index,
      message: `expects ${echoed}, which its own command or stdin already contains: make sure the output is computed by the tasks' code, not echoed from the input`,
    };
  }
  return null;
}

/** Every finding for one check. */
export function lintContractCheck(check: ContractCheck, index: number): CheckLintFinding[] {
  const where = `contract.checks[${index}]`;
  const fixed = fixedOutputFinding(check, where, index);
  // A check that cannot fail needs nothing more said about it.
  if (fixed !== null) return [fixed];
  return [
    ...errorOutputFindings(check, where, index),
    ...[absenceFinding(check, where, index), echoedNumberFinding(check, where, index)].filter((f): f is CheckLintFinding => f !== null),
  ];
}

// ---------------------------------------------------------------- examples

/** Words of an expression that are not names of anything: literals and operators. */
const LITERAL_WORDS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "void", "typeof", "in", "instanceof"]);

/** The expression with its string literals replaced by `0`. */
function withoutStrings(code: string): string {
  return code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`/g, "0");
}

/** Outer parentheses off: `((r))` → `r`. */
function unwrap(code: string): string {
  let text = code.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      if (depth === 0 && i < text.length - 1) {
        closesAtEnd = false;
        break;
      }
    }
    if (!closesAtEnd) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** One finding for an example's `expect`, or null. */
export function lintExampleExpect(expect: string, where: string): CheckLintFinding | null {
  const code = unwrap(expect);
  const bare = withoutStrings(code);
  const names = (bare.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((w) => !LITERAL_WORDS.has(w));
  const tautology = /^([A-Za-z_$][\w$.]*)\s*={2,3}\s*\1$/.test(code);
  const orTrue = !bare.includes("?") && (/\|\|\s*\(*\s*(?:true|!0|!false|1)\s*\)*\s*$/.test(bare) || /^\(*\s*(?:true|!0|!false|1)\s*\)*\s*\|\|/.test(bare));
  if (names.length === 0 || tautology || orTrue) {
    return {
      rule: "constant-example",
      severity: "severe",
      where,
      message: `is always ${names.length === 0 ? "the same whatever the call returns" : "true"} (\`${expect}\`): write a condition over the result \`r\` that a wrong result fails, e.g. \`r === 5\` or \`r.length === 8\``,
    };
  }
  if (/^(?:r\s*!==?\s*(?:undefined|null)|(?:undefined|null)\s*!==?\s*r|typeof\s+r\s*!==?\s*(?:"undefined"|'undefined')|!!\s*r|r)$/.test(code)) {
    return {
      rule: "existence-only-example",
      severity: "warning",
      where,
      message: `\`${expect}\` only checks that the call returned something, which a wrong result also does; compare \`r\` with the value or shape the provide promises`,
    };
  }
  return null;
}

/**
 * Every finding of the contract: its checks in order, then its provides'
 * examples. Pure and static — nothing is run.
 */
export function lintContract(contract: DelegateContract): CheckLintFinding[] {
  const checks = (contract.checks ?? []).flatMap((check, index) => lintContractCheck(check, index));
  const examples = (contract.provides ?? []).flatMap((provide, index) => {
    if (provide.example === undefined) return [];
    const finding = lintExampleExpect(provide.example.expect, `contract.provides[${index}].example.expect`);
    return finding === null ? [] : [finding];
  });
  return [...checks, ...examples];
}

/** The refusal line of a severe finding. */
export function describeSevereFinding(finding: CheckLintFinding): string {
  return `${finding.where} ${finding.message}`;
}

/** The contract warning line of a non-severe finding (`contract:` line, worker blocks). */
export function describeLintWarning(finding: CheckLintFinding): string {
  return `check lint (${finding.severity}): ${finding.where} ${finding.message}`;
}

/**
 * The checks whose passing proves less than it says, by index into
 * `contract.checks`: one line per check, from its `warning` findings
 * only (a hint is never a reservation). A criterion whose passing checks
 * all have one is "verified with reservations".
 */
export function checkReservations(contract: DelegateContract | undefined): Map<number, string> {
  const out = new Map<number, string>();
  (contract?.checks ?? []).forEach((check, index) => {
    const warnings = lintContractCheck(check, index).filter((f) => f.severity === "warning");
    if (warnings.length > 0) out.set(index, warnings.map((f) => f.message).join("; "));
  });
  return out;
}

/**
 * The hint for task checks that name no criterion while the approved
 * brief has some: their pass proves no criterion. One line, or null.
 */
export function checksWithoutCriteriaHint(contract: DelegateContract | undefined, briefCriteria: number): string | null {
  if (briefCriteria === 0) return null;
  const bare = (contract?.checks ?? []).flatMap((check, index) =>
    check.task !== undefined && (check.criteria ?? []).length === 0 && check.judge === undefined ? [index] : []);
  if (bare.length === 0) return null;
  const list = bare.map((i) => `contract.checks[${i}]`).join(", ");
  return `check lint (hint): ${list} name${bare.length === 1 ? "s" : ""} no success criterion while the approved brief has ${briefCriteria}; a pass there proves no criterion — add \`criteria\` where the check verifies one`;
}
