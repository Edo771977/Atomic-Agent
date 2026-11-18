import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";

/**
 * Path forms shared by the read scope (`read-scope.ts`) and the temp
 * copy registry (`temp-copy-sources.ts`): canonical paths and the scratch
 * directories.
 */

/**
 * The realpath of the deepest existing ancestor with the rest appended,
 * so a path that does not exist yet still canonicalises.
 */
export function canonical(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}


/** Whether `path` is under any of `prefixes`, lexically or canonically. */
export function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  if (prefixes.some((prefix) => isInside(prefix, path))) return true;
  const real = canonical(path);
  return prefixes.some((prefix) => isInside(canonical(prefix), real));
}

/**
 * The OS temp directory, plus the conventional POSIX ones — macOS's
 * `os.tmpdir()` is a per-user folder, and models write to `/tmp`. Read
 * per call so a test (or an operator) steering `TMPDIR` is honoured.
 */
export function scratchDirs(): string[] {
  return process.platform === "win32"
    ? [tmpdir()]
    : [tmpdir(), "/tmp", "/var/tmp"];
}
