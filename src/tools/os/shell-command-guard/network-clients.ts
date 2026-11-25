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
const HTTP_CLI = new Set(["http", "https", "xh"]);
const URL_CLIENTS = new Set([...HTTP_CLI, "aria2c", "curl", "wget", "wget2", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);
const RAW_CLIENTS = new Set(["ssh", "scp", "sftp", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "mosh"]);
const GIT_NETWORK_VERBS = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);
const PUBLISHERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const SHELL_PREFIX_WORDS = new Set(["{", "then", "do", "else", "elif", "if", "while", "until", "!"]);
const NESTED = new Set(NESTED_SHELL_PROGRAMS);

/** The command words after wrappers and `NAME=value` assignments. */
function unwrap(words: readonly string[], shellSyntax: boolean): readonly string[] {
  let i = 0;
  for (let guard = 0; guard < 16 && i < words.length; guard += 1) {
    const word = words[i]!;
    if ((shellSyntax && SHELL_PREFIX_WORDS.has(word)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    const program = programName(word);
    if (program === "busybox" && programName(words[i + 1] ?? "") === "wget") {
      i += 1;
      continue;
    }
    const cpuWrapper = program === "taskset" || program === "chrt";
    const valueFlags = cpuWrapper
      ? ["-T", "-P", "-D", "--sched-runtime", "--sched-period", "--sched-deadline"]
      : PREFIX_COMMANDS[program];
    if (valueFlags === undefined) break;
    i += 1;
    while (i < words.length && words[i]!.startsWith("-")) {
      if (words[i] === "--") {
        i += 1;
        break;
      }
      i += valueFlags.includes(words[i]!) ? 2 : 1;
    }
    if (cpuWrapper || program === "timeout" || program === "gtimeout") i += 1;
  }
  return words.slice(i);
}

const curlShortOperands = new Set("AbcCdDeEFHKmoPQrTtUuwxXyYz".split(""));

const curlLongOperands = new Set([
  "--output", "--output-dir", "--upload-file", "--header", "--proxy-header", "--user-agent",
  "--cookie", "--cookie-jar", "--user", "--proxy-user", "--referer", "--resolve", "--connect-to",
  "--request", "--request-target", "--form", "--form-string", "--dump-header", "--write-out",
  "--cacert", "--capath", "--cert", "--key", "--pass", "--proxy", "--preproxy", "--noproxy",
  "--connect-timeout", "--max-time", "--retry", "--retry-delay", "--retry-max-time", "--interface",
  "--range", "--oauth2-bearer", "--netrc-file", "--trace", "--trace-ascii", "--stderr", "--proto", "--proto-redir",
]);

const wgetLongOperands = new Set([
  "--output-document", "--output-file", "--append-output", "--header", "--user-agent", "--load-cookies",
  "--save-cookies", "--user", "--password", "--http-user", "--http-password", "--referer", "--post-data",
  "--post-file", "--body-data", "--body-file", "--input-file", "--directory-prefix", "--timeout", "--tries",
]);
const wgetShortOperands = new Set("OoaUiPtTwQleABXIDR");
const httpOperands = new Set([
  "--output", "-o", "--auth", "-a", "--auth-type", "-A", "--proxy", "--verify", "--cert", "--cert-key",
  "--timeout", "--session", "--session-read-only", "--style", "--pretty", "--print", "-p",
]);
const ariaOperands = new Set([
  "--out", "-o", "--dir", "-d", "--header", "--user-agent", "--load-cookies", "--save-cookies",
  "--http-user", "--http-passwd", "--referer", "--all-proxy", "--input-file", "-i", "--conf-path",
]);
const powershellOperands = new Set([
  "-outfile", "-infile", "-headers", "-useragent", "-credential", "-authentication", "-token",
  "-method", "-body", "-contenttype", "-proxy", "-proxycredential", "-websession", "-sessionvariable",
  "-timeoutsec", "-maximumredirection",
]);

function clientOperands(program: string, args: readonly string[]): string[] {
  const wget = program.startsWith("wget");
  const powershell = !wget && program !== "aria2c" && !HTTP_CLI.has(program);
  const valueFlags = wget ? wgetLongOperands
    : program === "aria2c" ? ariaOperands : powershell ? powershellOperands : httpOperands;
  const operands: string[] = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (options && word === "--") {
      options = false;
    } else if (options && word.startsWith("-")) {
      const separator = powershell ? /[:=]/ : /=/;
      const split = word.search(separator);
      const flag = split < 0 ? word : word.slice(0, split);
      const name = powershell ? flag.toLowerCase() : flag;
      if (name === "-uri" || name === "--url") {
        const value = split < 0 ? args[++index] : word.slice(split + 1);
        if (value !== undefined) operands.push(value);
      } else if (valueFlags.has(name)) {
        if (split < 0) index++;
      } else if (wget && /^-[^-]/.test(word)) {
        const valueAt = [...word].findIndex((short, offset) => offset > 0 && wgetShortOperands.has(short));
        if (valueAt === word.length - 1) index++;
      }
    } else {
      operands.push(word);
    }
  }
  return operands;
}

function curlUrlOptions(args: readonly string[]): { sendsData: boolean; hasConfig: boolean; operands: string[] } {
  let get = false;
  let data = false;
  let query = false;
  let hasConfig = false;
  let options = true;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (options && word === "--") {
      options = false;
    } else if (options && word.startsWith("--")) {
      const equals = word.indexOf("=");
      const flag = equals < 0 ? word : word.slice(0, equals);
      if (flag === "--get") get = true;
      if (flag === "--url-query") query = true;
      if (flag === "--config") hasConfig = true;
      const isData = /^(?:--data(?:-[a-z]+)?|--json)$/.test(flag);
      data ||= isData;
      if (flag === "--url" || flag === "--url-query" || flag === "--config" || isData || curlLongOperands.has(flag)) {
        const value = equals < 0 ? args[++index] : word.slice(equals + 1);
        if (flag === "--url" && value !== undefined) operands.push(value);
      }
    } else if (options && /^-[^-]/.test(word)) {
      for (let offset = 1; offset < word.length; offset++) {
        const short = word[offset]!;
        if (short === "G") get = true;
        if (short === "d") data = true;
        if (short === "K") hasConfig = true;
        if (curlShortOperands.has(short)) {
          if (offset === word.length - 1) index++;
          break;
        }
      }
    } else {
      operands.push(word);
    }
  }
  return { sendsData: query || (get && data), hasConfig, operands };
}

function inSegment(words: readonly string[], depth: number, urls?: Map<string, boolean>, shellSyntax = false): ShellNetworkUse | null {
  const command = unwrap(words, shellSyntax);
  const first = command[0];
  if (first === undefined) return null;
  const program = programName(first);
  const rest = command.slice(1);
  if (HTTP_CLIENTS.has(program)) {
    if (urls && URL_CLIENTS.has(program)) {
      const curl = program === "curl" ? curlUrlOptions(rest) : undefined;
      if (curl?.hasConfig) urls.set("", true);
      const httpCli = HTTP_CLI.has(program);
      const words = curl?.operands ?? clientOperands(program, rest);
      const httpQuery = httpCli && words.some(word => /^[^:=\s]+==/.test(word));
      const scheme = program === "https" ? "https" : "http";
      for (const word of words) {
        const operand = word.replace(/^(?:--url=|-uri[:=])/i, "");
        if (program === "curl" && /^(?:https?:\/\/)?[^/?#]*[$`]/i.test(operand)) {
          urls.set("", true);
          continue;
        }
        const destination = httpCli && /^:\d+(?:[/?#]|$)/.test(operand) ? `localhost${operand}` : operand;
        const url = /^https?:\/\//i.test(operand)
          ? operand
          : (program === "curl" || program.startsWith("wget") || httpCli || program === "aria2c") && /^(?:(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?|[a-z0-9-]+:\d+)(?:[/?#]|$)/i.test(destination)
            ? `${scheme}://${destination}`
            : null;
        if (url !== null) {
          urls.set(url, httpQuery || curl?.sendsData === true || (program === "curl" && /[$`]/.test(operand)) || urls.get(url) === true);
          if (httpCli) break;
        }
      }
    }
    return { program, cls: "http" };
  }
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
    if (GIT_NETWORK_VERBS.has(found.verb)) {
      if (urls) for (const word of rest.slice(found.index + 1)) if (/^https?:\/\//i.test(word)) urls.set(word, false);
      return { program: `git ${found.verb}`, cls: "git" };
    }
    if (found.verb === "remote" && next === "update") return { program: "git remote update", cls: "git" };
    if (found.verb === "submodule" && next === "update") return { program: "git submodule update", cls: "git" };
    return null;
  }
  if (PUBLISHERS.has(program) && rest.find((w) => !w.startsWith("-"))?.toLowerCase() === "publish") {
    return { program: `${program} publish`, cls: "http" };
  }
  if (depth > 3) return null;
  if (NESTED.has(program)) {
    let firstUse: ShellNetworkUse | null = null;
    for (const script of scanNestedShellOptions(rest, program).scripts) {
      const found = inLine(script, depth + 1, urls);
      firstUse ??= found;
      if (!urls && firstUse !== null) break;
    }
    return firstUse;
  }
  if (POWERSHELLS.has(program) || program === "cmd") {
    const at = rest.findIndex((w) => /^[-/](?:c|command|encodedcommand)$/i.test(w));
    if (at >= 0 && rest[at + 1] !== undefined) return inLine(rest.slice(at + 1).join(" "), depth + 1, urls);
  }
  return null;
}

function inLine(line: string, depth: number, urls?: Map<string, boolean>): ShellNetworkUse | null {
  let firstUse: ShellNetworkUse | null = null;
  for (const segment of splitCommandSegments(line)) {
    const found = inSegment(segment, depth, urls, true);
    firstUse ??= found;
    if (!urls && firstUse !== null) break;
  }
  return firstUse;
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

/** Explicit HTTP URLs passed to classified shell HTTP clients. */
export function shellNetworkUrls(cmd: string, args: readonly string[], shellLine?: string): Map<string, boolean> {
  const urls = new Map<string, boolean>();
  if (shellLine === undefined) inSegment([cmd, ...args], 0, urls);
  else inLine(shellLine, 0, urls);
  return urls;
}
