/**
 * Review of issue #67: which `projects.constraints` entry a folder falls
 * under, for the composer's provisional "restricted to: …" chip on a chat
 * the agent has not answered for yet (renderer/chat-restriction.js, IPC
 * `agent:folderConstraint`). The same rules as the agent's
 * `resolveProjectConstraint` (src/config/project-constraint-match.ts): each
 * path in its normalised form, its real path (a link above a folder that
 * does not exist yet resolves through its nearest existing ancestor) and,
 * for the folder, the main repository a linked git worktree stands for; the
 * deepest entry holding any of those forms wins. A port, not an import (the
 * desktop builds apart from the agent): test/folder-constraint.test.mjs runs
 * both on the same cases and must fail if they drift.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface FolderConstraintOptions {
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string | undefined;
  worktreeSource?: (path: string) => string | undefined;
}

export interface FolderConstraint {
  key: string;
  allowedProviders: string[];
  allowedEgress: string[];
}

interface ConstraintEntry {
  allowedProviders?: unknown;
  allowedEgress?: unknown;
}

/** The agent's normalizeConstraintPath. */
export function normalizeConstraintPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return posix.resolve(path).toLowerCase();
  if (platform !== "win32") return posix.resolve(path);
  let s = path.replace(/\//g, "\\");
  if (/^\\\\\?\\unc\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else if (s.startsWith("\\\\?\\")) s = s.slice(4);
  s = win32.resolve(s);
  if (s.length > win32.parse(s).root.length) s = s.replace(/\\+$/, "");
  return s.toLowerCase();
}

function contains(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = platform === "win32" ? win32 : posix;
  const rel = p.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function realForm(path: string, realpath: (p: string) => string | undefined, platform: NodeJS.Platform): string | undefined {
  const p = platform === "win32" ? win32 : posix;
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    const real = realpath(current);
    if (real !== undefined) return rest.length === 0 ? real : p.join(real, ...rest.reverse());
    const parent = p.dirname(current);
    if (parent === current) return undefined;
    rest.push(p.basename(current));
    current = parent;
  }
  return undefined;
}

function formsOf(path: string, options: Required<FolderConstraintOptions>, mapWorktree = false): string[] {
  const forms = new Set<string>([normalizeConstraintPath(path, options.platform)]);
  const real = realForm(path, options.realpath, options.platform);
  if (real !== undefined) forms.add(normalizeConstraintPath(real, options.platform));
  if (mapWorktree) {
    const source = options.worktreeSource(real ?? path);
    if (source !== undefined) for (const form of formsOf(source, options)) forms.add(form);
  }
  return [...forms];
}

const WORKTREE_GITDIR = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?\s*$/;

function defaultWorktreeSource(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const p = platform === "win32" ? win32 : posix;
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    const dotGit = p.join(current, ".git");
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return undefined;
      if (stat.isFile()) {
        const match = WORKTREE_GITDIR.exec(readFileSync(dotGit, "utf8").split(/\r?\n/, 1)[0] ?? "");
        if (match === null) return undefined;
        const repo = p.resolve(current, match[1]!);
        return rest.length === 0 ? repo : p.join(repo, ...rest.reverse());
      }
    } catch {
      // No `.git` here: look one level up.
    }
    const parent = p.dirname(current);
    if (parent === current) return undefined;
    rest.push(p.basename(current));
    current = parent;
  }
  return undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The entry `workingDir` falls under, or `null` (none, or no constraints). */
export function folderConstraintFor(
  constraints: unknown,
  workingDir: string,
  options: FolderConstraintOptions = {},
): FolderConstraint | null {
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints) || !workingDir) return null;
  const entries = Object.entries(constraints as Record<string, ConstraintEntry>);
  if (entries.length === 0) return null;
  const platform = options.platform ?? process.platform;
  const opts: Required<FolderConstraintOptions> = {
    platform,
    realpath: options.realpath ?? defaultRealpath,
    worktreeSource: options.worktreeSource ?? ((path) => defaultWorktreeSource(path, platform)),
  };
  const dirForms = formsOf(workingDir, opts, true);
  let best: (FolderConstraint & { length: number }) | null = null;
  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    let length = -1;
    for (const entryForm of formsOf(key, opts)) {
      if (dirForms.some((dir) => contains(entryForm, dir, opts.platform))) length = Math.max(length, entryForm.length);
    }
    if (length >= 0 && (best === null || length > best.length)) {
      best = { key, allowedProviders: strings(entry.allowedProviders), allowedEgress: strings(entry.allowedEgress), length };
    }
  }
  return best === null ? null : { key: best.key, allowedProviders: best.allowedProviders, allowedEgress: best.allowedEgress };
}
