import { getConfig } from "../config/index.js";
import { restoreMemoryChange } from "../memory/evolution/index.js";
import { assertMemoryBackupAllowed } from "../memory/memory-backup.js";
import { MemoryStore, ProfileStore } from "../memory/index.js";

type Subcommand = "list" | "disable" | "enable" | "history" | "undo";

export function runMemoryEntryCommand(sub: Subcommand, args: string[]): number {
  const [kind, key, rawOffset] = args;
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  const collection = kind === "note" || kind === "profile";
  const validId = (value: string | undefined) => value !== undefined && /^[1-9]\d*$/.test(value)
    && Number.isSafeInteger(Number(value));
  const valid = sub === "list" ? collection && (args.length === 1 || (kind === "note" && args.length === 3
    && key === "--offset" && /^\d+$/.test(rawOffset ?? "") && Number.isSafeInteger(offset)))
    : sub === "history" ? args.length === 0
    : sub === "undo" ? args.length === 1 && validId(kind)
    : collection && args.length === 2 && (kind === "profile" ? Boolean(key) : validId(key));
  if (!valid) {
    process.stderr.write("usage: memory list note [--offset N] | list profile | disable|enable note|profile <id-or-key> | history | undo <change-id>\n");
    return 2;
  }
  let notes: MemoryStore | undefined;
  let profile: ProfileStore | undefined;
  try {
    assertMemoryBackupAllowed();
    const config = getConfig();
    const dbFile = config.paths.memoryDbFile;
    notes = new MemoryStore({ dbFile, maxEntries: config.memory.notes.maxEntries });
    profile = new ProfileStore({ dbFile });
    let result: unknown;
    if (sub === "list") {
      result = kind === "note" ? notes.list({ limit: 200, offset }) : profile.list();
    } else if (sub === "history") {
      result = notes.getChangeLog().list();
    } else if (sub === "undo") {
      const outcome = restoreMemoryChange(Number(kind), { notes, profile });
      if (!outcome.ok) throw new Error(outcome.message);
      result = outcome;
    } else {
      result = kind === "note" ? notes.setDisabled(Number(key), sub === "disable")
        : profile.setDisabled(key!, sub === "disable");
      if (result === null) throw new Error("memory entry not found");
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    profile?.close();
    notes?.close();
  }
}
