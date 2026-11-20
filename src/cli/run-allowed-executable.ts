import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
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
  /** The file's first bytes as text (its `#!` line), or null. */
  readHead?(path: string): string | null;
}

/** The program file to pin, and the PATH its child is given (`safeEntries`). */
export interface PinnedProgram {
  file: string;
  path: string;
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
  readHead(path) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(256);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString("latin1");
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

/** Why nothing was pinned, said to the model (issue #95, third review). */
export interface NotPinned {
  refused: string;
}

export function resolveAllowedExecutable(word: string, options: ResolveExecutableOptions): PinnedProgram | NotPinned {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeFs;
  const path = platform === "win32" ? win32 : posix;
  const realRunDir = fs.realpath(options.runDir);
  if (realRunDir === null) return { refused: "the run's folder cannot be resolved" };
  const outsideRunDir = (real: string): boolean => {
    const fold = (p: string): string => (platform === "win32" ? p.toLowerCase() : p);
    const rel = path.relative(fold(realRunDir), fold(real));
    return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  // The only PATH the pinned child gets too (issue #95, third review):
  // a `#!/usr/bin/env node` script must find its interpreter here, never
  // through `.`, an empty entry or a folder inside --cwd.
  const safeEntries: string[] = [];
  for (const entry of (options.env.PATH ?? options.env.Path ?? "").split(path.delimiter)) {
    if (entry.length === 0 || !path.isAbsolute(entry)) continue;
    const realEntry = fs.realpath(entry);
    if (realEntry === null || !outsideRunDir(realEntry) || safeEntries.includes(realEntry)) continue;
    safeEntries.push(realEntry);
  }
  const safePath = safeEntries.join(path.delimiter);
  const accept = (candidate: string): PinnedProgram | NotPinned => {
    const real = fs.isExecutableFile(candidate) ? fs.realpath(candidate) : null;
    if (real === null || !fs.isExecutableFile(real)) return { refused: `\`${word}\` is not an executable file` };
    if (!outsideRunDir(real)) return { refused: `\`${word}\` resolves to a file inside the project folder` };
    if (platform !== "win32" && !interpreterOutside(fs.readHead?.(real) ?? null, fs, path, outsideRunDir)) {
      return { refused: `the #! interpreter of \`${word}\` is inside the project folder or not an absolute path` };
    }
    return { file: real, path: safePath };
  };
  const shim: NotPinned = { refused: `\`${word}\` resolves to a .cmd or .bat script, which runs through cmd.exe` };
  const scriptExt = /\.(cmd|bat)$/i;
  if (platform === "win32" && scriptExt.test(word)) return shim;
  if (/[\\/]/.test(word)) {
    return accept(path.isAbsolute(word) ? word : path.resolve(options.runDir, word));
  }
  const exts = platform === "win32" ? windowsExtensions(options.env.PATHEXT, word) : [""];
  for (const entry of safeEntries) {
    for (const ext of exts) {
      const candidate = path.join(entry, word + ext);
      if (!fs.isExecutableFile(candidate)) continue;
      // The first match is what a plain run would start: a script shim
      // there means cmd.exe, so nothing is pinned.
      if (scriptExt.test(candidate)) return shim;
      return accept(candidate);
    }
  }
  return { refused: `no program outside the project folder is named \`${word}\` on PATH` };
}

/**
 * A `#!` line's interpreter must be an absolute file outside --cwd; for
 * `#!/usr/bin/env name` the name is looked up on the pinned PATH, so a
 * bare name is fine, but a path in it follows the same rule. Not a
 * script (no `#!`): nothing to check.
 */
function interpreterOutside(
  head: string | null,
  fs: ExecutableFs,
  path: typeof posix,
  outside: (real: string) => boolean,
): boolean {
  if (head === null || !head.startsWith("#!")) return true;
  const words = head.slice(2).split(/\r?\n/)[0]!.trim().split(/\s+/).filter((w) => w.length > 0);
  const interpreter = words[0];
  if (interpreter === undefined) return false;
  const fileOutside = (file: string): boolean => {
    if (!path.isAbsolute(file)) return false;
    const real = fs.realpath(file);
    return real !== null && outside(real);
  };
  if (!fileOutside(interpreter)) return false;
  if (path.basename(interpreter) !== "env") return true;
  const program = words.slice(1).find((w) => !w.startsWith("-") && !w.includes("="));
  if (program === undefined) return false;
  return /\//.test(program) ? fileOutside(program) : true;
}

/** PATHEXT's `.exe` and `.com` (and its `.cmd`/`.bat`, to refuse them), in order; "" when the word has its own `.exe`/`.com`. */
function windowsExtensions(pathext: string | undefined, word: string): string[] {
  if (/\.(exe|com)$/i.test(word)) return [""];
  const listed = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.length > 0);
  return listed.filter((ext) => [".exe", ".com", ".cmd", ".bat"].includes(ext));
}

