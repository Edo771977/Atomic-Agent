import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { sameProjectFolder } from "./project-folder.js";

/**
 * The folders this machine knows hold a fusion project (issue #109):
 * `<stateDir>/projects/registry.json`, paths only. Each project's content
 * stays in its folder; `atomic-agent projects list` reads it from there.
 */

export const PROJECT_REGISTRY_VERSION = 1;

export function projectRegistryPath(stateDir: string): string {
  return join(stateDir, "projects", "registry.json");
}

export type RegistryRead = { ok: true; folders: string[] } | { ok: false; message: string };

export function readProjectRegistry(stateDir: string): RegistryRead {
  const file = projectRegistryPath(stateDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, folders: [] };
    return { ok: false, message: `${file} could not be read: ${(err as Error).message}` };
  }
  try {
    const raw = JSON.parse(text) as { version?: unknown; folders?: unknown };
    if (raw.version !== PROJECT_REGISTRY_VERSION || !Array.isArray(raw.folders) || !raw.folders.every((f) => typeof f === "string")) {
      return { ok: false, message: `${file} is not a version ${PROJECT_REGISTRY_VERSION} project list; it was left as it is.` };
    }
    return { ok: true, folders: raw.folders as string[] };
  } catch (err) {
    return { ok: false, message: `${file} is not valid JSON (${(err as Error).message}); it was left as it is.` };
  }
}

function writeRegistry(stateDir: string, folders: readonly string[]): void {
  const file = projectRegistryPath(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: PROJECT_REGISTRY_VERSION, folders }, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Remember `folder`; a damaged list is never overwritten. Returns whether it was added. */
export function registerProjectFolder(stateDir: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  const read = readProjectRegistry(stateDir);
  if (!read.ok) return false;
  const absolute = resolve(folder);
  if (read.folders.some((f) => sameProjectFolder(f, absolute, platform))) return false;
  try {
    writeRegistry(stateDir, [...read.folders, absolute]);
    return true;
  } catch {
    // The list is a convenience: the project itself is in its folder.
    return false;
  }
}

/** Forget `folder` (its project stays in the folder). Returns whether it was listed. */
export function forgetProjectFolder(stateDir: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  const read = readProjectRegistry(stateDir);
  if (!read.ok) return false;
  const kept = read.folders.filter((f) => !sameProjectFolder(f, folder, platform));
  if (kept.length === read.folders.length) return false;
  writeRegistry(stateDir, kept);
  return true;
}
