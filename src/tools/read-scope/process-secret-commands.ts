import { invocationsOf, programName, shortOptionLetters } from "../os/shell-command-guard/command-segments.js";

function showsPsSecrets(words: readonly string[]): boolean {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") break;
    if (word === "--environment") return true;
    if (word === "--format" || word.startsWith("--format=")) {
      if (argumentColumns(word === "--format" ? words[++index] : word.slice(9))) return true;
      continue;
    }
    if (/^--(?:pid|ppid|sid|user|group|tty|sort)$/.test(word)) {
      index++;
      continue;
    }
    const options = shortOptionLetters(word, "oOpqgGstTuU");
    if (options) {
      if (options.some(option => /^[EfF]$/.test(option))) return true;
      const last = options.at(-1);
      if (!last || !"oOpqgGstTuU".includes(last)) continue;
      const value = word.slice(options.length + 1) || words[++index];
      if ((last === "o" || last === "O") && argumentColumns(value)) return true;
      continue;
    }
    if (/^[A-Za-z]*[efux][A-Za-z]*$/.test(word)) return true;
  }
  return false;
}

function argumentColumns(value: string | undefined): boolean {
  return /(?:^|[,\s])(?:args|arguments|cmd|command)(?=$|[=,\s])/.test(value ?? "");
}

export function processSecretCommand(
  segments: readonly (readonly string[])[],
): string | undefined {
  if (invocationsOf(segments, "ps").some(showsPsSecrets)) return "ps";
  for (const [command, ...args] of segments) {
    if (!command) continue;
    const name = programName(command);
    const short = args.filter(arg => /^-[A-Za-z]+$/.test(arg)).join("");
    if (name === "pgrep" && (/[al]/.test(short) || args.includes("--list-full") || args.includes("--list-name"))) return name;
    if (name === "pstree" && (/a/.test(short) || args.includes("--arguments"))) return name;
    if (name === "top" && /b/.test(short) && /c/.test(short)) return name;
  }
  return undefined;
}
