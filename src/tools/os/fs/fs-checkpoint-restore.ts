import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import {
  sha256Of,
  type CheckpointEntry,
  type CheckpointSkip,
  type FileCheckpointStore,
} from "./fs-checkpoint-store.js";

/**
 * What putting the files back to a point in a chat would do (ATO-1056),
 * and doing it. The point is a time: the files as they were before the
 * first change saved at or after it (`fs-checkpoint-store.ts`).
 *
 * The plan compares each saved copy with the disk now, so a change the
 * tool never made (an approval the person declined, a write that
 * failed) or a file already back as it was is left out: the confirmation
 * lists only files that will really change.
 */

export interface FileRestoreItem {
  path: string;
  /** `restore` writes the saved content back; `delete` removes a file the agent created. */
  action: "restore" | "delete";
  entry: CheckpointEntry;
  /**
   * Set when the file could not be inspected now (issue #80: a read or
   * stat failing with EACCES, EPERM, EBUSY, EIO…): the plan cannot tell
   * whether it changed, so applying reports it in `failed` and leaves it
   * alone, and a caller keeps the copies for a retry.
   */
  blocked?: string;
  /**
   * A file to delete whose contents could not be read (issue #87): it is
   * still removed, and only its stat (size, mtime, inode) fingerprints it.
   */
  contentUnchecked?: true;
  /** Why: it could not be read, or it is past `RESTORE_HASH_MAX_BYTES` and was not read. */
  contentUncheckedReason?: "unreadable" | "too_large";
  /** What the disk holds now, as the plan compared it (its sha, or for a file to delete that cannot be read its size, mtime and inode); part of `restorePlanHash`. */
  now?: string;
}

export interface FileNotRestorable {
  path: string;
  /**
   * `move_source_not_restored`: a file the agent moved here from a source
   * this rollback does not put back (no copy kept, binary, too large, or
   * skipped); deleting it would lose the only copy, so it stays.
   */
  reason: CheckpointSkip | "move_source_not_restored";
}

export interface FileRestorePlan {
  /** The chat's folder the paths were keyed against. */
  cwd: string;
  platform?: NodeJS.Platform;
  items: FileRestoreItem[];
  notRestorable: FileNotRestorable[];
  /** Some changes from that point on are no longer kept (the store's bounds). */
  incomplete: boolean;
  /** Paths left out because the caller asked to skip them (issue #80); never inspected. */
  skipped: string[];
  /** Skip paths, as given, that match no file with a copy since the point. */
  unknownSkip: string[];
}

export interface FileRestoreResult {
  restored: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
}

type Store = Pick<FileCheckpointStore, "since" | "readCopy">;

export interface FileRestoreOptions {
  /** Files to leave out unread (issue #80), matched by `restorePathKey`. */
  skip?: readonly string[];
  /** The chat's folder: a relative skip path is read against it. */
  cwd?: string;
  platform?: NodeJS.Platform;
  /** Files larger than this are fingerprinted by stat, not read (default `RESTORE_HASH_MAX_BYTES`). */
  maxHashBytes?: number;
}

/**
 * The largest file the plan reads to fingerprint it (issue #87 review).
 * A larger one is fingerprinted by size, mtime and inode and marked
 * `contentUnchecked` `too_large`: hashing it would read it whole into
 * memory twice per rollback (and fail at 2 GiB). A saved copy is never
 * that large (`CHECKPOINT_MAX_FILE_BYTES`), so such a file to restore
 * differs from it anyway.
 */
export const RESTORE_HASH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The one form two paths are compared in (issue #80): resolved against
 * the chat's folder (dot segments, doubled and trailing separators go)
 * and, on Windows, case-folded. Reported paths stay as captured.
 */
export function restorePathKey(path: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return win32.resolve(cwd, path).toLowerCase();
  return posix.resolve(cwd, path);
}

export async function planFileRestore(
  store: Store,
  sessionId: string,
  sinceAt: number,
  options: FileRestoreOptions = {},
): Promise<FileRestorePlan> {
  const { entries, incomplete } = await store.since(sessionId, sinceAt);
  const cwd = options.cwd ?? process.cwd();
  const key = (path: string): string => restorePathKey(path, cwd, options.platform);
  // The earliest copy of each path is what it held before the point.
  const first = new Map<string, CheckpointEntry>();
  for (const entry of entries) {
    const k = key(entry.path);
    if (!first.has(k)) first.set(k, entry);
  }
  const skip = new Set<string>();
  const unknownSkip: string[] = [];
  for (const path of options.skip ?? []) {
    const k = key(path);
    if (first.has(k)) skip.add(k);
    else unknownSkip.push(path);
  }
  const items: FileRestoreItem[] = [];
  const notRestorable: FileNotRestorable[] = [];
  const skipped: string[] = [];
  // A move's source is put back only from a kept copy, and not when skipped.
  const sourceComesBack = (from: string): boolean => {
    const k = key(from);
    const source = first.get(k);
    return source !== undefined && !skip.has(k) && source.existed && source.file !== undefined;
  };
  for (const [k, entry] of first) {
    // Taken out whether or not the disk already matches: never inspected.
    if (skip.has(k)) {
      skipped.push(entry.path);
      continue;
    }
    if (entry.skipped !== undefined) {
      notRestorable.push({ path: entry.path, reason: entry.skipped });
      continue;
    }
    // A file the agent created is only removed: rm needs no read.
    const now = await currentState(entry.path, options.maxHashBytes ?? RESTORE_HASH_MAX_BYTES, !entry.existed);
    if (now.kind === "permanent") {
      notRestorable.push({ path: entry.path, reason: now.reason });
      continue;
    }
    if (now.kind === "blocked") {
      items.push({ path: entry.path, action: entry.existed ? "restore" : "delete", entry, blocked: now.error });
      continue;
    }
    if (!entry.existed) {
      if (now.kind === "missing") continue;
      if (entry.movedFrom !== undefined && !sourceComesBack(entry.movedFrom)) {
        notRestorable.push({ path: entry.path, reason: "move_source_not_restored" });
        continue;
      }
      if (now.kind === "other") notRestorable.push({ path: entry.path, reason: "not_a_file" });
      else items.push({ path: entry.path, action: "delete", entry, now: describe(now), ...unchecked(now) });
      continue;
    }
    if (now.kind === "file" && now.sha256 === entry.sha256) continue;
    if (now.kind === "other") {
      notRestorable.push({ path: entry.path, reason: "not_a_file" });
      continue;
    }
    // A copy whose bytes no longer match its sha would overwrite the
    // file with garbage (issue #87): listed with an error, never written.
    if ((await copyState(store, sessionId, entry)) === "damaged") {
      items.push({ path: entry.path, action: "restore", entry, now: describe(now), blocked: DAMAGED });
      continue;
    }
    items.push({ path: entry.path, action: "restore", entry, now: describe(now), ...unchecked(now) });
  }
  return { cwd, platform: options.platform, items, notRestorable, incomplete, skipped, unknownSkip };
}

/** The `failed[].error` of a file whose saved copy no longer matches its sha256: permanent, never written. */
export const COPY_DAMAGED_ERROR = "saved copy is damaged";
const DAMAGED = COPY_DAMAGED_ERROR;

/** Whether a saved copy still holds the bytes its sha256 names; a copy that cannot be read is left for the apply step to report. */
async function copyState(store: Store, sessionId: string, entry: CheckpointEntry): Promise<"intact" | "damaged" | "unread"> {
  if (entry.sha256 === undefined) return "unread";
  try {
    return sha256Of(await store.readCopy(sessionId, entry)) === entry.sha256 ? "intact" : "damaged";
  } catch {
    return "unread";
  }
}

function unchecked(now: Current): { contentUnchecked?: true; contentUncheckedReason?: "unreadable" | "too_large" } {
  return now.kind === "file" && now.unchecked !== undefined ? { contentUnchecked: true, contentUncheckedReason: now.unchecked } : {};
}

function describe(now: Current): string {
  if (now.kind === "file") return now.sha256 !== undefined ? `sha256:${now.sha256}` : `${now.unchecked ?? "unread"}-stat:${now.stat}`;
  return now.kind;
}

/**
 * A fingerprint of what carrying out `plan` would do (issue #83): each
 * file's key, action, saved copy and what the disk holds now (blocked or
 * not), the files not restorable, the skipped ones and `incomplete`,
 * sorted, plus the caller's `extra` (the point). Equal plans hash equal;
 * an edit to a listed file or a new copy changes it. No content beyond
 * the shas the plan already compares.
 */
export function restorePlanHash(plan: FileRestorePlan, extra: unknown): string {
  const key = (path: string): string => restorePathKey(path, plan.cwd, plan.platform);
  const sorted = <T extends unknown[]>(rows: T[]): T[] => rows.sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : String(x[0]) > String(y[0]) ? 1 : 0));
  const shape = {
    extra,
    items: sorted(plan.items.map((item) => [
      key(item.path),
      item.action,
      item.entry.n,
      item.entry.sha256 ?? null,
      item.blocked === undefined ? (item.now ?? null) : "blocked",
    ])),
    notRestorable: sorted(plan.notRestorable.map((row) => [key(row.path), row.reason])),
    skipped: plan.skipped.map(key).sort(),
    incomplete: plan.incomplete,
  };
  return sha256Of(Buffer.from(JSON.stringify(shape), "utf8"));
}

/**
 * Carry out a plan. Each file is tried on its own; one failure does not
 * stop the rest. With a non-empty `failed`, a caller keeps the copies
 * (issue #77): planned again, the files already back match their copy
 * and are left out, so a retry only touches the ones that failed.
 */
export async function applyFileRestore(
  store: Store,
  sessionId: string,
  /** Only `items` is carried out; a skipped path is never in them. */
  plan: Pick<FileRestorePlan, "items"> & Partial<FileRestorePlan>,
): Promise<FileRestoreResult> {
  const result: FileRestoreResult = { restored: [], deleted: [], failed: [] };
  for (const item of plan.items) {
    if (item.blocked === DAMAGED) {
      result.failed.push({ path: item.path, error: DAMAGED });
      continue;
    }
    if (item.blocked !== undefined) {
      result.failed.push({ path: item.path, error: `could not check it now: ${item.blocked}` });
      continue;
    }
    try {
      if (item.action === "delete") {
        await rm(item.path, { force: true });
        result.deleted.push(item.path);
      } else {
        const content = await store.readCopy(sessionId, item.entry);
        // Checked again right before the write: the copy may have been damaged since the plan.
        if (item.entry.sha256 !== undefined && sha256Of(content) !== item.entry.sha256) {
          result.failed.push({ path: item.path, error: DAMAGED });
          continue;
        }
        await mkdir(dirname(item.path), { recursive: true });
        await writeFile(item.path, content);
        result.restored.push(item.path);
      }
    } catch (err) {
      result.failed.push({ path: item.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Tools that change files without a checkpoint, among `rows` (the rows a
 * rollback removes): shell commands, archive extraction, git commands
 * that write the work tree or history, and Fusion workers (their own
 * sessions). The confirmation names them, since their changes stay.
 */
export function uncoveredToolCalls(
  rows: readonly { kind: string; tool?: string }[],
): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistant_tool_call" || typeof row.tool !== "string") continue;
    if (!changesFilesUnseen(row.tool)) continue;
    counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => ({ tool, count }));
}

const READ_ONLY_GIT = new Set(["os.git.blame", "os.git.diff", "os.git.log", "os.git.show", "os.git.status"]);

function changesFilesUnseen(tool: string): boolean {
  if (tool.startsWith("os.shell.")) return true;
  if (tool === "os.fs.archive.extract") return true;
  if (tool === "fusion.delegate") return true;
  if (tool.startsWith("os.git.")) return !READ_ONLY_GIT.has(tool);
  return false;
}

/**
 * What the disk holds at a path now (issue #80). ENOENT/ENOTDIR is
 * `missing`; ELOOP (a symlink loop) and ENAMETOOLONG can never succeed
 * and are `permanent`; any other stat or read error (EACCES, EPERM,
 * EBUSY, EIO…) is `blocked`: it may pass, so the rollback reports it in
 * `failed` and keeps the copies for a retry.
 */
type Current =
  | { kind: "missing" }
  | { kind: "other" }
  | { kind: "file"; sha256?: string; stat?: string; unchecked?: "unreadable" | "too_large" }
  | { kind: "permanent"; reason: CheckpointSkip }
  | { kind: "blocked"; error: string };

/**
 * `toDelete`: a file the agent created (issue #87). Its contents
 * fingerprint it when they can be read; rm needs no read, so one that
 * cannot be is still removed, fingerprinted by stat alone (size, mtime,
 * inode) and marked `unreadable`. A file to restore that cannot be read
 * is `blocked`. Either past `maxHashBytes` is not read (`too_large`).
 */
async function currentState(path: string, maxHashBytes: number, toDelete: boolean): Promise<Current> {
  try {
    // Followed like the capture follows it (`stat`).
    const info = await stat(path);
    if (!info.isFile()) return { kind: "other" };
    const byStat = `${info.size}:${info.mtimeMs}:${info.ino}`;
    if (info.size > maxHashBytes) return { kind: "file", stat: byStat, unchecked: "too_large" };
    if (!toDelete) return { kind: "file", sha256: sha256Of(await readFile(path)) };
    try {
      return { kind: "file", sha256: sha256Of(await readFile(path)) };
    } catch {
      return { kind: "file", stat: byStat, unchecked: "unreadable" };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "permanent", reason: "not_a_file" };
    if (code === "ENAMETOOLONG") return { kind: "permanent", reason: "unreadable" };
    return { kind: "blocked", error: err instanceof Error ? err.message : String(err) };
  }
}
