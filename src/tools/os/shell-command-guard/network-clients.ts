import type { EgressClass } from "../../../config/project-constraints-config.js";
import {
  NESTED_SHELL_PROGRAMS,
  PREFIX_COMMANDS,
  programName,
  scanNestedShellOptions,
  splitCommandSegments,
} from "./command-segments.js";
import { findGitSubcommand } from "./rules-policy.js";

/**
 * Best-effort detection of a network client in a shell command, for the
 * per-folder egress constraint (issue #33 §5, `tool-egress.ts`). It reads
 * each simple command of the line (the guard's own lexer), skips
 * wrappers (`sudo`, `env X=1`, `xargs`, `timeout`), looks inside
 * `sh -c` / `bash -lc` bodies and `powershell -Command`, and names the
 * first program that would open a connection.
 *
 * This is a heuristic, not a sandbox: a script, an interpreter one-liner
 * (`python -c "urllib…"`), a renamed binary or a computed command still
 * reach the network unseen.
 */
export interface ShellNetworkUse {
  /** What was found (`curl`, `git push`). */
  program: string;
  /** The egress class that allows it, `null` when no class does (ssh, nc). */
  cls: EgressClass | null;
}

const HTTP_CLIENTS = new Set([
  "curl", "wget", "wget2", "http", "https", "xh", "aria2c", "lwp-request",
  "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "start-bitstransfer", "bitsadmin",
]);
const RAW_CLIENTS = new Set(["ssh", "scp", "sftp", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "mosh"]);
const GIT_NETWORK_VERBS = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);
const PUBLISHERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const NESTED = new Set(NESTED_SHELL_PROGRAMS);

/** The command words after wrappers and `NAME=value` assignments. */
function unwrap(words: readonly string[]): readonly string[] {
  let i = 0;
  for (let guard = 0; guard < 16 && i < words.length; guard += 1) {
    const word = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    const valueFlags = PREFIX_COMMANDS[programName(word)];
    if (valueFlags === undefined) break;
    i += 1;
    while (i < words.length && words[i]!.startsWith("-")) {
      i += valueFlags.includes(words[i]!) ? 2 : 1;
    }
  }
  return words.slice(i);
}

function inSegment(words: readonly string[], depth: number): ShellNetworkUse | null {
  const command = unwrap(words);
  const first = command[0];
  if (first === undefined) return null;
  const program = programName(first);
  const rest = command.slice(1);
  if (HTTP_CLIENTS.has(program)) return { program, cls: "http" };
  if (RAW_CLIENTS.has(program)) return { program, cls: null };
  if (program === "gh") return { program, cls: "github" };
  if (program === "rsync") {
    // Only a remote operand (`host:path`, `rsync://`) leaves the machine.
    return rest.some((w) => !w.startsWith("-") && (/^[^/]*[^/\\:]:/.test(w) || /^rsync:\/\//i.test(w)))
      ? { program, cls: null }
      : null;
  }
  if (program === "git") {
    const found = findGitSubcommand(rest);
    if (found === null) return null;
    const next = rest[found.index + 1]?.toLowerCase();
    if (GIT_NETWORK_VERBS.has(found.verb)) return { program: `git ${found.verb}`, cls: "git" };
    if (found.verb === "remote" && next === "update") return { program: "git remote update", cls: "git" };
    if (found.verb === "submodule" && next === "update") return { program: "git submodule update", cls: "git" };
    return null;
  }
  if (PUBLISHERS.has(program) && rest.find((w) => !w.startsWith("-"))?.toLowerCase() === "publish") {
    return { program: `${program} publish`, cls: "http" };
  }
  if (depth > 3) return null;
  if (NESTED.has(program)) {
    for (const script of scanNestedShellOptions(rest, program).scripts) {
      const found = inLine(script, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (POWERSHELLS.has(program) || program === "cmd") {
    const at = rest.findIndex((w) => /^[-/](?:c|command|encodedcommand)$/i.test(w));
    if (at >= 0 && rest[at + 1] !== undefined) return inLine(rest.slice(at + 1).join(" "), depth + 1);
  }
  return null;
}

function inLine(line: string, depth: number): ShellNetworkUse | null {
  for (const segment of splitCommandSegments(line)) {
    const found = inSegment(segment, depth);
    if (found !== null) return found;
  }
  return null;
}

/** The first network client a `{cmd, args}` call would run, or `null`. */
export function shellNetworkUse(call: Record<string, unknown>): ShellNetworkUse | null {
  const cmd = typeof call.cmd === "string" ? call.cmd : "";
  const raw = call.args;
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // The shell tool refuses this shape itself.
    }
  }
  const args = list.map(String);
  if (args.length === 0) return inLine(cmd, 0);
  // A direct exec: the words are already split; only a nested shell's
  // script is a line to read.
  return inSegment([cmd, ...args], 0);
}
