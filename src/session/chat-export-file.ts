import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getConfig, getSkillWriteProtectionPaths, getStateSecretPaths, getTrustConfigPaths } from "../config/index.js";
import { chatExportFilename, type ChatExportFormat, type ChatExportOptions } from "./chat-export.js";
import type { SessionState } from "./session-state.js";

export interface ChatExportRequest {
  readonly format: ChatExportFormat;
  readonly path: string | null;
  readonly force?: boolean;
  readonly incognitoConfirmed?: boolean;
  readonly error?: string;
}

const EXTENSION: Record<ChatExportFormat, string> = { markdown: ".md", html: ".html", docx: ".docx", pdf: ".pdf" };

export function resolveExportPath(state: SessionState, request: ChatExportRequest, cwd: string,
  home = homedir(), options: ChatExportOptions = {}): string {
  const fallback = chatExportFilename(state, request.format, options);
  if (request.path === null) {
    const path = join(cwd, fallback);
    const ext = extname(path);
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? path : `${path.slice(0, -ext.length)} (${n})${ext}`;
      if (!existsSync(candidate)) return candidate;
    }
    return path;
  }
  const typed = request.path.replace(/^~(?=$|[\\/])/, home);
  const full = isAbsolute(typed) ? typed : resolve(cwd, typed);
  let directory = /[\\/]$/.test(typed);
  try { directory ||= statSync(full).isDirectory(); } catch { /* The writer reports inaccessible paths. */ }
  return directory ? join(full, fallback) : extname(full) === "" ? `${full}${EXTENSION[request.format]}` : full;
}

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}

function inside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

function assertDestination(path: string, directory: string, workspaces: readonly string[]): void {
  const paths = getConfig().paths;
  const roots = [...new Set(workspaces.map(workspace => resolve(workspace)))];
  const entries = [paths.stateDir + sep, ...getStateSecretPaths(paths), ...getTrustConfigPaths(paths),
    ...getSkillWriteProtectionPaths(paths), ...roots.flatMap(root => [
      join(root, ".agents") + sep, join(root, ".claude") + sep,
      join(root, paths.projectSkillsDirName) + sep,
      join(root, ".cursor", "skills") + sep, join(root, ".pi", "skills") + sep,
      join(root, ".cursor", "rules") + sep,
      ...["AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".github/copilot-instructions.md"].map(file => join(root, file)),
    ])];
  for (const candidate of [resolve(path), directory, canonical(path)]) {
    for (const entry of entries) {
      const dir = /[\\/]$/.test(entry);
      const root = resolve(entry);
      if ([root, canonical(root)].some(protectedPath => dir ? inside(protectedPath, candidate) : relative(protectedPath, candidate) === "")) {
        throw new Error("protected state or trust export destination");
      }
    }
  }
}

/** Exclusive create, or an adjacent owner-only temporary file atomically replacing a regular destination. */
export function writeExportFile(path: string, body: string | Buffer, force: boolean, workspaces: readonly string[] = [process.cwd()]): string | null {
  let temporary: string | undefined;
  try {
    const directory = realpathSync.native(dirname(resolve(path)));
    assertDestination(path, directory, workspaces);
    const target = join(directory, basename(path));
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error("linked or non-regular export destination");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (force) {
      const next = join(directory, `.chat-export-${randomUUID()}.tmp`);
      const fd = openSync(next, "wx", 0o600);
      temporary = next; // Only clean up a file whose exclusive creation succeeded.
      try { writeFileSync(fd, body); } finally { closeSync(fd); }
      renameSync(temporary, target);
      temporary = undefined;
    } else writeFileSync(target, body, { flag: "wx", mode: 0o600 });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return `${path} already exists; use --force to overwrite it, or choose another --out`;
    return `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* Cleanup must not replace the write failure. */ }
    }
  }
}
