import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { isTooBroadScope, tooBroadWorkdirMessage } from "../fusion/scope-path.js";
import { localFileOfUrl } from "../read-scope/read-scope-targets.js";
import { resolveVerifyCwd } from "./verify-authorization.js";
import type { VerifyRunArgs } from "./verify-run-args.js";

/** Where `verify.run` copies from, and the call's arguments relative to it. */
export type VerifyCopyRoot =
  | { ok: true; root: string; args: Record<string, unknown> }
  | { ok: false; message: string };

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function commonAncestor(dirs: readonly string[]): string {
  let common = dirs[0]!;
  for (const dir of dirs.slice(1)) {
    while (!inside(common, dir)) {
      const parent = dirname(common);
      if (parent === common) return common;
      common = parent;
    }
  }
  return common;
}

/** The nearest folder from `dir` up holding `.git`, strictly below `stop`. */
function gitRootBelow(dir: string, stop: string): string | null {
  for (let at = dir; inside(stop, at) && relative(stop, at) !== ""; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
  }
  return null;
}

/**
 * The folder a `verify.run` copy is rooted at (issue #53). A session in an
 * ordinary project folder copies that folder, as always. A session whose
 * folder is too broad to copy (a drive or filesystem root, the home folder
 * or its parent) never asks to copy it: the copy is rooted at the smallest
 * folder holding what the run needs (the page file's folder, the command's
 * cwd), widened to the git root when that lies inside a repository below
 * the session's folder. When that folder is itself too broad, the run is
 * refused up front with the project-folder message, before any approval.
 */
export function verifyCopyRoot(
  rawArgs: Record<string, unknown>,
  args: VerifyRunArgs,
  workingDir: string,
  home: string = homedir(),
): VerifyCopyRoot {
  if ((args.kind === "ui" && args.url !== undefined) || !isTooBroadScope(workingDir, home)) return { ok: true, root: workingDir, args: rawArgs };
  const refuse = (): VerifyCopyRoot => ({ ok: false, message: tooBroadWorkdirMessage(workingDir, "verify.run did not run: a verification copy") });
  let cwd: string;
  try {
    cwd = resolveVerifyCwd(workingDir, args.cwd);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const pageFile = args.kind !== "page" ? null
    : args.path !== undefined ? resolve(cwd, args.path)
    : args.url !== undefined ? localFileOfUrl(args.url) : null;
  // A command, a service and a started page run in `cwd`, and an explicit
  // `cwd` is always kept; an opened page otherwise needs only its folder.
  const needed = [
    ...(args.kind !== "page" || args.start !== undefined || pageFile === null || args.cwd !== undefined ? [cwd] : []),
    ...(pageFile === null ? [] : [dirname(pageFile)]),
  ];
  const common = commonAncestor(needed);
  const root = gitRootBelow(common, workingDir) ?? common;
  if (!inside(workingDir, root) || isTooBroadScope(root, home)) return refuse();
  const narrowed: Record<string, unknown> = { ...rawArgs };
  delete narrowed.cwd;
  if (inside(root, cwd) && relative(root, cwd) !== "") narrowed.cwd = relative(root, cwd);
  if (args.kind === "page" && args.path !== undefined && pageFile !== null) {
    narrowed.path = relative(inside(root, cwd) ? cwd : root, pageFile);
  }
  return { ok: true, root, args: narrowed };
}
