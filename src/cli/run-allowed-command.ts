import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type { ApprovalRequest, PinnedExec } from "../approval/approval-gate.js";
import { needsShellInterpretation } from "../tools/os/shell/shell-interpretation.js";
import { resolveAllowedExecutable } from "./run-allowed-executable.js";

/**
 * `run --allow-command "<exact command>"` (issue #95): a command the
 * operator agreed on beforehand (the project's test command) that a
 * non-interactive run may execute without asking, and nothing else.
 *
 * Only a direct exec is ever pre-approved: the request must carry the
 * argv that will run (`commandArgv`) and say no shell reads it and no
 * glob was expanded (`literalExec` from `os.shell.run`, or a plain
 * `verify.run` command check, `verifyPlainCommand`), name no file it
 * would write (`targetPaths`), and that argv must equal the operator's
 * words element by element, argv[0] included (`sameWords`). A line run through a shell is never
 * matched, whatever its first words: a redirect, `&`, a `#` comment or a
 * substitution there runs more than the words say (`commandSegments` is
 * a best reading, safe only for rules that tighten).
 *
 * The value is split on whitespace only, so it cannot hold quotes or
 * shell syntax: a character a shell or cmd.exe would read specially is
 * refused rather than guessed at.
 */
export interface AllowedCommand {
  argv: string[];
}

/** Characters a shell (or cmd.exe for a `.cmd` shim) reads specially. */
const SHELL_SYNTAX_RE = /[|&;<>()$`"'*?[\]{}~#!^%\r\n]/;

/** Printable ASCII only: a match never depends on Unicode case folding or look-alikes. */
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

export function parseAllowedCommand(value: string): AllowedCommand | { error: string } {
  // Spaces and printable ASCII only: a no-break space is not a separator here.
  if (!/^[\x20-\x7e]*$/.test(value)) {
    return { error: `--allow-command takes printable ASCII words separated by spaces: ${value}` };
  }
  const argv = value.trim().split(/ +/).filter((word) => word.length > 0);
  if (argv.length === 0) return { error: "--allow-command needs a command" };
  if (argv.some((word) => SHELL_SYNTAX_RE.test(word) || !PRINTABLE_ASCII_RE.test(word))) {
    return {
      error: `--allow-command takes one plain command, words separated by spaces (no quotes, globs, ;, &, |, redirects or other shell syntax): ${value}`,
    };
  }
  return { argv };
}

export function allowedCommandMatches(
  request: ApprovalRequest,
  allowed: readonly AllowedCommand[],
  runDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (allowed.length === 0) return false;
  if (request.category !== "shell") return false;
  if (request.tool === "verify.run") {
    if (request.verifyPlainCommand !== true) return false;
  } else if (request.tool === "os.shell.run") {
    if (request.literalExec !== true) return false;
  } else {
    return false;
  }
  if (request.commandUnreadable === true) return false;
  if ((request.targetPaths ?? []).length > 0) return false;
  const argv = request.commandArgv;
  if (argv === undefined || argv.length === 0) return false;
  const dirs = request.affectedResources ?? [];
  if (dirs.length === 0 || !dirs.every((dir) => isAbsolute(dir) && inside(runDir, dir, platform))) return false;
  return allowed.some((command) => sameWords(command.argv, argv, platform));
}

/**
 * Element by element. argv[0] is the operator's first word exactly, not
 * a basename (`./node` or `/tmp/x/node` is another program); only on
 * Windows, where program names ignore case, is it compared folded, and
 * a path is still a path there.
 */
/**
 * What the CLI approves for a matching request (issue #95, second
 * review): the real program the first word resolves to
 * (`resolveAllowedExecutable`), the call's argv and its real folder, or
 * null when it does not match, nothing safe resolves, or the program
 * could only be started through a shell. The tool spawns exactly this.
 */
export function pinAllowedCommand(
  request: ApprovalRequest,
  allowed: readonly AllowedCommand[],
  runDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): PinnedExec | null {
  if (!allowedCommandMatches(request, allowed, runDir, platform)) return null;
  const argv = request.commandArgv!;
  const program = resolveAllowedExecutable(argv[0]!, { runDir, env, platform });
  if (program === null) return null;
  if (needsShellInterpretation(program.file, argv.slice(1))) return null;
  let cwd: string;
  try {
    cwd = realpathSync.native(request.affectedResources![0]!);
  } catch {
    return null;
  }
  return { file: program.file, argv: [...argv], cwd, path: program.path };
}

/** Lowercase A-Z only (no Unicode folding: U+212A KELVIN SIGN is not `k`). */
function asciiLower(word: string): string {
  return word.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function sameWords(allowed: readonly string[], words: readonly string[], platform: NodeJS.Platform): boolean {
  if (allowed.length !== words.length || allowed.length === 0) return false;
  if (!words.every((word) => PRINTABLE_ASCII_RE.test(word))) return false;
  const first = words[0]!;
  const wanted = allowed[0]!;
  if (!/[\\/]/.test(wanted) && /[\\/]/.test(first)) return false;
  const sameFirst = platform === "win32" ? asciiLower(wanted) === asciiLower(first) : wanted === first;
  return sameFirst && allowed.every((token, i) => i === 0 || token === words[i]);
}

/**
 * `dir` is `root` or below once both are real paths (a link out of the
 * folder is outside it); a path that cannot be resolved fails closed.
 */
function inside(root: string, dir: string, platform: NodeJS.Platform): boolean {
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync.native(root);
    realDir = realpathSync.native(dir);
  } catch {
    return false;
  }
  const fold = (path: string): string => (platform === "win32" ? path.toLowerCase() : path);
  const rel = relative(fold(realRoot), fold(realDir));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}
