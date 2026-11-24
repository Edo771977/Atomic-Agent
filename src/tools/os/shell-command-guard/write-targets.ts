import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { expandHome, resolveUserPath } from "../expand-home.js";
import { liftSubstitutions } from "./command-substitution.js";
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
]);

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
const TARGET_DIRECTORY_FLAG: ReadonlySet<string> = new Set(["cp", "mv", "ln"]);

/**
 * Flags whose value is the next word, per command, so the value is not
 * read as a file (`touch -r ref f` changes `f`, not `ref`).
 */
const VALUE_FLAGS: Readonly<Record<string, (flag: string) => boolean>> = {
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
  let tokens = lexShellLine(line, dialect, scope?.home);
  const substitutions = scope && dialect === "posix" && tokens === null ? liftSubstitutions(line) : null;
  if (substitutions?.inner.length) tokens = lexShellLine(substitutions.outer, dialect, scope?.home);
  if (tokens === null) return null;
  const targets: string[] = [];
  // A `( … )` subshell's `cd` ends at its `)`.
  const outer: (string | undefined)[] = [];
  let cwd = dir;
  let words: ShellWord[] = [];
  const flush = (): boolean => {
    if (words.length === 0) return true;
    const found = commandTargets(words, cwd, windows, scope);
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
      if (next?.kind !== "word") return null;
      k += 1;
      const isFile =
        token.writes === "file" ||
        (token.writes === "dup" && !/^(?:\d+|-)$/.test(next.text));
      const target = isFile ? resolveWriteWord(next, cwd, scope) : undefined;
      if (target !== undefined) targets.push(target);
      continue;
    }
    if (!flush()) return null;
    if (token.kind === "open") outer.push(cwd);
    else if (token.kind === "close" && outer.length > 0) cwd = outer.pop();
  }
  if (!flush()) return null;
  for (const inner of substitutions?.inner ?? []) {
    targets.push(...(lineTargets(inner, dir, dialect, windows, scope) ?? []));
  }
  return targets;
}

/**
 * What one simple command changes, past assignments, prefix commands
 * and reserved words, and the directory the line goes on in: a `cd`
 * moves it, anything else leaves it. A nested shell's line is read as
 * its own (its `cd` stays inside it); `null` when that line cannot be.
 */
function commandTargets(
  words: readonly ShellWord[],
  dir: string | undefined,
  windows: boolean,
  scope?: WriteTargetScope,
): { targets: string[]; dir: string | undefined } | null {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!.text;
    if (KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      if (scope) rememberAssignment(words[i]!, dir, scope);
      i += 1;
      continue;
    }
    if (!PREFIX_COMMANDS.has(commandName(word))) break;
    i += 1;
    while (i < words.length && words[i]!.text.startsWith("-")) i += 1;
  }
  const head = words[i];
  const none = { targets: [], dir };
  if (head === undefined) return none;
  if (head.dynamic) return none;
  const name = commandName(head.text);
  const args = words.slice(i + 1);

  if (name === "cd" || name === "pushd") {
    const operands = windows ? cmdOperands(args) : plainOperands(args);
    const to = operands[0];
    if (to === undefined) return { targets: [], dir: scope?.home ?? homedir() };
    return { targets: [], dir: to.text === "-" ? undefined : resolveWord(to, dir, scope?.home) };
  }
  if (name === "popd") return { targets: [], dir: undefined };

  const nested = nestedLine(name, args);
  if (nested !== undefined) {
    if (nested === null) return none;
    // Its own `cd` stays inside it; a cmd.exe or PowerShell line speaks
    // Windows verbs wherever it runs.
    const targets = lineTargets(
      nested.line,
      dir,
      nested.dialect,
      windows || nested.dialect !== "posix",
      scope,
    );
    return targets === null ? null : { targets, dir };
  }

  const structured = structuredWrites(name, args, dir, scope?.home);
  const targetDir = structured?.cwd ?? dir;
  const targets = (structured?.words ?? changedWords(name, args, windows)).flatMap((word) =>
    resolveWriteWord(word, targetDir, scope) ?? [],
  );
  if (scope && structured?.recursive) scope.recursive.push(...targets);
  if (scope && TARGET_DIRECTORY_FLAG.has(name)) {
    const copy = copyOperands(name, args);
    const dest = copy.destination && resolveWriteWord(copy.destination, dir, scope);
    if (dest && !args.some(({ text }) => text === "-T" || text === "--no-target-directory")) {
      for (const source of copy.sources) {
        if (!source.dynamic) scope.placed.push(resolve(dest, basename(source.text)));
      }
    }
  }
  const removed = scope?.removals ? removalWords(name, args) : [];
  if (scope?.removals && removed.length > 0 &&
    !scope.skipRemovals?.(name, args.map(({ text }) => text), dir ?? scope.home ?? homedir())) {
    for (const operand of removed) {
      const target = resolveWord(operand, dir, scope.home);
      if (target !== undefined) scope.removals.push(target);
    }
  }
  return { targets, dir };
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
    const bundle = /^-[aAbdfHilnPpRrsuvx]+t(.*)$/.exec(arg.text);
    const targetArg = bundle ? { ...arg, text: "-t" + bundle[1] } : arg;
    const option = valueOption(targetArg, args[i + 1], ["-t"], ["--target-directory"]);
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

function structuredWrites(name: string, args: readonly ShellWord[], dir: string | undefined, home?: string):
  { words: ShellWord[]; cwd?: string; recursive?: boolean } | undefined {
  if (name === "tar" || name === "unzip") {
    if (name === "tar" && !args.some(({ text }, index) =>
      text === "--extract" || text === "--get" ||
      (/^-[A-Za-z]*x/.test(text) || (index === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(text)))
    )) return { words: [] };
    if (name === "unzip" && args.some(({ text }) => /^-[lpqtovZ]+$/.test(text) && /[lptZ]/.test(text))) {
      return { words: [] };
    }
    const destinations: ShellWord[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg.text === "--") break;
      const bundle = name === "tar" ? /^-[xvzkjJpmw]+C(.*)$/.exec(arg.text) : null;
      const flag = bundle ? { ...arg, text: "-C" + bundle[1] } : arg;
      const option = valueOption(flag, args[i + 1], name === "tar" ? ["-C"] : ["-d"], name === "tar" ? ["--directory"] : []);
      if (!option) continue;
      destinations.push(option.value);
      if (option.consumesNext) i += 1;
    }
    return { words: destinations.length ? destinations : [word(".")], recursive: true };
  }
  if (name === "git") {
    let cwd = dir;
    let i = 0;
    for (; i < args.length && args[i]!.text.startsWith("-"); i += 1) {
      const arg = args[i]!;
      const option = valueOption(arg, args[i + 1], ["-C"], []);
      if (option) {
        cwd = resolveWord(option.value, cwd, home);
        if (option.consumesNext) i += 1;
      } else if (["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg.text)) i += 1;
    }
    if (args[i]?.text !== "clone") return undefined;
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
    return cwd === undefined
      ? { words: destinations.map((dest) => ({ ...dest, dynamic: dest.dynamic || !isAbsolute(dest.text) })) }
      : { words: destinations, cwd };
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
  const target = resolveWord({ text: value!.replace(/^\$(?:HOME\b|\{HOME\})/, () => scope.home ?? homedir()), dynamic: word.dynamic && !/^\$(?:HOME\b|\{HOME\})[^$*?\[]*$/.test(value!) }, dir, scope.home);
  if (target === undefined) return;
  const assignments = scope.assignments ??= new Map();
  const candidates = assignments.get(name!) ?? new Set<string>();
  candidates.add(target);
  assignments.set(name!, candidates);
}

function resolveWriteWord(word: ShellWord, dir: string | undefined, scope?: WriteTargetScope): string | undefined {
  const target = resolveWord(word, dir, scope?.home);
  if (target !== undefined || !scope || !word.dynamic) return target;
  const variable = /^\$(?:\{([A-Za-z_]\w*)[^}]*\}|([A-Za-z_]\w*))(.*)$/s.exec(word.text);
  if (variable) {
    const [, braced, bare, suffix] = variable;
    const name = (braced ?? bare)!;
    const bases = name === "HOME" && scope.home ? [scope.home] : scope.assignments?.get(name) ?? [];
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
  if (!prefix || (prefix !== word.text && !prefix.includes("/"))) return [];
  const slash = prefix.lastIndexOf("/");
  const text = prefix === word.text ? prefix : prefix.slice(0, slash + 1);
  const path = resolveWord({ text, dynamic: false }, dir, home);
  return path === undefined ? [] : [path];
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
