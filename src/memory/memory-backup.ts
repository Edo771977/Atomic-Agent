import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { syncDirectoryBestEffort } from "../config/durable-write.js";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { applyMigrations, MEMORY_SCHEMA_VERSION } from "./memory-schema.js";
import { containsSecret, containsSecretPair, isSecretKey } from "./memory-secret-guard.js";

export const MEMORY_BACKUP_FILE = "memory.sqlite";

export interface MemoryBackupContext {
  memoryDbFile: string;
  incognito?: boolean;
}

export class MemoryBackupError extends Error {}

export function assertMemoryBackupAllowed(incognito?: boolean): void {
  if (incognito) throw new MemoryBackupError("memory backup and restore are unavailable in incognito");
  if (process.env.ATOMIC_AGENT_TOOL_CHILD === "1") {
    throw new MemoryBackupError("memory backup and restore are unavailable to tool subprocesses");
  }
}

export function defaultBackupDir(stateDir: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(stateDir, "backups", `memory-${date}-${time}`);
}

export const MEMORY_RESTORE_INSTRUCTIONS = [
  "Atomic Agent memory backup.",
  "",
  "Run this command from inside this backup directory:",
  "  atomic-agent memory restore --from .",
  "",
  "The command merges notes and active profile facts, keeping existing entries.",
  "It does not bring back lessons, procedures, votes or note links.",
  "Search indexes are maintained on restore. Embeddings are rebuilt by backfill or memory reindex.",
  "",
].join("\n");

function restrictBackupPath(path: string, directory: boolean): void {
  if (process.platform === "win32") {
    const grant = directory ? "(OI)(CI)F" : "F";
    execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:${grant}`], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
  } else {
    chmodSync(path, directory ? 0o700 : 0o600);
  }
}

function requireCurrentSchema(db: Database.Database): void {
  let value: unknown;
  try {
    value = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").pluck().get();
  } catch {
    throw new MemoryBackupError("unrecognized memory database schema");
  }
  if (Number(value) !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryBackupError(`unsupported memory schema; expected version ${MEMORY_SCHEMA_VERSION}`);
  }
}

function includesSecret(value: unknown): boolean {
  if (typeof value === "string") {
    if (containsSecret(value)) return true;
    if (!value.startsWith("{") && !value.startsWith("[")) return false;
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      return false;
    }
    return includesSecret(decoded);
  }
  if (Array.isArray(value)) return value.some(includesSecret);
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.key === "string" && typeof record.value === "string"
    && (isSecretKey(record.key) || containsSecretPair(record.key, record.value))) return true;
  return Object.values(record).some(includesSecret);
}

function assertNoSecrets(db: Database.Database): void {
  const tables = db.pragma("table_list") as { schema: string; name: string; type: string }[];
  for (const { schema, name, type } of tables) {
    if (schema !== "main" || type !== "table" || name.startsWith("sqlite_")) continue;
    const escaped = name.replaceAll('"', '""');
    for (const row of db.prepare(`SELECT * FROM "${escaped}"`).iterate() as Iterable<Record<string, unknown>>) {
      const { key, value } = row;
      const secretPair = name === "profile_facts" && typeof key === "string" && typeof value === "string"
        && (isSecretKey(key) || containsSecretPair(key, value));
      const secretField = Object.values(row).some(includesSecret);
      if (secretPair || secretField) throw new MemoryBackupError("memory contains a credential; export refused");
    }
  }
}

/** Publish the directory only after the snapshot and its instructions are complete. */
export async function createMemoryBackup(context: MemoryBackupContext, directory: string): Promise<string> {
  assertMemoryBackupAllowed(context.incognito);
  const dest = resolve(directory);
  if (!existsSync(context.memoryDbFile)) throw new MemoryBackupError("no memory database to back up");
  if (existsSync(dest)) throw new MemoryBackupError("backup directory already exists");
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(dest), ".memory-backup-"));
  try {
    restrictBackupPath(staging, true);
    const scratch = join(staging, "snapshot.sqlite");
    const source = new DatabaseCtor(context.memoryDbFile, { readonly: true, fileMustExist: true });
    try {
      await source.backup(scratch);
    } finally {
      source.close();
    }
    restrictBackupPath(scratch, false);

    const snapshot = new DatabaseCtor(scratch, { fileMustExist: true });
    const output = join(staging, MEMORY_BACKUP_FILE);
    try {
      requireCurrentSchema(snapshot);
      applyMigrations(snapshot);
      assertNoSecrets(snapshot);
      // Rebuild FTS from live rows and compact away freed pages.
      for (const index of ["memories_fts", "lessons_fts", "procedures_fts"]) {
        snapshot.exec(`INSERT INTO ${index}(${index}) VALUES('rebuild')`);
      }
      snapshot.prepare("VACUUM INTO ?").run(output);
    } finally {
      snapshot.close();
    }
    restrictBackupPath(output, false);
    const fd = openSync(output, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    rmSync(scratch);
    const instructions = join(staging, "RESTORE.txt");
    writeFileSync(instructions, MEMORY_RESTORE_INSTRUCTIONS, { mode: 0o600, flush: true });
    restrictBackupPath(instructions, false);
    syncDirectoryBestEffort(staging);
    renameSync(staging, dest);
    syncDirectoryBestEffort(dirname(dest));
    return join(dest, MEMORY_BACKUP_FILE);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface MemoryRestoreResult {
  notes: number;
  facts: number;
}

/** Merge current entries under one SQLite write transaction, including deduplication. */
export function restoreMemoryBackup(context: MemoryBackupContext, directory: string): MemoryRestoreResult {
  assertMemoryBackupAllowed(context.incognito);
  const path = join(resolve(directory), MEMORY_BACKUP_FILE);
  const source = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
  try {
    source.pragma("trusted_schema = OFF");
    const { notes, facts } = source.transaction(() => {
      requireCurrentSchema(source);
      assertNoSecrets(source);
      const notes = source.prepare(`
      SELECT content, created_at, updated_at, source, session_id, working_dir, tags, constraint_scope, disabled_at
      FROM memories ORDER BY id
    `).all();
      const facts = source.prepare(`
      SELECT key, value, pinned, keywords, valid_from, created_at, updated_at,
             name_grounding, name_checked_at, constraint_scope, disabled_at
      FROM profile_facts WHERE superseded_by IS NULL ORDER BY id
    `).all();
      return { notes, facts };
    })();
    mkdirSync(dirname(context.memoryDbFile), { recursive: true, mode: 0o700 });
    const target = new DatabaseCtor(context.memoryDbFile);
    try {
      applyMigrations(target);
      const insertNote = target.prepare(`
        INSERT INTO memories (content, created_at, updated_at, source, session_id, working_dir, tags, constraint_scope, disabled_at)
        SELECT @content, @created_at, @updated_at, @source, @session_id, @working_dir, @tags, @constraint_scope, @disabled_at
        WHERE NOT EXISTS (
          SELECT 1 FROM memories WHERE content = @content AND constraint_scope IS @constraint_scope
        )
      `);
      const insertFact = target.prepare(`
        INSERT INTO profile_facts (key, value, pinned, keywords, valid_from, created_at, updated_at,
                                   name_grounding, name_checked_at, constraint_scope, disabled_at)
        SELECT @key, @value, @pinned, @keywords, @valid_from, @created_at, @updated_at,
               @name_grounding, @name_checked_at, @constraint_scope, @disabled_at
        WHERE NOT EXISTS (SELECT 1 FROM profile_facts WHERE key = @key)
      `);
      return target.transaction(() => {
        const result: MemoryRestoreResult = { notes: 0, facts: 0 };
        for (const note of notes) result.notes += insertNote.run(note).changes;
        for (const fact of facts) result.facts += insertFact.run(fact).changes;
        return result;
      }).immediate();
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
}
