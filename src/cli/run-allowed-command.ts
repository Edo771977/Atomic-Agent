import { basename, isAbsolute, relative, resolve } from "node:path";

import type { ApprovalRequest } from "../approval/approval-gate.js";

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
 * words element by element. A line run through a shell is never
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

export function parseAllowedCommand(value: string): AllowedCommand | { error: string } {
  const argv = value.trim().split(/\s+/).filter((word) => word.length > 0);
  if (argv.length === 0) return { error: "--allow-command needs a command" };
  if (argv.some((word) => SHELL_SYNTAX_RE.test(word))) {
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
  if (dirs.length === 0 || !dirs.every((dir) => isAbsolute(dir) && inside(runDir, dir))) return false;
  return allowed.some((command) => sameWords(command.argv, argv));
}

function sameWords(allowed: readonly string[], words: readonly string[]): boolean {
  if (allowed.length !== words.length || allowed.length === 0) return false;
  return allowed.every((token, i) => (i === 0 ? commandName(token) === commandName(words[0]!) : token === words[i]));
}

/** argv[0] as a saved rule compares it (`approval-rules.ts`): basename, lowercased. */
function commandName(token: string): string {
  return basename(token).toLowerCase();
}

function inside(root: string, dir: string): boolean {
  const fold = (path: string): string => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  const rel = relative(fold(root), fold(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
