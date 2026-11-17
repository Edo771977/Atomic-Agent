import { dirname, isAbsolute } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { DelegateTask } from "./delegate-args.js";
import { comparableScopePath, isTooBroadScope } from "./scope-path.js";

/**
 * Where a fan-out is about to write — the directory the operator is
 * asked about once, and the scope its workers then inherit.
 *
 * There is no field that states this, so it is derived, in this order:
 *
 * 1. **`task.files`.** The brief's own list of paths. This is the answer
 *    when the orchestrator fills it in, and the `### fusion` guidance now
 *    tells it to.
 * 2. **Paths written in the instructions.** In the session that exposed
 *    all of this, the orchestrator put every path in prose —
 *    `"Write two files: /tmp/rel-2/cart.js …"` — and left `files` empty.
 *    Refusing to read that would have meant no scope and no fix, so a
 *    deliberately strict pattern picks absolute paths out of the text.
 * 3. **The working directory**, as the floor. A fan-out that names
 *    nothing still needs somewhere to work.
 *
 * Then the directories are collapsed to their shallowest members, so a
 * fan-out writing `/tmp/x/a.js` and `/tmp/x/sub/b.js` is one scope, not
 * two.
 */

/**
 * Absolute paths, or `./`-relative ones carrying a file extension.
 *
 * Strict on purpose. This runs over a model's prose, where a loose
 * pattern would find version numbers, package names and sentence
 * fragments, and every false positive widens what the operator is about
 * to authorise. A miss is cheap — the working directory still floors the
 * scope — so the pattern errs towards missing.
 */
const PATH_IN_PROSE =
  /(?:^|[\s"'`(])((?:\/|\.\/|~\/)[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8})/g;

// Keep the same conservative filename/extension rule on Windows. A drive
// must be qualified (C:notes.ts is relative), and UNC names include a share.
// URLs and version numbers must not silently widen an approval scope.
const WINDOWS_PATH_IN_PROSE =
  /(?:^|[\s"'`(])((?:[A-Za-z]:[\\/]|[\\/]{2}[\w.@+-]+[\\/][\w.@+-]+[\\/]|\.\\|~\\)[\w.@+-]+(?:[\\/][\w.@+-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),;])/g;

/** Roots too broad to hand to a fan-out, however the brief was written. */
function isTooBroad(dir: string): boolean {
  return isTooBroadScope(dir);
}

function collectFromText(text: string, workingDir: string, unresolved?: { count: number }): string[] {
  const out: string[] = [];
  const patterns = process.platform === "win32"
    ? [PATH_IN_PROSE, WINDOWS_PATH_IN_PROSE]
    : [PATH_IN_PROSE];
  for (const match of patterns.flatMap((pattern) => [...text.matchAll(pattern)])) {
    const raw = match[1];
    if (raw === undefined) continue;
    try {
      out.push(resolveUserPath(raw, workingDir));
    } catch {
      // `resolveUserPath` throws only on a Unix-absolute path under
      // Windows. A path we cannot resolve is a path we will not grant.
      if (unresolved !== undefined) unresolved.count += 1;
    }
  }
  return out;
}

/**
 * Collapse directories to the shallowest that cover them all, and drop
 * anything too broad to authorise.
 */
export function collapseScope(dirs: readonly string[]): string[] {
  const comparable = dirs.map(comparableScopePath).filter((dir): dir is string => dir !== null);
  const unique = [...new Set(comparable)].filter((dir) => !isTooBroad(dir));
  const roots: string[] = [];
  for (const dir of unique.sort((a, b) => a.length - b.length)) {
    if (!roots.some((root) => isInside(root, dir))) roots.push(dir);
  }
  return roots;
}

/**
 * The directories a fan-out may write in, or an empty array when the
 * brief gives nothing safe to grant — in which case the workers keep
 * asking (and being refused), which the operator sees immediately as
 * every task coming back `needs_orchestrator`.
 */
export function resolveFanoutScope(
  tasks: readonly DelegateTask[],
  workingDir: string,
): string[] {
  return analyseFanoutScope(tasks, workingDir).scope;
}

/**
 * The fan-out's write scope plus whether the briefs named a path that
 * scope leaves out: one that cannot be resolved here (a Unix-absolute
 * path under Windows) or whose directory is too broad to grant (a drive
 * or filesystem root, the home folder or its parent). For the ordinary
 * prompt a miss is cheap, since the person still answers it; a decision
 * that skips the prompt (an approved project plan, issue #39) must treat
 * such a brief as writing outside the approved folder.
 */
export function analyseFanoutScope(
  tasks: readonly DelegateTask[],
  workingDir: string,
): { scope: string[]; namesUngrantedPath: boolean } {
  const paths: string[] = [];
  const unresolved = { count: 0 };
  for (const task of tasks) {
    for (const file of task.files ?? []) {
      try {
        paths.push(resolveUserPath(file, workingDir));
      } catch {
        // See `collectFromText`.
        unresolved.count += 1;
      }
    }
    paths.push(...collectFromText(task.instructions, workingDir, unresolved));
    if (task.deliverable) {
      paths.push(...collectFromText(task.deliverable, workingDir, unresolved));
    }
  }
  const dirs = paths.map((path) => (isAbsolute(path) ? dirname(path) : path));
  const tooBroad = dirs.some((dir) => {
    const comparable = comparableScopePath(dir);
    return comparable === null || isTooBroad(comparable);
  });
  dirs.push(workingDir);
  return { scope: collapseScope(dirs), namesUngrantedPath: unresolved.count > 0 || tooBroad };
}
