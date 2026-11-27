import { interpreterScript, scriptInput, scriptStream } from "./org-script-operands.js";
import { receivesShellInput, shellSyntax, UNKNOWN_SHELL_WORD, type ShellInput } from "./shell-rule-syntax.js";
import { lexShellLine, type ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import {
  NESTED_SHELL_PROGRAMS,
  busyboxApplet,
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
  flock: ["-w", "-E", "--wait", "--conflict-exit-code"], parallel: ["-j", "-P", "-S", "--jobs", "--sshlogin"], call: [], start: ["/d", "/node", "/affinity"],
};

/**
 * `FOO=1 env -u X sudo -u root nice -n 5 timeout 10 npm publish` →
 * `npm publish`. Each wrapper's value-taking flags (`PREFIX_COMMANDS`,
 * shared with the guard's browser-bypass layer) skip their value too, so
 * `sudo -u root rm` reads as `rm`, not `root`.
 */
function withoutWrappers(input: readonly string[], observe?: (words: string[]) => void, environment?: (assignment: string | null) => void): string[] {
  const words = [...input];
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (ENV_ASSIGNMENT_RE.test(word)) {
      environment?.(word);
      i += 1;
      continue;
    }
    const name = programName(word);
    if (busyboxApplet(words.slice(i)) !== null) { i++; continue; }
    observe?.(words.slice(i));
    const wrapperStart = i;
    const valueFlags = prefixCommandFlags(name);
    if (valueFlags === undefined) break;
    i += 1;
    while (i < words.length) {
      const next = words[i]!;
      if (name === "env" && ENV_ASSIGNMENT_RE.test(next)) {
        environment?.(next);
        i += 1;
        continue;
      }
      // `env -S 'rm -rf x'`: the value is the command line, split on blanks.
      if (name === "env" && /^(?:-S|--split-string)(?:=|.|$)/.test(next)) {
        const separate = next === "-S" || next === "--split-string";
        const value = separate ? words[i + 1] ?? "" : next.startsWith("--split-string=") ? next.slice(15) : next.slice(2);
        const tokens = /[$`\\]/.test(value) ? null : lexShellLine(value, "posix");
        const split = tokens?.every(token => token.kind === "word") ? tokens.map(token => token.kind === "word" ? token.text : "") : [UNKNOWN_SHELL_WORD];
        words.splice(i, separate ? 2 : 1, ...split);
        break;
      }
      if (next === "--") {
        i += 1;
        break;
      }
      if (!next.startsWith("-")) break;
      if (name === "env") {
        if (next === "--ignore-environment" || next === "-i" || next === "-") environment?.(null);
        if (next === "-u" || next === "--unset") environment?.(`${words[i + 1] ?? ""}=`);
        else if (next.startsWith("--unset=")) environment?.(`${next.slice(8)}=`);
        else if (/^-u./.test(next)) environment?.(`${next.slice(2)}=`);
      }
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

/** The literal wrapper chain, using the same option and split-string boundaries. */
export function shellWrapperSegments(words: readonly string[]): string[][] {
  const segments: string[][] = [];
  withoutWrappers(words, segment => segments.push(segment));
  return segments;
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
export function analyzeShellRules(cmd: string, execArgs: readonly string[], useShell: boolean, dialect: ShellDialect = process.platform === "win32" ? "cmd" : "posix", cwd = process.cwd(), hasStdin = false, stdinScript?: string): { segments: string[][]; unreadable: boolean } {
  const syntax = useShell ? shellSyntax([cmd, ...execArgs].join(" "), dialect) : { segments: [[cmd, ...execArgs]], inputs: [], unreadable: false };
  const state = { unreadable: syntax.unreadable, remaining: 2048, cwd, nodeOptions: process.env.NODE_OPTIONS };
  const segments = syntax.segments.flatMap((words, index) => expandSegment(words, 0, state, segmentInput(syntax.inputs[index], { hasStdin, stdinScript })));
  return { segments, unreadable: state.unreadable };
}

export function shellRuleSegments(cmd: string, execArgs: readonly string[], useShell: boolean, dialect?: ShellDialect, cwd = process.cwd()): string[][] {
  return analyzeShellRules(cmd, execArgs, useShell, dialect, cwd).segments;
}

function makeScriptIsOpaque(args: readonly string[], cwd: string): boolean {
  const opaqueFile = (file: string | undefined) => {
    const stream = scriptStream(file, cwd);
    return file === undefined || stream === "stdin" || stream === "unknown";
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const option = arg.slice(2).split("=", 1)[0]!;
      // GNU's unique prefixes: --e is ambiguous (environment-overrides),
      // --ma is ambiguous (max-load); --ev, --f and --mak are unique.
      if (option.length >= 2 && "eval".startsWith(option)) return true;
      if (option.length >= 1 && "file".startsWith(option) || option.length >= 3 && "makefile".startsWith(option)) {
        if (opaqueFile(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i])) return true;
      } else if (["directory", "include-dir", "old-file", "assume-old", "what-if", "new-file", "assume-new"].includes(option) && !arg.includes("=")) i++;
      continue;
    }
    if (!arg.startsWith("-")) continue;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!;
      if (flag === "E") return true;
      if ("CfIoW".includes(flag)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1).replace(/^=/, "") : args[++i];
        if (flag === "f" && opaqueFile(value)) return true;
        break;
      }
      if (flag === "j" || flag === "l") {
        const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(arg.slice(j + 1));
        j += number?.[0].length ?? 0;
      }
    }
  }
  return args.some(arg => /^(?:SHELL|\.SHELLFLAGS)=/.test(arg));
}

interface InputContext { hasStdin: boolean; stdinScript?: string }
function segmentInput(input: ShellInput | undefined, inherited: InputContext): InputContext {
  return receivesShellInput(input) ? { hasStdin: true } : inherited;
}

function expandSegment(words: string[], depth: number, state: { unreadable: boolean; remaining: number; cwd: string; nodeOptions?: string }, input: InputContext): string[][] {
  if (--state.remaining < 0) { state.unreadable = true; return []; }
  let nodeOptions = state.nodeOptions;
  const updateOptions = (assignment: string | null) => {
    if (assignment === null) nodeOptions = undefined;
    else if (assignment.startsWith("NODE_OPTIONS=")) nodeOptions = assignment.slice(13);
  };
  const inner = withoutWrappers(words, undefined, updateOptions);
  if (inner[0]?.includes(UNKNOWN_SHELL_WORD)) state.unreadable = true;
  // These install deferred code or change subsequent command resolution.
  // Never execute the fixture or consult the operator's shell state.
  if (/^(?:trap|hash)$/.test(programName(inner[0] ?? ""))) state.unreadable = true;
  const program = programName(inner[0] ?? "");
  const args = inner.slice(1);
  if (input.hasStdin && input.stdinScript === undefined && readsScriptFromStdin(inner, state.cwd)) state.unreadable = true;
  if (program === "export") {
    for (const assignment of args) updateOptions(assignment);
    state.nodeOptions = nodeOptions;
  } else if (program === "unset" && args.includes("NODE_OPTIONS")) state.nodeOptions = undefined;
  else if (words.every(word => ENV_ASSIGNMENT_RE.test(word))) state.nodeOptions = nodeOptions;
  if (program === "node" && nodeOptions) {
    const tokens = nodeOptions.length <= 128 * 1024 && !nodeOptions.includes(UNKNOWN_SHELL_WORD) ? lexShellLine(nodeOptions, "posix") : null;
    if (tokens === null || tokens.some(token => token.kind !== "word" || token.dynamic)) state.unreadable = true;
    else {
      const optionWords = tokens.map(token => token.kind === "word" ? token.text : "");
      if (["inline", "unknown"].includes(interpreterScript([inner[0]!, ...optionWords, ...args], state.cwd, "organization", input.hasStdin)?.kind ?? "")) state.unreadable = true;
    }
  }
  if (program === "git" && (words.some(word => /^(?:GIT_(?:CONFIG|PAGER|SSH|EDITOR)|GIT_SSH_COMMAND)/.test(word)) || args.some(arg => /^(?:alias\.[^=]+|core\.(?:pager|sshcommand|editor)|sequence\.editor)=/i.test(arg) || /^--(?:paginate|exec-path)(?:=|$)/.test(arg)))) state.unreadable = true;
  if (/^g?make$/.test(program) && makeScriptIsOpaque(args, state.cwd)) state.unreadable = true;
  if (/^(?:vi|[rg]?vim(?:diff)?|[rg]?view|nvim(?:diff)?|nview|evim|eview|ex|gex|gdb)$/.test(program) && !args.some(arg => /^(?:--version|--help)$/.test(arg))) state.unreadable = true;
  if (program === "tar" && (args.some(arg => /^(?:--(?:to-command|checkpoint-action|use-compress-program)(?:=|$)|-I)/.test(arg)) || /^-?[A-Za-z]*I/.test(args[0] ?? ""))) state.unreadable = true;
  if (program === "zip" && args.slice(0, args.indexOf("--") === -1 ? args.length : args.indexOf("--")).some(arg => /^-TT/.test(arg))) state.unreadable = true;
  if (NESTED_SHELL_PROGRAMS.includes(program) && (words.some(word => /^(?:BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS)=/.test(word)) || args.some(arg => /^(?:--rcfile|--init-file)(?:=|$)/.test(arg)))) state.unreadable = true;
  if (["inline", "unknown"].includes(interpreterScript(inner, state.cwd, "organization", input.hasStdin)?.kind ?? "")) state.unreadable = true;
  if (program === "node" && input.hasStdin && scriptInput(inner, state.cwd) === "stdin") state.unreadable = true;
  if (scriptInput(inner, state.cwd) === "unknown" || interpreterScript(inner, state.cwd)?.kind === "file" && scriptInput(inner, state.cwd) === "stdin" || NESTED_SHELL_PROGRAMS.includes(program) && !scanNestedShellOptions(inner.slice(1), program).readsStdin && scriptInput(inner, state.cwd) === "stdin") state.unreadable = true;
  const unwrapped = inner.length > 0 && inner.join("\0") !== words.join("\0");
  const listed = unwrapped ? [words, inner] : [words];
  if (depth >= MAX_NESTED_SHELL_DEPTH) { state.unreadable = true; return listed; }
  const lines = nestedShellScripts(words, state);
  // Analyze supplied shell stdin in its actual visible environment, like -c.
  // Do not feed that same payload recursively to programs inside the body.
  const consumesStdinScript = input.stdinScript !== undefined && NESTED_SHELL_PROGRAMS.includes(program) && scriptInput(inner, state.cwd) === "stdin";
  if (consumesStdinScript) lines.push({ line: input.stdinScript!, dialect: "posix" });
  if (inner.length > 1 && programName(inner[0]!) === "eval") lines.push({ line: inner.slice(1).join(" "), dialect: "posix" });
  const nestedState = { ...state, nodeOptions };
  const nested = lines.flatMap(({ line, dialect }) => {
    if (line.includes(UNKNOWN_SHELL_WORD)) { nestedState.unreadable = true; return []; }
    const syntax = shellSyntax(line, dialect); nestedState.unreadable ||= syntax.unreadable;
    const inherited = consumesStdinScript && line === input.stdinScript ? { hasStdin: input.hasStdin } : input;
    return syntax.segments.flatMap((w, index) => expandSegment(w, depth + 1, nestedState, segmentInput(syntax.inputs[index], inherited)));
  });
  const executed = findExecCommands(inner).flatMap(w => expandSegment(w, depth + 1, nestedState, input));
  state.unreadable ||= nestedState.unreadable;
  state.remaining = nestedState.remaining;
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
    const options = scanNestedShellOptions(inner.slice(1), name);
    if (options.runsCommand && options.scripts.length === 0) state.unreadable = true;
    for (const line of options.scripts) if (line.trim() !== "") scripts.push({ line, dialect: "posix" });
  }
  if (name === "npx" || name === "npm" && inner[1] === "exec") {
    for (let i = name === "npm" ? 2 : 1; i < inner.length; i++) {
      const arg = inner[i]!;
      if (arg === "--" || !arg.startsWith("-")) break;
      if (/^(?:-c|--call)$/.test(arg)) { if (inner[i + 1] !== undefined) scripts.push({ line: inner[i + 1]!, dialect: "posix" }); else state.unreadable = true; break; }
      if (/^(?:-c.|--call=)/.test(arg)) { scripts.push({ line: arg.startsWith("--") ? arg.slice(7) : arg.slice(2), dialect: "posix" }); break; }
      if (/^(?:-p|--package|--prefix|--cache|--userconfig)$/.test(arg)) i++;
    }
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
function readsScriptFromStdin(words: readonly string[], cwd: string): boolean {
  const head = words[0];
  if (head === undefined) return false;
  const name = programName(head);
  const args = words.slice(1);
  if (POWERSHELL_RE.test(name)) return powershellReadsStdin(args);
  return scriptInput(words, cwd) === "stdin";
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
  cwd = process.cwd(),
): boolean {
  return analyzeShellRules(cmd, execArgs, useShell, dialect, cwd).unreadable;
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
  cwd = process.cwd(),
): { lines: string[]; unreadable: boolean } | null {
  if (stdin === undefined || stdin.trim() === "") return null;
  const analysis = analyzeShellRules(cmd, execArgs, useShell, undefined, cwd, true, stdin);
  const segments = analysis.segments;
  const unreadable = analysis.unreadable || segments.some(words => scriptInput(words, cwd) === "unknown");
  const readers = segments.filter(words => readsScriptFromStdin(words, cwd));
  if (readers.length === 0) return unreadable ? { lines: [], unreadable: true } : null;
  const shells = readers.filter((words) => NESTED_SHELL_PROGRAMS.includes(programName(words[0]!)));
  return { lines: shells.length > 0 ? [stdin] : [], unreadable: unreadable || shells.length < readers.length };
}
