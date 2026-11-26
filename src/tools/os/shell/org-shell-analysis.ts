import { interpreterScript } from "./org-script-operands.js";
import { shellSyntax, UNKNOWN_SHELL_WORD } from "./shell-rule-syntax.js";
import type { ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import {
  NESTED_SHELL_PROGRAMS,
  PREFIX_COMMANDS,
  programName,
  scanNestedShellOptions,
} from "../shell-command-guard/command-segments.js";

/**
 * Characters after which a whitespace split of a subshell line is no
 * longer the argv the shell will run: quotes, escapes, globs, `~` and
 * comments. `shellGrantShape` already withholds a shape from lines that
 * sequence, pipe, redirect or substitute.
 */
const SUBSHELL_WORD_CHANGING_RE = /["'\\*?[\]~#!]/;

/**
 * The argv a saved approval rule's `commandPrefix` matches
 * (`ApprovalRequest.commandArgv`), or undefined when there is none to
 * trust.
 *
 * Only where the call has a grant shape (`shellGrantShape`): a simple
 * command whose binary is all that runs. A direct exec passes its argv
 * as is; a subshell line counts only when splitting it on whitespace is
 * exactly what the shell would do with it.
 */
export function shellCommandArgv(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  commandShape: string | undefined,
): string[] | undefined {
  if (commandShape === undefined) return undefined;
  if (!useShell) return [cmd, ...execArgs];
  const line = [cmd, ...execArgs].join(" ");
  if (SUBSHELL_WORD_CHANGING_RE.test(line)) return undefined;
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length > 0 ? tokens : undefined;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The value-taking flags of a command that runs the command after it, or undefined. */
function prefixCommandFlags(name: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(PREFIX_COMMANDS, name)
    ? PREFIX_COMMANDS[name]
    : Object.prototype.hasOwnProperty.call(RULE_WRAPPERS, name) ? RULE_WRAPPERS[name] : undefined;
}

const RULE_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  setsid: [], ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
  chroot: ["--userspec", "--groups"], strace: ["-o", "-e", "-p", "-P", "-u", "-I", "-b", "-s", "--output", "--trace", "--attach"],
  unshare: ["--root", "--wd", "--map-user", "--map-group", "--setuid", "--setgid"],
  flock: ["-w", "-E", "--wait", "--conflict-exit-code"], parallel: ["-j", "-P", "-S", "--jobs", "--sshlogin"], busybox: [], call: [], start: ["/d", "/node", "/affinity"],
};

/**
 * `FOO=1 env -u X sudo -u root nice -n 5 timeout 10 npm publish` →
 * `npm publish`. Each wrapper's value-taking flags (`PREFIX_COMMANDS`,
 * shared with the guard's browser-bypass layer) skip their value too, so
 * `sudo -u root rm` reads as `rm`, not `root`.
 */
function withoutWrappers(input: readonly string[]): string[] {
  const words = [...input];
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (ENV_ASSIGNMENT_RE.test(word)) {
      i += 1;
      continue;
    }
    const name = programName(word);
    const wrapperStart = i;
    const valueFlags = prefixCommandFlags(name);
    if (valueFlags === undefined) break;
    i += 1;
    while (i < words.length) {
      const next = words[i]!;
      if (name === "env" && ENV_ASSIGNMENT_RE.test(next)) {
        i += 1;
        continue;
      }
      // `env -S 'rm -rf x'`: the value is the command line, split on blanks.
      if (name === "env" && (next === "-S" || next === "--split-string")) {
        const split = (words[i + 1] ?? "").split(/\s+/).filter((t) => t.length > 0);
        words.splice(i, 2, ...split);
        break;
      }
      if (next === "--") {
        i += 1;
        break;
      }
      if (!next.startsWith("-")) break;
      i += valueFlags.includes(next) ? 2 : 1;
    }
    if (name === "flock" && words.slice(wrapperStart + 1).some(word => word === "-c" || word === "--command")) return words.slice(wrapperStart);
    if (name === "chroot" || name === "flock") i += 1;
    if (name === "start" && words[i] === "") i++;
    while (name === "start" && /^\//.test(words[i] ?? "")) {
      const flag = words[i]!.toLowerCase(); i += valueFlags.includes(flag) ? 2 : 1;
    }
    // `timeout 5 cmd`: the duration comes first.
    if ((name === "timeout" || name === "gtimeout") && /^\d/.test(words[i] ?? "")) i += 1;
  }
  return words.slice(i);
}

/**
 * How many `bash -c` levels deep a deny rule still looks. A real line
 * nests one or two; the bound only stops a pathological input.
 */
const MAX_NESTED_SHELL_DEPTH = 4;

/**
 * Every simple command a call would run, for saved deny and ask rules
 * (`ApprovalRequest.commandSegments`). Unlike `shellCommandArgv` this is
 * never withheld: a rule that only tightens is safe to apply on a best
 * reading of the line. A wrapped command is listed both ways, so a rule
 * on `sudo` and a rule on what it runs both match. The line a nested
 * shell runs (`bash -c "rm -rf x"`, `sh -lc 'cd x && rm y'`), what
 * `eval` runs and what `find -exec` runs are split the same way and
 * listed after the command itself (ATO-1332).
 */
export function analyzeShellRules(cmd: string, execArgs: readonly string[], useShell: boolean, dialect: ShellDialect = process.platform === "win32" ? "cmd" : "posix"): { segments: string[][]; unreadable: boolean } {
  const syntax = useShell ? shellSyntax([cmd, ...execArgs].join(" "), dialect) : { segments: [[cmd, ...execArgs]], unreadable: false };
  const state = { unreadable: syntax.unreadable, remaining: 2048 };
  if (useShell && /[|<]/.test([cmd, ...execArgs].join(" ")) && syntax.segments.some(words => readsScriptFromStdin(withoutWrappers(words)))) state.unreadable = true;
  const segments = syntax.segments.flatMap(words => expandSegment(words, 0, state));
  return { segments, unreadable: state.unreadable };
}

export function shellRuleSegments(cmd: string, execArgs: readonly string[], useShell: boolean, dialect?: ShellDialect): string[][] {
  return analyzeShellRules(cmd, execArgs, useShell, dialect).segments;
}

function expandSegment(words: string[], depth: number, state: { unreadable: boolean; remaining: number }): string[][] {
  if (--state.remaining < 0) { state.unreadable = true; return []; }
  const inner = withoutWrappers(words);
  if (inner[0]?.includes(UNKNOWN_SHELL_WORD)) state.unreadable = true;
  // These install deferred code or change subsequent command resolution.
  // Never execute the fixture or consult the operator's shell state.
  if (/^(?:trap|hash)$/.test(programName(inner[0] ?? ""))) state.unreadable = true;
  const program = programName(inner[0] ?? "");
  if (["inline", "unknown"].includes(interpreterScript(inner)?.kind ?? "")) state.unreadable = true;
  const unwrapped = inner.length > 0 && inner.join("\0") !== words.join("\0");
  const listed = unwrapped ? [words, inner] : [words];
  if (depth >= MAX_NESTED_SHELL_DEPTH) { state.unreadable = true; return listed; }
  const lines = nestedShellScripts(words, state);
  if (inner.length > 1 && programName(inner[0]!) === "eval") lines.push({ line: inner.slice(1).join(" "), dialect: "posix" });
  const nested = lines.flatMap(({ line, dialect }) => {
    if (line.includes(UNKNOWN_SHELL_WORD)) { state.unreadable = true; return []; }
    const syntax = shellSyntax(line, dialect); state.unreadable ||= syntax.unreadable;
    if (/[|<]/.test(line) && syntax.segments.some(words => readsScriptFromStdin(withoutWrappers(words)))) state.unreadable = true;
    return syntax.segments.flatMap(w => expandSegment(w, depth + 1, state));
  });
  const executed = findExecCommands(inner).flatMap(w => expandSegment(w, depth + 1, state));
  return [...listed, ...nested, ...executed];
}

/**
 * The command lines nested shells in `words` run: `bash -c <line>`
 * anywhere in the segment, so `sudo bash -c`, `nice -n 5 sh -c` and
 * `xargs sh -c` are read too, the way the guard's dangerous layer finds
 * them.
 */
function nestedShellScripts(words: readonly string[], state: { unreadable: boolean }): Array<{ line: string; dialect: ShellDialect }> {
  const scripts: Array<{ line: string; dialect: ShellDialect }> = [];
  const inner = withoutWrappers(words), name = programName(inner[0] ?? "");
  if (NESTED_SHELL_PROGRAMS.includes(name)) {
    for (const line of scanNestedShellOptions(inner.slice(1), name).scripts) if (line.trim() !== "") scripts.push({ line, dialect: "posix" });
  }
  if (name === "cmd") {
    const index = inner.findIndex((word, i) => i > 0 && /^\/[ck]$/i.test(word));
    if (index !== -1) scripts.push({ line: inner.slice(index + 1).join(" "), dialect: "cmd" });
    else state.unreadable = true;
  }
  if (/^(?:pwsh|powershell)$/.test(name)) {
    if (!inner.some(word => /^-(?:noprofile|nop)$/i.test(word))) state.unreadable = true;
    const index = inner.findIndex((word, i) => i > 0 && /^-(?:c|command)$/i.test(word));
    if (index !== -1 && inner[index + 1] !== "-") scripts.push({ line: inner.slice(index + 1).join(" "), dialect: "powershell" });
    else state.unreadable = true;
  }
  if (name === "script" || name === "su" || name === "flock") {
    const index = inner.findIndex((word, i) => i > 0 && /^(?:-c|--command)$/.test(word));
    if (index !== -1 && inner[index + 1] !== undefined) scripts.push({ line: inner[index + 1]!, dialect: "posix" });
    else if (name === "su" || name === "script") state.unreadable = true;
  }
  return scripts;
}

/** `find . -exec rm {} \;`: the words after each `-exec` are a command. */
function findExecCommands(words: readonly string[]): string[][] {
  if (words.length === 0 || programName(words[0]!) !== "find") return [];
  const commands: string[][] = [];
  for (let i = 1; i < words.length; i += 1) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[i]!)) continue;
    const end = words.findIndex((w, k) => k > i && (w === ";" || w === "+"));
    const command = words.slice(i + 1, end === -1 ? undefined : end);
    if (command.length > 0) commands.push(command);
    if (end === -1) break;
    i = end;
  }
  return commands;
}

/** Interpreters that, with no script of their own, run what comes on stdin. */
const STDIN_INTERPRETER_RE = /^(?:python\d*(?:\.\d+)?|node|ruby|perl|php|osascript)$/;
/** `python3 -c`, `-m`, `node -e` / `-p`, `perl -E`, `php -r`: the code is on the line. */
const INLINE_CODE_FLAG_RE = /^-[A-Za-z]*[cemrEp]|^--(?:eval|print)(?:=|$)/;

/** PowerShell: `-Command -`, `-File -`, a bare `-`, or no script at all reads stdin. */
const POWERSHELL_RE = /^(?:pwsh|powershell)(?:\.exe)?$/i;
const POWERSHELL_SCRIPT_FLAG_RE = /^-(?:c|command|f|file|e|ec|encodedcommand)$/i;
const POWERSHELL_VALUE_FLAG_RE = /^-(?:ep|executionpolicy|wd|workingdirectory|of|outputformat|if|inputformat|wsf|windowstyle|config|configurationname|settingsfile)$/i;

function powershellReadsStdin(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!;
    if (word === "-") return true;
    if (POWERSHELL_SCRIPT_FLAG_RE.test(word)) return args[i + 1] === undefined || args[i + 1] === "-";
    if (POWERSHELL_VALUE_FLAG_RE.test(word)) {
      i += 1;
      continue;
    }
    if (!word.startsWith("-")) return false;
  }
  return true;
}

/** Whether this command runs a script read from stdin rather than one on the line. */
function readsScriptFromStdin(words: readonly string[]): boolean {
  const head = words[0];
  if (head === undefined) return false;
  const name = programName(head);
  const args = words.slice(1);
  if (NESTED_SHELL_PROGRAMS.includes(name)) {
    return scanNestedShellOptions(args, name).readsStdin;
  }
  if (POWERSHELL_RE.test(name)) return powershellReadsStdin(args);
  if (!STDIN_INTERPRETER_RE.test(name)) return false;
  if (args.some((a) => INLINE_CODE_FLAG_RE.test(a))) return false;
  const operand = args.find((a) => a === "-" || !a.startsWith("-"));
  return operand === undefined || operand === "-";
}

/**
 * Whether the call runs code no shell rule can read, including inline
 * non-shell interpreters, deferred definitions and indeterminate programs
 * (`ApprovalRequest.commandUnreadable`), or a shell/interpreter with
 * no script of its own, on a subshell line that feeds it through a pipe,
 * a redirect or a heredoc (`printf 'rm -rf x' | sh`, `sh < run.sh`,
 * `curl … | python3`). The command has no stdin otherwise, so a bare
 * `sh` run directly is not one.
 */
export function shellRunsUnreadableScript(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  dialect?: ShellDialect,
): boolean {
  return analyzeShellRules(cmd, execArgs, useShell, dialect).unreadable;
}

/**
 * What a `stdin` given to a command runs, when the command reads its
 * script from stdin (`verify.run` with `stdin`): a shell (`sh`, `bash -s`)
 * runs it as a command line, so it is returned as one (`lines`) for the
 * guard, egress and read checks to read like an `os.shell.run` line;
 * any other interpreter (`python3`, `node`, `pwsh -`) runs code no rule
 * can read (`unreadable`). `null` for plain data to a command that runs
 * its own script.
 */
export function stdinScriptOf(
  cmd: string,
  execArgs: readonly string[],
  useShell: boolean,
  stdin: string | undefined,
): { lines: string[]; unreadable: boolean } | null {
  if (stdin === undefined || stdin.trim() === "") return null;
  const readers = shellRuleSegments(cmd, execArgs, useShell).filter(readsScriptFromStdin);
  if (readers.length === 0) return null;
  const shells = readers.filter((words) => NESTED_SHELL_PROGRAMS.includes(programName(words[0]!)));
  return { lines: shells.length > 0 ? [stdin] : [], unreadable: shells.length < readers.length || shells.length > 0 && analyzeShellRules(stdin, [], true, "posix").unreadable };
}
