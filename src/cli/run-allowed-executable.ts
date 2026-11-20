import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * The program `run --allow-command` pins (issue #95, second review): the
 * real file the operator's first word names, resolved once at approval
 * time, so the shell tool spawns exactly it and never a `node` the model
 * planted in --cwd or reached through a relative or empty PATH entry.
 *
 * - A word with no path is looked up in PATH, using only entries that are
 *   absolute, exist and lie outside --cwd (real paths). The current folder
 *   and an empty entry are never used.
 * - On Windows only `.exe` and `.com` from PATHEXT are tried, in its
 *   order; a `.cmd` or `.bat` (run through cmd.exe) found first, or
 *   named by the word, refuses.
 * - A word with a path names that file (relative to --cwd).
 * - The real file must be a regular executable file outside --cwd;
 *   otherwise nothing is pinned and the call asks as any other.
 */
export interface ExecutableFs {
  /** A regular file the current user may execute (on Windows: exists). */
  isExecutableFile(path: string): boolean;
  /** The real path, or null when it cannot be resolved. */
  realpath(path: string): string | null;
}

export interface ResolveExecutableOptions {
  runDir: string;
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  fs?: ExecutableFs;
}

const nodeFs: ExecutableFs = {
  isExecutableFile(path) {
    try {
      if (!statSync(path).isFile()) return false;
      if (process.platform !== "win32") accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath(path) {
    try {
      return realpathSync.native(path);
    } catch {
      return null;
    }
  },
};

export function resolveAllowedExecutable(word: string, options: ResolveExecutableOptions): { file: string } | null {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeFs;
  const path = platform === "win32" ? win32 : posix;
  const realRunDir = fs.realpath(options.runDir);
  if (realRunDir === null) return null;
  const outsideRunDir = (real: string): boolean => {
    const fold = (p: string): string => (platform === "win32" ? p.toLowerCase() : p);
    const rel = path.relative(fold(realRunDir), fold(real));
    return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  const accept = (candidate: string): { file: string } | null => {
    if (!fs.isExecutableFile(candidate)) return null;
    const real = fs.realpath(candidate);
    if (real === null || !fs.isExecutableFile(real) || !outsideRunDir(real)) return null;
    return { file: real };
  };
  const scriptExt = /\.(cmd|bat)$/i;
  if (platform === "win32" && scriptExt.test(word)) return null;
  if (/[\\/]/.test(word)) {
    return accept(path.isAbsolute(word) ? word : path.resolve(options.runDir, word));
  }
  const entries = (options.env.PATH ?? options.env.Path ?? "").split(path.delimiter);
  const exts = platform === "win32" ? windowsExtensions(options.env.PATHEXT, word) : [""];
  for (const entry of entries) {
    if (entry.length === 0 || !path.isAbsolute(entry)) continue;
    const realEntry = fs.realpath(entry);
    if (realEntry === null || !outsideRunDir(realEntry)) continue;
    for (const ext of exts) {
      const candidate = path.join(entry, word + ext);
      if (!fs.isExecutableFile(candidate)) continue;
      // The first match is what a plain run would start: a script shim
      // there means cmd.exe, so nothing is pinned.
      if (scriptExt.test(candidate)) return null;
      return accept(candidate);
    }
  }
  return null;
}

/** PATHEXT's `.exe` and `.com` (and its `.cmd`/`.bat`, to refuse them), in order; "" when the word has its own `.exe`/`.com`. */
function windowsExtensions(pathext: string | undefined, word: string): string[] {
  if (/\.(exe|com)$/i.test(word)) return [""];
  const listed = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.length > 0);
  return listed.filter((ext) => [".exe", ".com", ".cmd", ".bat"].includes(ext));
}

