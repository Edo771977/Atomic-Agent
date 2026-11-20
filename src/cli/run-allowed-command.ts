import { basename, isAbsolute, relative, resolve } from "node:path";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { shellRuleSegments, shellRunsUnreadableScript } from "../tools/os/shell/shell-command-argv.js";

/**
 * `run --allow-command "<exact command>"` (issue #95): a command the
 * operator agreed on beforehand (the project's test command) that a
 * non-interactive run may execute without asking, and nothing else.
 *
 * The value is parsed into words the way a saved approval rule reads a
 * shell command (`shellRuleSegments`), and it must be one simple
 * command: a compound line, a pipeline, a wrapper (`env X=1 …`) or a
 * script fed to a shell is refused, since its words would not say what
 * runs. A request matches only when it is that one command, word for
 * word (argv[0] by basename, lowercased, as a rule compares it), as
 * `os.shell.run` or a plain `verify.run` command check, classed `shell`
 * (never `shell_dangerous`), run in the run's `--cwd` or below.
 */
export interface AllowedCommand {
  argv: string[];
}

export function parseAllowedCommand(value: string): AllowedCommand | { error: string } {
  const line = value.trim();
  if (line.length === 0) return { error: "--allow-command needs a command" };
  const segments = shellRuleSegments(line, [], true);
  if (segments.length !== 1 || segments[0]!.length === 0 || shellRunsUnreadableScript(line, [], true)) {
    return { error: `--allow-command takes one simple command (no ;, &&, |, redirects or wrappers): ${value}` };
  }
  return { argv: segments[0]! };
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
  } else if (request.tool !== "os.shell.run") {
    return false;
  }
  if (request.commandUnreadable === true) return false;
  const segments = request.commandSegments;
  if (segments === undefined || segments.length !== 1) return false;
  const words = segments[0]!;
  const dirs = request.affectedResources ?? [];
  if (dirs.length === 0 || !dirs.every((dir) => isAbsolute(dir) && inside(runDir, dir))) return false;
  return allowed.some((command) => sameWords(command.argv, words));
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
