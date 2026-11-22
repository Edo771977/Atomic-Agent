import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactOutcome } from "./artifact-process.js";

export const MAX_EXPECTED_FILES = 32;
export const MAX_CHANGED_PATHS = 1024;

export function isWithin(root: string, target: string): boolean {
  const name = relative(root, target);
  return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

async function entryType(root: string, target: string): Promise<"file" | "dir" | undefined> {
  if (!isWithin(root, target)) return undefined;
  let at = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    at = resolve(at, part);
    const entry = await lstat(at);
    if (entry.isSymbolicLink()) return undefined;
  }
  if (await realpath(target) !== target) return undefined;
  const entry = await lstat(target);
  return entry.isFile() ? "file" : entry.isDirectory() ? "dir" : undefined;
}

export async function evaluateFiles(root: string, cwd: string, expected: readonly string[], within?: string, changes?: readonly string[]): Promise<ArtifactOutcome> {
  const project = await realpath(root);
  const base = resolve(project, cwd);
  const failures: string[] = [];
  const unknown: string[] = [];
  const check = async (name: string, wanted?: string) => {
    try {
      const type = await entryType(project, resolve(base, name));
      if (type === undefined || (wanted !== undefined && wanted !== type)) {
        failures.push(`expected ${wanted ?? "file or directory"} at ${name}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") failures.push(`missing ${name}`);
      else unknown.push(`could not inspect ${name}`);
    }
  };
  for (const item of expected) {
    const [first, name] = item.split(":", 2);
    await check(name ?? first!, name === undefined ? undefined : first);
  }
  if (within !== undefined) {
    await check(within, "dir");
    const boundary = resolve(base, within);
    if (changes === undefined) unknown.push("within uncheckable: changed paths are unknown");
    else if (changes.length > MAX_CHANGED_PATHS) unknown.push(`within uncheckable: more than ${MAX_CHANGED_PATHS} changed paths`);
    else {
      let outside = 0;
      for (const path of changes) {
        const target = resolve(project, path);
        if (target !== boundary && isWithin(boundary, target) && isWithin(project, target)) continue;
        if (++outside <= 8) failures.push(`changed path outside ${within}: ${path}`);
      }
      if (outside > 8) failures.push(`and ${outside - 8} more changed paths outside ${within}`);
    }
  }
  return {
    status: failures.length ? "fail" : unknown.length ? "uncheckable" : "pass",
    detail: [...failures, ...unknown].join("\n") || `${expected.length} expected entries found${within === undefined ? "" : `; changed paths inside ${within}`}`,
  };
}
