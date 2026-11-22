import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

export interface RipgrepResolverOptions {
  /** The active session or plan's project folder. */
  workingDir?: string;
  /** Override the runtime and filesystem inputs in tests. */
  execPath?: string;
  moduleDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sea?: boolean;
  fileExists?: (path: string) => boolean;
  realPath?: (path: string) => string | null;
}

/** Resolve again for each search because the untrusted project varies by session. */
export function resolveRipgrepPath(options: RipgrepResolverOptions = {}): string | null {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  const paths = windows ? win32 : posix;
  const binaryName = windows ? "rg.exe" : "rg";
  const realPath = options.realPath ?? defaultRealPath;
  const fileExists = options.fileExists ?? isExecutableFile;

  // Win32 treats \foo as absolute but still resolves it on the current drive.
  const absolute = (path: string): boolean =>
    paths.isAbsolute(path) && (!windows || paths.parse(path).root.length > 1);
  const inside = (root: string, path: string): boolean => {
    const relative = paths.relative(root, path);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative));
  };
  const cwd = options.cwd ?? process.cwd();
  const roots = [cwd, paths.resolve(cwd, options.workingDir ?? cwd)];
  const projectRoots = [...new Set(roots.flatMap((root) => [root, realPath(root) ?? root]))];
  const inProject = (path: string): boolean => projectRoots.some((root) => inside(root, path));

  const check = (candidate: string): string | null => {
    if (!absolute(candidate) || inProject(candidate)) return null;
    const parent = realPath(paths.dirname(candidate));
    if (parent !== null && inProject(parent)) return null;
    const canonical = realPath(candidate);
    if (canonical === null || !absolute(canonical) || inProject(canonical)) return null;
    if (windows && paths.extname(canonical).toLowerCase() !== ".exe") return null;
    return fileExists(canonical) ? canonical : null;
  };

  // Only a SEA has the vendor directory beside its executable. In source and
  // compiled builds the resolver is two directories below the agent's root.
  const sea = options.sea ?? isSea();
  const installRoot = sea
    ? paths.dirname(options.execPath ?? process.execPath)
    : paths.join(options.moduleDir ?? paths.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const bundled = sea
    ? paths.join(installRoot, "vendor", binaryName)
    : paths.join(installRoot, "node_modules", "@vscode", "ripgrep", "bin", binaryName);
  const installed = check(bundled);
  if (installed !== null) return installed;

  const searchPath = env.PATH ?? env.Path ?? env.path ?? "";
  for (const directory of searchPath.split(paths.delimiter)) {
    if (!absolute(directory)) continue;
    const found = check(paths.join(directory, binaryName));
    if (found !== null) return found;
  }
  return null;
}

function defaultRealPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const RIPGREP_MISSING_HINT =
  "ripgrep (`rg`) was not found. Install it via `brew install ripgrep`, `apt install ripgrep`, or `choco install ripgrep`, and put its directory on PATH using an absolute path outside the project.";
