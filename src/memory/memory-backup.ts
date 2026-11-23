import { AGENT_TOOL_CHILD_ENV } from "../sandbox/command-env.js";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { syncDirectoryBestEffort } from "../config/durable-write.js";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { PROJECT_LESSON_INVISIBLE_CHARACTERS } from "../session/project-lesson-text.js";
import { parseConstraintScope } from "./memory-constraint-scope.js";
import { MemoryValidationError, validateContent, validateTags, withoutReservedTags } from "./memory-store.js";
import { ProfileValidationError, validateKey, validateKeywords, validateValue } from "./profile-store.js";
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
  if (process.env[AGENT_TOOL_CHILD_ENV] !== undefined) {
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

export interface MemoryRestoreContext extends MemoryBackupContext {
  maxEntries?: number;
  profileMaxEntries?: number;
  preview?: boolean;
}

export interface MemoryRestoreResult {
  notes: number;
  facts: number;
  rejected?: number;
  reasons?: Record<string, number>;
}

export function formatMemoryRestoreResult(result: MemoryRestoreResult): string {
  const reasons = Object.entries(result.reasons ?? {}).map(([reason, count]) => `${reason}: ${count}`);
  return `${result.notes} notes, ${result.facts} profile facts, ${result.rejected ?? 0} rejected${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
}

const MAX_RESTORE_BYTES = 128 * 1024 * 1024;
const MAX_RESTORE_ROWS = 50_000;
type ArchiveRow = Record<string, unknown>;

class RestorePreview {
  constructor(readonly result: MemoryRestoreResult) {}
}

function archiveText(value: unknown): void {
  if (typeof value === "string" && (!value.isWellFormed()
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/u.test(value)
    || value.search(PROJECT_LESSON_INVISIBLE_CHARACTERS) !== -1)) {
    throw new MemoryBackupError("invalid text");
  }
  if (Array.isArray(value)) for (const item of value) archiveText(item);
}

function archiveArray(value: unknown): unknown {
  if (value == null) return [];
  if (typeof value !== "string") throw new MemoryBackupError("invalid list");
  try {
    const parsed: unknown = JSON.parse(value);
    archiveText(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof MemoryBackupError) throw error;
    throw new MemoryBackupError("invalid list");
  }
}

function checkArchiveRow(row: ArchiveRow): void {
  for (const value of Object.values(row)) archiveText(value);
  if (row.constraint_scope !== null
    && (typeof row.constraint_scope !== "string" || !parseConstraintScope(row.constraint_scope))) {
    throw new MemoryBackupError("invalid scope");
  }
}

/** Merge current entries under one SQLite write transaction, including deduplication. */
export function restoreMemoryBackup(context: MemoryRestoreContext, directory: string): MemoryRestoreResult {
  assertMemoryBackupAllowed(context.incognito);
  const path = join(resolve(directory), MEMORY_BACKUP_FILE);
  if (path === resolve(context.memoryDbFile)) throw new MemoryBackupError("backup and live database must be different");
  if (statSync(path).size > MAX_RESTORE_BYTES) throw new MemoryBackupError("backup exceeds the restore size limit");
  const source = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
  try {
    source.pragma("trusted_schema = OFF");
    return source.transaction(() => {
      requireCurrentSchema(source);
      const bytes = Number(source.pragma("page_count", { simple: true })) * Number(source.pragma("page_size", { simple: true }));
      if (bytes > MAX_RESTORE_BYTES) throw new MemoryBackupError("backup exceeds the restore size limit");
      const count = Number(source.prepare("SELECT (SELECT count(*) FROM memories) + (SELECT count(*) FROM profile_facts)").pluck().get());
      if (count > MAX_RESTORE_ROWS) throw new MemoryBackupError("backup exceeds the restore row limit");
      const notes = source.prepare(`
        SELECT content, created_at, updated_at, session_id, working_dir, tags, constraint_scope, disabled_at
        FROM memories ORDER BY id
      `);
      const facts = source.prepare(`
        SELECT key, value, pinned, keywords, valid_from, created_at, updated_at, constraint_scope, disabled_at
        FROM profile_facts WHERE superseded_by IS NULL ORDER BY id
      `);
      const exists = existsSync(context.memoryDbFile);
      if (!context.preview) mkdirSync(dirname(context.memoryDbFile), { recursive: true, mode: 0o700 });
      const target = new DatabaseCtor(context.preview && !exists ? ":memory:" : context.memoryDbFile);
      try {
        if (!context.preview || !exists) applyMigrations(target);
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
          const noteScope = target.prepare("SELECT 1 FROM memories WHERE content = ? AND constraint_scope IS NOT NULL LIMIT 1");
          const factScope = target.prepare("SELECT 1 FROM profile_facts WHERE key = ? AND constraint_scope IS NOT NULL LIMIT 1");
          function rejected(error: unknown, kind: string): boolean {
            const reason = error instanceof MemoryBackupError ? error.message
              : error instanceof MemoryValidationError || error instanceof ProfileValidationError ? `${kind} ${error.field}` : undefined;
            if (!reason) return false;
            result.rejected = (result.rejected ?? 0) + 1;
            const reasons = result.reasons ??= {};
            reasons[reason] = (reasons[reason] ?? 0) + 1;
            return true;
          }
          for (const row of notes.iterate() as Iterable<ArchiveRow>) {
            try {
              checkArchiveRow(row);
              const content = validateContent(row.content);
              const tags = withoutReservedTags(validateTags(archiveArray(row.tags)));
              if (row.constraint_scope === null && noteScope.get(content)) throw new MemoryBackupError("scope mismatch");
              result.notes += insertNote.run({ ...row, content, source: "agent", tags: JSON.stringify(tags) }).changes;
            } catch (error) {
              if (!rejected(error, "note")) throw error;
            }
          }
          for (const row of facts.iterate() as Iterable<ArchiveRow>) {
            try {
              checkArchiveRow(row);
              const key = validateKey(row.key);
              const value = validateValue(row.value);
              if (isSecretKey(key) || containsSecretPair(key, value)) throw new MemoryBackupError("profile credential");
              const keywords = validateKeywords(archiveArray(row.keywords));
              if (row.constraint_scope === null && factScope.get(key)) throw new MemoryBackupError("scope mismatch");
              result.facts += insertFact.run({ ...row, key, value, keywords: JSON.stringify(keywords), name_grounding: null, name_checked_at: null }).changes;
            } catch (error) {
              if (!rejected(error, "profile")) throw error;
            }
          }
          const count = (sql: string) => Number(target.prepare(sql).pluck().get());
          const noteOverflow = Math.max(0, count("SELECT count(*) FROM memories") - (context.maxEntries ?? Infinity));
          const factOverflow = Math.max(0, count("SELECT count(*) FROM profile_facts WHERE superseded_by IS NULL AND pinned = 0") - (context.profileMaxEntries ?? Infinity));
          if ((result.notes > 0 && noteOverflow > 0) || (result.facts > 0 && factOverflow > 0)) {
            throw new MemoryBackupError(
              `Restore would add ${result.notes} notes and ${result.facts} profile facts and evict ${noteOverflow} notes and ${factOverflow} profile facts. Increase the configured limits or restore a smaller subset.`,
            );
          }
          if (context.preview) throw new RestorePreview(result);
          return result;
        }).immediate();
      } catch (error) {
        if (error instanceof RestorePreview) return error.result;
        throw error;
      } finally {
        target.close();
      }
    })();
  } finally {
    source.close();
  }
}
