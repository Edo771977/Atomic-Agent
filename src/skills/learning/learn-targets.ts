import { readdir } from "node:fs/promises";
import type { SkillRecord } from "../skill-loader.js";

export interface LearnTargetInput {
  /** Every parsed skill, including disabled ones (`SkillRegistry.listAll`). */
  records: readonly SkillRecord[];
  starterNames: ReadonlySet<string>;
  globalSkillsDir: string;
  archiveDir: string;
}

async function folderNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Every name a new learned skill may not take. */
export async function takenSkillNames(input: LearnTargetInput): Promise<Set<string>> {
  const names = new Set<string>(input.starterNames);
  for (const record of input.records) names.add(record.manifest.name);
  for (const name of await folderNames(input.globalSkillsDir)) names.add(name);
  // An archived learned skill can come back with `skill restore`.
  for (const name of await folderNames(input.archiveDir)) names.add(name);
  return names;
}
