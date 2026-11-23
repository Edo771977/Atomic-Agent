import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  assertMemoryBackupAllowed,
  createMemoryBackup,
  defaultBackupDir,
  formatMemoryRestoreResult,
  MEMORY_RESTORE_INSTRUCTIONS,
  restoreMemoryBackup,
} from "../memory/memory-backup.js";

export { defaultBackupDir } from "../memory/memory-backup.js";

export interface MemoryBackupDeps {
  memoryDbFile: string;
  stateDir: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: Date;
}

export async function runMemoryBackup(outArg: string | undefined, deps: MemoryBackupDeps): Promise<number> {
  const out = deps.out ?? ((text) => void process.stdout.write(text));
  const err = deps.err ?? ((text) => void process.stderr.write(text));
  try {
    assertMemoryBackupAllowed();
    const dir = resolve(outArg ?? defaultBackupDir(deps.stateDir, deps.now));
    if (existsSync(dir)) {
      err("backup directory already exists; pick another --out folder\n");
      return 2;
    }
    const path = await createMemoryBackup(deps, dir);
    out(`memory backed up -> ${path}\n${MEMORY_RESTORE_INSTRUCTIONS}`);
    return 0;
  } catch (error) {
    err(`memory backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function handleBackup(args: string[], readOption: (args: string[], name: string) => string | undefined): Promise<number> {
  try {
    assertMemoryBackupAllowed();
    const config = getConfig();
    return runMemoryBackup(readOption(args, "--out"), {
      memoryDbFile: config.paths.memoryDbFile,
      stateDir: config.paths.stateDir,
    });
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    return 1;
  }
}

export function handleRestore(directory: string | undefined, confirmed = false): number {
  if (!directory) {
    process.stderr.write("usage: atomic-agent memory restore --from <dir> [--yes]\n");
    return 2;
  }
  try {
    assertMemoryBackupAllowed();
    const config = getConfig();
    const result = restoreMemoryBackup({
      ...config.paths, maxEntries: config.memory.notes.maxEntries,
      profileMaxEntries: config.memory.profile.maxEntries, preview: !confirmed,
    }, directory);
    process.stdout.write(`${confirmed ? "Restored" : "Restore preview"}: ${formatMemoryRestoreResult(result)}\n`);
    if (!confirmed) process.stdout.write("Repeat with --yes to confirm.\n");
    return 0;
  } catch (error) {
    process.stderr.write(`memory restore failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
