import { PREFIX_COMMANDS, programName, shortOptionLetters } from "../os/shell-command-guard/command-segments.js";

// SysV selectors consume values. Thread display flags -L and -T do not.
const PS_VALUE_OPTIONS = "CoOGgpqstUu";
const PS_BSD_FLAGS = /^[aAccefhHjlLmMnorsSTuvwxXZ]+$/;

function showsPsSecrets(words: readonly string[]): boolean {
  let implicitArguments = false;
  let customFormat = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") break;
    if (word === "--environment") return true;
    if (word === "--format" || word.startsWith("--format=")) {
      customFormat = true;
      if (argumentColumns(word === "--format" ? words[++index] : word.slice(9))) return true;
      continue;
    }
    const long = /^--(?:pid|ppid|sid|user|group|tty|sort)(=|$)/.exec(word);
    if (long) {
      if (long[1] !== "=") index++;
      continue;
    }
    const sysv = shortOptionLetters(word, PS_VALUE_OPTIONS);
    const bsd = sysv === null && PS_BSD_FLAGS.test(word);
    if (sysv === null && !bsd) break;

    const valueLetters = bsd ? "opOtU" : PS_VALUE_OPTIONS;
    const bundle = bsd ? word : word.slice(1);
    for (let offset = 0; offset < bundle.length; offset++) {
      const letter = bundle[offset]!;
      if (bsd ? letter === "e" : letter === "E") return true;
      if (bsd ? /[fux]/.test(letter) : /[fF]/.test(letter)) implicitArguments = true;
      if (!valueLetters.includes(letter)) continue;
      const value = bundle.slice(offset + 1) || words[++index];
      if (letter === "o" || letter === "O") {
        customFormat = true;
        if (argumentColumns(value?.replace(/^=/, ""))) return true;
      }
      break;
    }
  }
  return implicitArguments && !customFormat;
}

function argumentColumns(value: string | undefined): boolean {
  return /(?:^|[,\s])(?:args|arguments|cmd|command)(?=$|[=,\s])/.test(value ?? "");
}

/** Skip assignments and wrappers that execute their first command operand. */
function executableIndex(segment: readonly string[]): number {
  let index = 0;
  while (index < segment.length) {
    const word = segment[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index++;
      continue;
    }
    const name = programName(word);
    if (!Object.hasOwn(PREFIX_COMMANDS, name)) break;
    const valueOptions = PREFIX_COMMANDS[name]!;
    index++;
    while (segment[index]?.startsWith("-") && segment[index] !== "-") {
      const option = segment[index++]!;
      if (option === "--") break;
      if (valueOptions.includes(option) && index < segment.length) index++;
    }
  }
  return index;
}

export function processSecretCommand(
  segments: readonly (readonly string[])[],
): string | undefined {
  for (const segment of segments) {
    const [command, ...args] = segment.slice(executableIndex(segment));
    if (!command) continue;
    const name = programName(command);
    if (name === "ps" && showsPsSecrets(args)) return name;
    const short = args.filter(arg => /^-[A-Za-z]+$/.test(arg)).join("");
    if (name === "pgrep" && (/[al]/.test(short) || args.includes("--list-full") || args.includes("--list-name"))) return name;
    if (name === "pstree" && (/a/.test(short) || args.includes("--arguments"))) return name;
    if (name === "top") {
      const options = args.flatMap(arg => shortOptionLetters(arg, "dnpUuw") ?? []);
      if (options.includes("b") && options.includes("c")) return name;
    }
  }
  return undefined;
}
