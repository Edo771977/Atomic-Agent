import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { expandHome, resolveUserPath } from "../expand-home.js";
import { liftSubstitutions, PRINTED_PLACEHOLDER } from "./command-substitution.js";
import { basenameCommand } from "./normalise.js";
import {
  lexShellLine,
  type ShellDialect,
  type ShellWord,
} from "./shell-line-lexer.js";

/**
 * The files a shell command line would change, as far as its words say:
 * redirect targets (`> f`, `>> f`, `2> f`, `&> f`, `tee f`), what a
 * remove/create/move command names (`rm`, `touch`, `truncate`, `mv`, …),
 * the destination of a copy (`cp a f`, `ln`, `rsync`, …), an in-place
 * `sed -i` / `perl -i`, and `dd of=f`. A nested `sh -c "<line>"` is read
 * as the line it runs, and `cd d &&` moves the directory the rest of the
 * line resolves against (not past the `)` of a `( … )` subshell).
 *
 * For the approval gate's same-turn rule (`ApprovalRequest.targetPaths`):
 * after the user declined a write of a file, a command that writes it by
 * another route is refused without asking again. A false refusal is the
 * worse mistake, so this names too little rather than too much: the line
 * is lexed as its shell would (`shell-line-lexer.ts`), so a quoted `"a|rm
 * b"` or `"<title>"` is one argument and a heredoc body is not a command;
 * a path built at runtime (`$(…)`, a glob, a variable other than `$HOME`)
 * or a write hidden inside an interpreter (`python -c "open(…)"`) is not
 * named; and a line the lexer cannot read names nothing at all. Either
 * way that command simply asks the user, as before. Windows verbs (`del`,
 * `move`, `Set-Content`, …) count only on Windows or inside a `cmd /c` /
 * PowerShell line.
 */
/** Extra findings for callers protecting trust paths. The returned paths stay
 * suitable for the narrower same-turn write-denial check. */
export interface WriteTargetScope {
  assignments?: Map<string, Set<string>>;
  home?: string;
  recursive: string[];
  placed: string[];
  removals?: string[];
  skipRemovals?: (program: string, argv: string[], cwd: string) => boolean;
}

export function shellWriteTargets(commandLine: string, cwd: string, scope?: WriteTargetScope): string[] {
  const windows = process.platform === "win32";
  const targets = lineTargets(commandLine, cwd, windows ? "cmd" : "posix", windows, scope);
  return targets === null ? [] : unique(targets);
}

/**
 * `shellWriteTargets` for a direct exec (`spawn(cmd, args)`, no shell):
 * the argv is already split, so `>` or `;` inside an argument is text
 * and an argument with spaces is one word. Only a shell run with a
 * command line of its own (`sh -c "<line>"`, `cmd /c …`) has that line
 * read as one.
 */
export function execWriteTargets(
  cmd: string,
  args: readonly string[],
  cwd: string,
  scope?: WriteTargetScope,
): string[] {
  const words = [cmd, ...args].map((text) => ({ text, dynamic: false }));
  const found = commandTargets(words, cwd, process.platform === "win32", scope);
  return found === null ? [] : unique(found.targets);
}

/** Shells whose `-c` argument is itself a command line. */
const NESTED_SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

/** Words that run the command after them (`sudo rm f`, `env A=1 tee f`). */
const PREFIX_COMMANDS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "nohup",
  "nice",
  "time",
  "timeout",
  "stdbuf",
  "xargs",
  "busybox",
  "setsid",
]);

/** Short options with operands and their long spellings for command launchers. */
const LAUNCHER_VALUES: Readonly<Record<string, { short: string; long: readonly string[] }>> = {
  env: { short: "uCSa", long: ["--unset", "--chdir", "--split-string", "--argv0"] },
  sudo: { short: "ugprhCDRT", long: ["--user", "--group", "--prompt", "--role", "--host", "--chdir", "--chroot", "--command-timeout", "--close-from", "--type"] },
  doas: { short: "uC", long: [] },
  nice: { short: "n", long: ["--adjustment"] },
  timeout: { short: "ks", long: ["--kill-after", "--signal"] },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  xargs: {
    short: "adEILnPs",
    long: ["--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars"],
  },
};

/** Reserved words that open a command rather than name one (`then rm f`). */
const KEYWORDS: ReadonlySet<string> = new Set([
  "!",
  "{",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
]);

/** Commands every operand of which is a file they remove, create, empty or move. */
const CHANGES_EVERY_OPERAND: ReadonlySet<string> = new Set([
  "rm",
  "unlink",
  "rmdir",
  "shred",
  "trash",
  "chmod",
  "chown",
  "touch",
  "truncate",
  "mv",
  "tee",
]);

/** Commands whose last operand is the file they write (`cp src dest`). */
const CHANGES_LAST_OPERAND: ReadonlySet<string> = new Set([
  "cp",
  "ln",
  "rsync",
  "ditto",
]);

/** Copy and move commands where `-t dir` names the destination up front. */
const TARGET_DIRECTORY_FLAG: ReadonlySet<string> = new Set(["cp", "mv", "ln", "install"]);
const PLACE_UNDER_DESTINATION: ReadonlySet<string> = new Set([...TARGET_DIRECTORY_FLAG, "rsync", "ditto"]);

/**
 * Flags whose value is the next word, per command, so the value is not
 * read as a file (`touch -r ref f` changes `f`, not `ref`).
 */
const VALUE_FLAGS: Readonly<Record<string, (flag: string) => boolean>> = {
  install: (f) => ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix", "--strip-program"].includes(f),
  touch: (f) => ["-t", "-d", "-r", "--date", "--reference"].includes(f),
  truncate: (f) => ["-s", "-r", "--size", "--reference"].includes(f),
  shred: (f) => ["-n", "-s", "--iterations", "--size"].includes(f),
  cp: (f) => f === "-S" || f === "--suffix",
  mv: (f) => f === "-S" || f === "--suffix",
  ln: (f) => f === "-S" || f === "--suffix",
  rsync: (f) =>
    ["-e", "--rsh", "-f", "--filter", "--exclude", "--include"].includes(f),
  sed: (f) =>
    /^-[nErsuz]*[ef]$/.test(f) || ["-l", "--expression", "--file"].includes(f),
  perl: (f) => /^-[a-zA-Z0-9]*[eE]$/.test(f),
};

/** cmd.exe verbs every operand of which is a file they remove or move. */
const CMD_CHANGES_EVERY_OPERAND: ReadonlySet<string> = new Set([
  "del",
  "erase",
  "rd",
  "move",
  "ren",
  "rename",
]);

/**
 * PowerShell cmdlets: the parameters that name the file they change, and
 * which of the leading positional arguments do (`Move-Item a b`).
 */
const POWERSHELL_TARGETS: Readonly<
  Record<string, { named: readonly string[]; positional: readonly number[] }>
> = {
  "remove-item": { named: ["-path", "-literalpath"], positional: [0] },
  "new-item": { named: ["-path"], positional: [0] },
  "set-content": { named: ["-path", "-literalpath"], positional: [0] },
  "add-content": { named: ["-path", "-literalpath"], positional: [0] },
  "clear-content": { named: ["-path", "-literalpath"], positional: [0] },
  "out-file": { named: ["-filepath", "-literalpath", "-path"], positional: [0] },
  "move-item": {
    named: ["-path", "-literalpath", "-destination"],
    positional: [0, 1],
  },
  "copy-item": { named: ["-destination"], positional: [1] },
};

/**
 * The targets of a whole command line, or `null` when it cannot be read.
 * `dir` is where relative paths resolve; `undefined` once a `cd` went
 * somewhere this cannot know (`cd -`, `cd "$X"`), after which only
 * absolute paths are named.
 */
function lineTargets(
  line: string,
  dir: string | undefined,
  dialect: ShellDialect,
  windows: boolean,
  scope?: WriteTargetScope,
): string[] | null {
  const substitutions = scope && dialect === "posix" ? liftSubstitutions(line, true) : null;
  const tokens = lexShellLine(substitutions?.outer ?? line, dialect, scope?.home, scope !== undefined, scope !== undefined);
  if (tokens === null) return null;
  if (substitutions?.inner.length === 1) {
    const body = lexShellLine(substitutions.inner[0]!, dialect, scope?.home);
    const literal = body?.every((token) => token.kind === "word") ? literalShellInput(body) : undefined;
    if (literal) {
      for (const token of tokens) {
        if (token.kind !== "word" || !token.dynamic || !token.text.includes(PRINTED_PLACEHOLDER)) continue;
        token.text = token.text.replace(PRINTED_PLACEHOLDER, () => literal.text.replace(/\n+$/, ""));
        token.dynamic = /[$*?\[{}]/.test(token.text);
      }
    }
  }
  const targets: string[] = [];
  // A `( … )` subshell's `cd` ends at its `)`.
  const outer: (string | undefined)[] = [];
  let cwd = dir;
  let words: ShellWord[] = [];
  let stdin: ShellWord | undefined;
  let piped: ShellWord | undefined;
  let hasInputRedirect = false;
  const flush = (toPipe = false): boolean => {
    if (words.length === 0) return true;
    const input = hasInputRedirect ? stdin : piped;
    const found = commandTargets(words, cwd, windows, scope, input);
    piped = scope && toPipe ? literalShellInput(words) : undefined;
    stdin = undefined;
    hasInputRedirect = false;
    words = [];
    if (found === null) return false;
    targets.push(...found.targets);
    cwd = found.dir;
    return true;
  };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (token.kind === "word") {
      words.push(token);
      continue;
    }
    if (token.kind === "redirect") {
      const next = tokens[k + 1];
      if (next?.kind !== "word") return scope ? targets : null;
      k += 1;
      if (token.writes === "none" || token.writes === "here-string") {
        hasInputRedirect = true;
        stdin = token.writes === "here-string" ? next : undefined;
      }
      const isFile =
        token.writes === "file" ||
        (token.writes === "dup" && !/^(?:\d+|-)$/.test(next.text));
      const target = isFile ? resolveWriteWord(next, cwd, scope) : undefined;
      if (target !== undefined) targets.push(target);
      continue;
    }
    if (!flush(token.kind === "separator" && token.pipe) && !scope) return null;
    if (token.kind === "open") outer.push(cwd);
    else if (token.kind === "close" && outer.length > 0) cwd = outer.pop();
  }
  if (!flush() && !scope) return null;
  for (const inner of substitutions?.inner ?? []) {
    targets.push(...(lineTargets(inner, dir, dialect, windows, scope) ?? []));
  }
  return targets;
}

function literalShellInput(words: readonly ShellWord[]): ShellWord | undefined {
  if (words.some(({ dynamic }) => dynamic)) return undefined;
  const [name, format, ...args] = words.map(({ text }) => text);
  if (name === "echo" && format && !format.startsWith("-")) return word([format, ...args].join(" "));
  if (name === "printf" && (format === "%s" || format === "%s\\n")) {
    return word(args.join(format === "%s" ? "" : "\n"));
  }
  if (name === "printf" && format && !format.startsWith("-") && args.length === 0 && !/[%\\]/.test(format)) {
    return word(format);
  }
  return undefined;
}

function launcherCommand(
  launcher: string,
  input: readonly ShellWord[],
  dir: string | undefined,
  home?: string,
  scope?: WriteTargetScope,
): { words: readonly ShellWord[]; cwd: string | undefined } {
  let args = input;
  let cwd = dir;
  let index = 0;
  let splits = 0;
  const flags = LAUNCHER_VALUES[launcher];
  while (index < args.length) {
    const arg = args[index]!;
    if (arg.text === "--") { index += 1; break; }
    if (launcher === "env" && arg.text === "-") { index += 1; continue; }
    if (!arg.text.startsWith("-") || arg.text === "-") break;
    const shortIndex = arg.text.startsWith("--") || !flags ? -1 :
      [...arg.text].findIndex((letter, offset) => offset > 0 && flags.short.includes(letter));
    const short = shortIndex === -1 ? "" : arg.text[shortIndex]!;
    const adjusted = short ? { ...arg, text: "-" + arg.text.slice(shortIndex) } : arg;
    const option = flags && valueOption(adjusted, args[index + 1], short ? ["-" + short] : [], flags.long);
    index += option?.consumesNext ? 2 : 1;
    if (!option) continue;
    const long = arg.text.split("=", 1)[0];
    if (launcher === "env" && (short === "C" || long === "--chdir")) {
      cwd = resolveDirectoryWord(option.value, cwd, scope);
    }
    if (launcher === "env" && (short === "S" || long === "--split-string")) {
      if (option.value.dynamic || splits++ >= 8) return { words: [], cwd };
      const split = lexShellLine(option.value.text, "posix", home);
      if (!split?.every((token) => token.kind === "word")) return { words: [], cwd };
      args = [...split, ...args.slice(index)];
      index = 0;
    }
  }
  if (launcher === "timeout") index += 1;
  return { words: args.slice(index), cwd };
}

function xargsCommand(command: readonly ShellWord[], options: readonly ShellWord[], input: string): readonly ShellWord[] {
  const replace = directoryOptions(options.slice(0, options.length - command.length), ["-I"], ["--replace"]).at(-1);
  if (replace?.text && !replace.dynamic) {
    const line = input.split("\n", 1)[0];
    return line ? command.map((arg) => ({ ...arg, text: arg.text.replaceAll(replace.text, line) })) : command;
  }
  const words = lexShellLine(input.replaceAll("\n", " "), "posix");
  return words?.every((token) => token.kind === "word") ? [...command, ...words] : command;
}

function findExecTargets(
  args: readonly ShellWord[], dir: string | undefined, windows: boolean, scope: WriteTargetScope,
): string[] {
  const firstExpression = args.findIndex(({ text }) => /^[-!(]/.test(text));
  const roots = args.slice(0, firstExpression === -1 ? args.length : firstExpression);
  if (!roots.length) roots.push(word("."));
  const result: string[] = [];
  for (let i = Math.max(0, firstExpression); i < args.length; i += 1) {
    const flag = args[i]!.text;
    if (flag === "-delete") {
      for (const root of roots) {
        const path = resolveWriteWord(root, dir, scope);
        if (path) scope.recursive.push(path);
      }
    }
    if (flag !== "-exec" && flag !== "-execdir") continue;
    const command: ShellWord[] = [];
    while (++i < args.length && args[i]!.text !== ";" && args[i]!.text !== "+") command.push(args[i]!);
    for (const root of roots) {
      const path = resolveWord(root, dir, scope.home);
      const invocation = command.map((arg) => arg.text === "{}" && path ? word(path) : arg);
      const found = commandTargets(invocation, flag === "-execdir" ? path : dir, windows, scope);
      if (found) result.push(...found.targets);
      if (path && found?.targets.includes(path)) scope.recursive.push(path);
    }
  }
  return result;
}

/**
 * What one simple command changes, past assignments, prefix commands
 * and reserved words, and the directory the line goes on in: a `cd`
 * moves it, anything else leaves it. A nested shell's line is read as
 * its own (its `cd` stays inside it); `null` when that line cannot be.
 */
function commandTargets(
  inputWords: readonly ShellWord[],
  dir: string | undefined,
  windows: boolean,
  scope?: WriteTargetScope,
  stdin?: ShellWord,
): { targets: string[]; dir: string | undefined } | null {
  let words = inputWords;
  let cwd = dir;
  let i = 0;
  while (i < words.length) {
    const word = words[i]!.text;
    if (KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      if (scope) rememberAssignment(words[i]!, cwd, scope);
      i += 1;
      continue;
    }
    const launcher = commandName(word);
    if (!PREFIX_COMMANDS.has(launcher)) break;
    const inner = launcherCommand(launcher, words.slice(i + 1), cwd, scope?.home, scope);
    words = launcher === "xargs" && scope && stdin && !stdin.dynamic
      ? xargsCommand(inner.words, words.slice(i + 1), stdin.text)
      : inner.words;
    cwd = inner.cwd;
    i = 0;
  }
  const head = words[i];
  const none = { targets: [], dir };
  if (head === undefined) return none;
  if (head.dynamic) return none;
  const name = commandName(head.text);
  const args = words.slice(i + 1);
  if (name === "for" && scope && args[1]?.text === "in" && /^[A-Za-z_]\w*$/.test(args[0]?.text ?? "")) {
    for (const item of args.slice(2)) {
      rememberAssignment({ ...item, text: args[0]!.text + "=" + item.text }, cwd, scope);
    }
    return none;
  }
  if (name === "export" && scope) {
    for (const assignment of args) rememberAssignment(assignment, cwd, scope);
    return none;
  }

  if (name === "cd" || name === "pushd") {
    const operands = windows ? cmdOperands(args) : plainOperands(args);
    const to = operands[0];
    if (to === undefined) return { targets: [], dir: scope?.home ?? homedir() };
    return { targets: [], dir: to.text === "-" ? undefined : resolveDirectoryWord(to, cwd, scope) };
  }
  if (name === "popd") return { targets: [], dir: undefined };

  if (name === "find" && scope) return { targets: findExecTargets(args, cwd, windows, scope), dir };
  const nested = nestedLine(name, args);
  if (nested !== undefined) {
    if (nested === null) {
      if (!scope || !stdin || stdin.dynamic || !NESTED_SHELLS.has(name) || !usesShellStdin(args)) return none;
      return { targets: lineTargets(stdin.text, cwd, "posix", windows, scope) ?? [], dir };
    }
    // Its own `cd` stays inside it; a cmd.exe or PowerShell line speaks
    // Windows verbs wherever it runs.
    const targets = lineTargets(
      nested.line,
      cwd,
      nested.dialect,
      windows || nested.dialect !== "posix",
      scope,
    );
    return targets === null ? null : { targets, dir };
  }

  if (name === "install" && !scope) return none;
  const structured = structuredWrites(name, args, cwd, scope);
  const targetDir = structured && "cwd" in structured ? structured.cwd : cwd;
  const targets = (structured?.words ?? changedWords(name, args, windows)).flatMap((word) =>
    resolveWriteWord(word, targetDir, scope) ?? [],
  );
  if (scope && structured?.recursive) scope.recursive.push(...targets);
  if (scope && PLACE_UNDER_DESTINATION.has(name) &&
      !(name === "rsync" && args.some(({ text }) => text === "--dry-run" || /^-[^-]*n/.test(text)))) {
    const copy = copyOperands(name, args);
    const dest = copy.destination && resolveWriteWord(copy.destination, cwd, scope);
    if (dest && !args.some(({ text }) => text === "-T" || text === "--no-target-directory")) {
      for (const source of copy.sources) {
        const contentsOnly = name === "rsync" && source.text.endsWith("/");
        const input = resolveDirectoryWord(source, cwd, scope);
        if (input && !contentsOnly) scope.placed.push(resolve(dest, basename(input)));
      }
    }
  }
  const removed = scope?.removals ? removalWords(name, args) : [];
  if (scope?.removals && removed.length > 0 &&
    !scope.skipRemovals?.(name, args.map(({ text }) => text), cwd ?? scope.home ?? homedir())) {
    for (const operand of removed) {
      const target = resolveWord(operand, cwd, scope.home);
      if (target !== undefined) scope.removals.push(target);
    }
  }
  return { targets, dir };
}

function usesShellStdin(args: readonly ShellWord[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const { text, dynamic } = args[index]!;
    if (dynamic || text === "-") return false;
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(text)) return true;
    if (text === "--") return index + 1 === args.length;
    if (!text.startsWith("-") || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(text)) return false;
    if (text === "-o" || text === "-O") index += 1;
  }
  return true;
}

/**
 * The command line a shell is told to run (`sh -c "<line>"`,
 * `cmd /c del f`, `pwsh -Command …`), `null` for a shell running a
 * script file or a line built at runtime, `undefined` for a command that
 * is not a shell.
 */
function nestedLine(
  name: string,
  args: readonly ShellWord[],
): { line: string; dialect: ShellDialect } | null | undefined {
  if (NESTED_SHELLS.has(name)) {
    for (let j = 0; j < args.length; j++) {
      const flag = args[j]!.text;
      if (!/^[-+]/.test(flag)) return null;
      if (/^[-+][oO]$/.test(flag)) {
        j += 1;
        continue;
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag)) {
        const script = args[j + 1];
        return script === undefined || script.dynamic
          ? null
          : { line: script.text, dialect: "posix" };
      }
    }
    return null;
  }
  if (name === "cmd") {
    const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg.text));
    return at === -1 ? null : { line: joinWords(args.slice(at + 1)), dialect: "cmd" };
  }
  if (name === "powershell" || name === "pwsh") {
    const at = args.findIndex((arg) => /^-(?:c|command)$/i.test(arg.text));
    return at === -1
      ? null
      : { line: joinWords(args.slice(at + 1)), dialect: "powershell" };
  }
  return undefined;
}

/** The words of a command that name a file it changes. */
function changedWords(
  name: string,
  args: readonly ShellWord[],
  windows: boolean,
): ShellWord[] {
  const takesValue = VALUE_FLAGS[name];
  if (name === "rsync" && args.some(({ text }) => text === "--dry-run" || /^-[^-]*n/.test(text))) return [];
  if (name === "install" && args.some(({ text }) => text === "--directory" || /^-[dDv]*d[dDv]*$/.test(text))) {
    return plainOperands(args, takesValue);
  }
  if (TARGET_DIRECTORY_FLAG.has(name)) {
    const { sources, destination } = copyOperands(name, args);
    return [...(name === "mv" ? sources : []), ...(destination ? [destination] : [])];
  }
  if (name === "mkdir") return plainOperands(args, (flag) => flag === "-m" || flag === "--mode");
  if (name === "gio" && args[0]?.text === "trash") return plainOperands(args.slice(1));
  if (/^kioclient[56]?$/.test(name) && args[0]?.text === "move") return plainOperands(args.slice(1, -1));
  if (name === "chmod" || name === "chown") {
    const operands = plainOperands(args, (flag) => flag === "--reference");
    return args.some(({ text }) => text === "--reference" || text.startsWith("--reference="))
      ? operands : operands.slice(1);
  }
  if (CHANGES_EVERY_OPERAND.has(name)) return plainOperands(args, takesValue);
  if (CHANGES_LAST_OPERAND.has(name)) {
    const operands = plainOperands(args, takesValue);
    return operands.length > 1 ? operands.slice(-1) : [];
  }
  if (name === "sed" || name === "perl") return inPlaceFiles(name, args);
  if (name === "dd") {
    return args
      .filter((arg) => arg.text.startsWith("of="))
      .map((arg) => ({ ...arg, text: arg.text.slice("of=".length) }));
  }
  if (!windows) return [];
  if (CMD_CHANGES_EVERY_OPERAND.has(name)) return cmdOperands(args);
  if (name === "copy") {
    const operands = cmdOperands(args);
    return operands.length > 1 ? operands.slice(-1) : [];
  }
  const cmdlet = POWERSHELL_TARGETS[name];
  return cmdlet === undefined ? [] : powershellTargets(args, cmdlet);
}

function removalWords(name: string, args: readonly ShellWord[]): ShellWord[] {
  if (name === "mv") return copyOperands(name, args).sources;
  if (name === "gio" && args[0]?.text === "trash") return plainOperands(args.slice(1));
  if (/^kioclient[56]?$/.test(name) && args[0]?.text === "move") return plainOperands(args.slice(1, -1));
  if (["rm", "rmdir", "unlink", "trash"].includes(name)) return plainOperands(args);
  if (["del", "erase", "rd"].includes(name)) return cmdOperands(args);
  if (name === "remove-item") return powershellTargets(args, POWERSHELL_TARGETS[name]!);
  return [];
}

function word(text: string): ShellWord {
  return { text, dynamic: false };
}

/** Options can take a separate, attached or equals-separated value. */
function valueOption(
  arg: ShellWord,
  next: ShellWord | undefined,
  short: readonly string[],
  long: readonly string[],
): { value: ShellWord; consumesNext: boolean } | undefined {
  const { text } = arg;
  if (short.includes(text) || long.includes(text)) {
    return { value: next ?? { text: "", dynamic: true }, consumesNext: true };
  }
  const flag = long.find((name) => text.startsWith(name + "=")) ??
    short.find((name) => text.startsWith(name) && text.length > name.length);
  if (flag === undefined) return undefined;
  const offset = flag.length + (text[flag.length] === "=" ? 1 : 0);
  return { value: { ...arg, text: text.slice(offset) }, consumesNext: false };
}

function copyOperands(name: string, args: readonly ShellWord[]) {
  let destination: ShellWord | undefined;
  const rest: ShellWord[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.text === "--") { rest.push(...args.slice(i)); break; }
    const bundle = /^-[aAbdDfHilnPpRrsuvx]+t(.*)$/.exec(arg.text);
    const targetArg = bundle ? { ...arg, text: "-t" + bundle[1] } : arg;
    const option = TARGET_DIRECTORY_FLAG.has(name)
      ? valueOption(targetArg, args[i + 1], ["-t"], ["--target-directory"])
      : undefined;
    if (!option) { rest.push(arg); continue; }
    destination = option.value;
    if (option.consumesNext) i += 1;
  }
  const operands = plainOperands(rest, VALUE_FLAGS[name]);
  return destination
    ? { sources: operands, destination }
    : { sources: operands.slice(0, -1), destination: operands.length > 1 ? operands.at(-1) : undefined };
}

function remoteLeaf(input: ShellWord, suffix = ""): ShellWord {
  const location = input.text.split(/[?#]/, 1)[0]!.replace(/[/\\]+$/, "");
  const name = location.split(/[/\\:]/).at(-1) ?? "";
  return { text: suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name,
    dynamic: input.dynamic || name.length === 0 || name === "." || name === ".." };
}

function directoryOptions(
  args: readonly ShellWord[], short: readonly string[], long: readonly string[],
  normalise: (arg: ShellWord) => ShellWord = (arg) => arg,
): ShellWord[] {
  const result: ShellWord[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]!.text === "--") break;
    const option = valueOption(normalise(args[i]!), args[i + 1], short, long);
    if (!option) continue;
    result.push(option.value);
    if (option.consumesNext) i += 1;
  }
  return result;
}

const GIT_WORKTREE_MUTATORS = new Set(["pull", "checkout", "apply", "reset", "merge", "am"]);

function structuredWrites(name: string, args: readonly ShellWord[], dir: string | undefined, scope?: WriteTargetScope):
  { words: ShellWord[]; cwd?: string; recursive?: boolean } | undefined {
  if (name === "7z" || name === "7za" || name === "7zz") {
    if (!["x", "e"].includes(args[0]?.text ?? "")) return { words: [] };
    const destinations = directoryOptions(args.slice(1), ["-o"], []);
    return { words: destinations.length ? destinations : [word(".")], recursive: true };
  }
  if (name === "cpio") {
    const flags = args.map(({ text }) => text);
    const pass = flags.some((flag) => flag === "--pass-through" || /^-[^-]*p/.test(flag));
    const extract = flags.some((flag) => flag === "--extract" || /^-[^-]*i/.test(flag));
    if ((!pass && !extract) || flags.some((flag) => flag === "--list" || /^-[^-]*t/.test(flag))) return { words: [] };
    const destinations = pass ? args.slice(-1) : directoryOptions(args, ["-D"], ["--directory"]);
    return { words: destinations.length ? destinations : [word(".")], recursive: true };
  }
  if (name === "patch") {
    if (args.some(({ text }) => text === "--dry-run")) return { words: [] };
    const root = directoryOptions(args, ["-d"], ["--directory"]).at(-1) ?? word(".");
    const outputs = directoryOptions(args, ["-o"], ["--output"]);
    const rejects = directoryOptions(args, ["-r"], ["--reject-file"]);
    const base = resolveDirectoryWord(root, dir, scope);
    return outputs.length
      ? { words: [...outputs, ...rejects], cwd: base }
      : { words: [word("."), ...rejects], cwd: base, recursive: true };
  }
  if (name === "npm") {
    const prefixes = directoryOptions(args, [], ["--prefix"]);
    const command = plainOperands(args, (flag) => flag === "--prefix")[0]?.text;
    if (command !== "install" && command !== "i" && command !== "ci") return { words: [] };
    return { words: [prefixes.at(-1) ?? word(".")], recursive: true };
  }
  const tar = name === "tar" || name === "bsdtar";
  if (tar || name === "unzip") {
    if (tar && !args.some(({ text }, index) =>
      text === "--extract" || text === "--get" ||
      (/^-[A-Za-z]*x/.test(text) || (index === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(text)))
    )) return { words: [] };
    if (name === "unzip" && args.some(({ text }) => /^-[lpqtovZ]+$/.test(text) && /[lptZ]/.test(text))) {
      return { words: [] };
    }
    const destinations = directoryOptions(args, tar ? ["-C"] : ["-d"], tar ? ["--directory"] : [], (arg) => {
      const bundle = tar ? /^-[xvzkjJpmw]+C(.*)$/.exec(arg.text) : null;
      return bundle ? { ...arg, text: "-C" + bundle[1] } : arg;
    });
    return { words: destinations.length ? destinations : [word(".")], recursive: true };
  }
  if (name === "git") {
    let cwd = dir;
    let i = 0;
    for (; i < args.length && args[i]!.text.startsWith("-"); i += 1) {
      const arg = args[i]!;
      const option = valueOption(arg, args[i + 1], ["-C"], []);
      if (option) {
        cwd = resolveDirectoryWord(option.value, cwd, scope);
        if (option.consumesNext) i += 1;
      } else if (["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg.text)) i += 1;
    }
    const subcommand = args[i]?.text ?? "";
    if (subcommand === "apply" && args.slice(i + 1).some(({ text }) => text === "--check") &&
      !args.slice(i + 1).some(({ text }) => text === "--apply")) return { words: [] };
    if (GIT_WORKTREE_MUTATORS.has(subcommand)) return { words: [word(".")], cwd, recursive: true };
    if (subcommand !== "clone") return undefined;
    const positionals = plainOperands(args.slice(i + 1), (flag) =>
      ["-b", "--branch", "-o", "--origin", "-c", "--config", "--depth", "--filter",
        "--reference", "--reference-if-able", "--separate-git-dir", "--shallow-since",
        "--shallow-exclude", "-j", "--jobs", "--template", "--upload-pack", "-u"].includes(flag),
    );
    const remote = positionals[0];
    if (!remote) return { words: [] };
    const destinations = [positionals[1] ?? remoteLeaf(remote, ".git")];
    for (let k = i + 1; k < args.length; k += 1) {
      if (args[k]!.text === "--") break;
      const separate = valueOption(args[k]!, args[k + 1], [], ["--separate-git-dir"]);
      if (separate) destinations.push(separate.value);
    }
    return { words: destinations, cwd };
  }
  if (name !== "curl" && name !== "wget") return undefined;
  const curl = name === "curl";
  const outputs: ShellWord[] = [];
  const urls: ShellWord[] = [];
  let base = word(".");
  let remoteName = !curl;
  let fromHeader = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.text === "--") { urls.push(...args.slice(i + 1)); break; }
    if (curl && /^-[sSvfkLqgZ46OJ]+$/.test(arg.text) && /[OJ]/.test(arg.text)) {
      remoteName ||= arg.text.includes("O");
      fromHeader ||= arg.text.includes("J");
      continue;
    }
    if (curl && arg.text === "--remote-header-name") { fromHeader = true; continue; }
    const bundled = curl
      ? /^-[sSvfkLqgZ46]+(o.*)$/.exec(arg.text)
      : /^-[qvNncHrkKpE]+([OP].*)$/.exec(arg.text);
    const optionArg = bundled ? { ...arg, text: "-" + bundled[1] } : arg;
    if (curl && ["-O", "--remote-name", "--remote-name-all"].includes(optionArg.text)) { remoteName = true; continue; }
    const output = valueOption(optionArg, args[i + 1], curl ? ["-o"] : ["-O"], curl ? ["--output"] : ["--output-document"]);
    if (output) {
      outputs.push(output.value);
      if (output.consumesNext) i += 1;
      continue;
    }
    const folder = valueOption(optionArg, args[i + 1], curl ? [] : ["-P"], curl ? ["--output-dir"] : ["--directory-prefix"]);
    if (folder) {
      base = folder.value;
      if (folder.consumesNext) i += 1;
      continue;
    }
    const remote = valueOption(arg, args[i + 1], [], ["--url"]);
    if (remote) {
      urls.push(remote.value);
      if (remote.consumesNext) i += 1;
    } else if (arg.text.includes("://") || arg.dynamic) urls.push(arg);
  }
  if (remoteName && (curl || outputs.length === 0)) {
    for (const url of urls) outputs.push(fromHeader ? { text: "", dynamic: true } : remoteLeaf(url));
    if (urls.length === 0) outputs.push({ text: "", dynamic: true });
  }
  if (remoteName && fromHeader) return { words: [...outputs.filter((file) => !file.dynamic), base], recursive: true };
  return { words: outputs.map((file) => file.text === "-" || isAbsolute(file.text) || base.text === "."
    ? file : { text: base.text + "/" + file.text, dynamic: base.dynamic || file.dynamic }) };
}

/**
 * The files `sed -i` / `perl -i` rewrite: its operands, less the script
 * when no `-e` / `-f` gave it. `-i` only in a flag cluster of options
 * that take no value (`-ni`, `-pi`), so `perl -Mstrict` is not one.
 */
function inPlaceFiles(name: "sed" | "perl", args: readonly ShellWord[]): ShellWord[] {
  const inPlace =
    name === "sed"
      ? args.some(
          (arg) => /^-[nErsuz]*i/.test(arg.text) || arg.text.startsWith("--in-place"),
        )
      : args.some((arg) => /^-[anplsw0-9]*i/.test(arg.text));
  if (!inPlace) return [];
  const takesValue = VALUE_FLAGS[name]!;
  const scriptGiven = args.some(
    (arg) => takesValue(arg.text) && !["-l"].includes(arg.text),
  );
  // `sed -i '' …` (BSD): the empty suffix is not a file.
  const operands = plainOperands(args, takesValue).filter((arg) => arg.text !== "");
  return scriptGiven ? operands : operands.slice(1);
}

/** Arguments that are not flags (or their values); after `--`, all are. */
function plainOperands(
  args: readonly ShellWord[],
  takesValue?: (flag: string) => boolean,
): ShellWord[] {
  const operands: ShellWord[] = [];
  let flagsDone = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    if (!flagsDone && arg.text === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && arg.text.startsWith("-") && arg.text.length > 1) {
      if (takesValue?.(arg.text) === true) k += 1;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

/** cmd.exe arguments that are not `/x` switches. */
function cmdOperands(args: readonly ShellWord[]): ShellWord[] {
  return args.filter((arg) => !/^\/[A-Za-z?](?::\S*)?$/.test(arg.text));
}

function powershellTargets(
  args: readonly ShellWord[],
  cmdlet: { named: readonly string[]; positional: readonly number[] },
): ShellWord[] {
  const leading: ShellWord[] = [];
  for (const arg of args) {
    if (arg.text.startsWith("-")) break;
    leading.push(arg);
  }
  const found = cmdlet.positional.flatMap((at) => leading[at] ?? []);
  for (let k = 0; k + 1 < args.length; k++) {
    if (cmdlet.named.includes(args[k]!.text.toLowerCase())) found.push(args[k + 1]!);
  }
  return found;
}

/** Basename, lowercased, without `.exe`: `rm`, `remove-item`, `cmd`. */
function commandName(word: string): string {
  return basenameCommand(word).toLowerCase().replace(/\.exe$/, "");
}

/**
 * The words after `/c` or `-Command` back into the line they spell: one
 * word is the line itself (`cmd /c "del a.txt"`); several are joined,
 * quoting the ones with spaces (`cmd /c del "my file.txt"`).
 */
function joinWords(words: readonly ShellWord[]): string {
  if (words.length === 1) return words[0]!.text;
  return words.map(({ text }) => (/\s/.test(text) ? `"${text}"` : text)).join(" ");
}

/**
 * A word as an absolute path, or `undefined` when it cannot be one: a
 * word only known at runtime, `-` (standard input or output), a device
 * (`/dev/null`, `NUL`), or a relative path after a `cd` this could not
 * follow.
 */
function resolveWord(word: ShellWord, dir: string | undefined, home?: string): string | undefined {
  const text = home && /^~(?:[/\\]|$)/.test(word.text) ? home + word.text.slice(1) : word.text;
  if (word.dynamic || text.length === 0 || text === "-") return undefined;
  if (text.startsWith("/dev/") || /^nul$/i.test(text)) return undefined;
  if (dir === undefined && !isAbsolute(expandHome(text))) return undefined;
  try {
    return resolve(resolveUserPath(text, dir ?? homedir()));
  } catch {
    // A POSIX-absolute path on Windows: not a file this can name.
    return undefined;
  }
}

function rememberAssignment(word: ShellWord, dir: string | undefined, scope: WriteTargetScope): void {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/s.exec(word.text);
  if (!assignment) return;
  const [, name, value] = assignment;
  const target = resolveDirectoryWord({ text: value!, dynamic: word.dynamic }, dir, scope);
  if (target === undefined) return;
  const assignments = scope.assignments ??= new Map();
  const candidates = assignments.get(name!) ?? new Set<string>();
  candidates.add(target);
  assignments.set(name!, candidates);
}

function resolveDirectoryWord(word: ShellWord, dir: string | undefined, scope?: WriteTargetScope): string | undefined {
  if (!word.dynamic || !scope) return resolveWord(word, dir, scope?.home);
  const variable = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))([^$*?\[{}]*)$/.exec(word.text);
  if (!variable) return undefined;
  const name = (variable[1] ?? variable[2])!;
  const bases = scope.assignments?.get(name);
  const base = bases?.size === 1 ? bases.values().next().value : name === "HOME" ? scope.home : undefined;
  if (base === undefined) return undefined;
  return resolveWord({ text: base + variable[3], dynamic: false }, dir, scope.home);
}

function resolveWriteWord(word: ShellWord, dir: string | undefined, scope?: WriteTargetScope): string | undefined {
  const target = resolveDirectoryWord(word, dir, scope);
  if (target !== undefined || !scope || !word.dynamic) return target;
  const fallback = /^\$\{[A-Za-z_]\w*:?[=-]([^$*?\[{}]+)\}([^$*?\[{}]*)$/.exec(word.text);
  if (fallback) {
    const candidate = resolveWord({ text: fallback[1]! + fallback[2], dynamic: false }, dir, scope.home);
    if (candidate) scope.placed.push(candidate);
  }
  const variable = /^\$(?:\{([A-Za-z_]\w*)[^}]*\}|([A-Za-z_]\w*))(.*)$/s.exec(word.text);
  if (variable) {
    const [, braced, bare, suffix] = variable;
    const name = (braced ?? bare)!;
    const bases = name === "HOME" && scope.home ? [scope.home] : scope.assignments?.get(name) ?? [];
    if (dir !== undefined && [...bases].length === 0) scope.placed.push(dir);
    for (const base of bases) {
      scope.placed.push(...plausibleWritePaths({ text: base + suffix, dynamic: true }, dir, scope.home));
    }
    return undefined;
  }
  scope.placed.push(...plausibleWritePaths(word, dir, scope.home));
  return undefined;
}

function plausibleWritePaths(word: ShellWord, dir: string | undefined, home?: string): string[] {
  const prefix = /^[^$*?\[]+/.exec(word.text)?.[0] ?? "";
  if (!prefix || (prefix !== word.text && !prefix.includes("/"))) return dir === undefined ? [] : [dir];
  const slash = prefix.lastIndexOf("/");
  const text = prefix === word.text ? prefix : prefix.slice(0, slash + 1);
  const path = resolveWord({ text, dynamic: false }, dir, home);
  return path === undefined ? [] : [path];
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
