import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SecretKeychain } from "../config/secret-store.js";
import { projectFolderOf } from "./project-folder.js";
import { projectFilePath } from "./project-store.js";
import type { SessionState } from "./session-state.js";
import { projectFolderKey } from "./project-decisions.js";
import { isReceiptKind, makeReceipt, publicKeyId, verifyReceipt, type ReceiptKind, type ReceiptStatus } from "./receipt-signing.js";

type ReceiptKeychain = Pick<SecretKeychain, "read" | "write">;
export type ProjectReceiptWriter = (folder: string, kind: ReceiptKind, payload: unknown) => void;
// Same OS credential service, distinct from accounts that export into the environment.
const ACCOUNT = "receipts.ed25519.private.v1";

function childDir(parent: string, name: string, create: boolean): string {
  const dir = join(parent, name);
  if (create && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error("Invalid receipt directory");
  return dir;
}

function checkFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Invalid receipt file");
}

function archive(stateDir: string, projectKey: string, create: boolean): string {
  const root = childDir(stateDir, "receipts", create);
  const path = join(childDir(root, projectKey, create), "receipts.ndjson");
  checkFile(path);
  return path;
}

function signingKey(store: ReceiptKeychain): KeyObject | null {
  const entry = store.read(ACCOUNT);
  if (!entry.ok) return null;
  if (entry.value !== null) {
    try {
      const key = createPrivateKey(entry.value);
      return key.asymmetricKeyType === "ed25519" ? key : null;
    } catch { return null; }
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return store.write(ACCOUNT, pem) ? privateKey : null;
}

function publishKey(dir: string, key: KeyObject): void {
  const path = join(dir, publicKeyId(key) + ".pem");
  checkFile(path);
  const pem = key.export({ type: "spki", format: "pem" }).toString();
  try { writeFileSync(path, pem, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(path, "utf8") !== pem) throw error;
  }
}

export function appendProjectReceipt(stateDir: string, folder: string, kind: ReceiptKind, payload: unknown, keychain: ReceiptKeychain): "signed" | "unsigned" {
  const projectKey = projectFolderKey(folder);
  const path = archive(stateDir, projectKey, true);
  const key = signingKey(keychain);
  if (key) publishKey(childDir(stateDir, "signing", true), createPublicKey(key));
  const row = makeReceipt(kind, payload, key, new Date().toISOString(), projectKey);
  appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
  return key ? "signed" : "unsigned";
}

/** Production callers provide their keychain and a user-visible warning sink. */
export function createProjectReceiptWriter(stateDir: string, keychain: ReceiptKeychain, warn: (message: string) => void): ProjectReceiptWriter {
  let unsignedReported = false;
  return (folder: string, kind: ReceiptKind, payload: unknown): void => {
    try {
      if (appendProjectReceipt(stateDir, folder, kind, payload, keychain) === "unsigned" && !unsignedReported) {
        unsignedReported = true;
        warn("Evidence receipt saved unsigned: the installation signing key is unavailable.");
      }
    } catch {
      warn("Could not save an evidence receipt. The project archive may be incomplete.");
    }
  };
}

/** Keep post-commit receipt errors independent from the saved state. */
export function writeEvidenceReceipt(
  writer: ProjectReceiptWriter,
  warn: ((message: string) => void) | undefined,
  session: Pick<SessionState, "id" | "workingDir" | "worktree"> & {
    projectRef?: Pick<NonNullable<SessionState["projectRef"]>, "folder" | "id">;
  },
  kind: ReceiptKind,
  payload: () => Record<string, unknown>,
): void {
  try {
    const folder = session.projectRef?.folder ?? projectFolderOf(session);
    if (session.projectRef === undefined && lstatSync(projectFilePath(folder), { throwIfNoEntry: false })) return;
    const evidence = payload();
    writer(folder, kind, {
      ...evidence,
      projectId: session.projectRef?.id ?? null,
      ...(session.projectRef === undefined && typeof evidence.milestoneId === "string" ? { sessionId: session.id } : {}),
    });
  } catch {
    warn?.("Could not save an evidence receipt. The project archive may be incomplete.");
  }
}

export interface ProjectReceiptVerification {
  kind: ReceiptKind | null;
  projectId: string | null;
  status: ReceiptStatus;
}

export interface MilestoneReceiptScope {
  projectId: string | null;
  sessionId: string;
  milestoneId: string;
  runIds?: readonly string[];
  version?: number | null;
  since?: number;
}

interface ScopedReceiptVerification {
  receipts: ProjectReceiptVerification[];
  partial: boolean;
}

interface CachedReceiptScan {
  archive: string;
  signingDir: string;
  rows: Map<string, ProjectReceiptVerification>;
  result: ScopedReceiptVerification;
}

export type MilestoneReceiptCache = Map<string, CachedReceiptScan>;

function fileRevision(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false, bigint: true });
  return stat === undefined ? "" : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

const VIEW_MAX_BYTES = 2 * 1024 * 1024;
const VIEW_MAX_ROWS = 512;

function receiptLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function readReceiptTail(path: string): { lines: string[]; partial: boolean } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid receipt file");
    const offset = Math.max(0, stat.size - VIEW_MAX_BYTES);
    const buffer = Buffer.alloc(stat.size - offset);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const bytes = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (bytes === 0) break;
      bytesRead += bytes;
    }
    const lines = receiptLines(buffer.toString("utf8", 0, bytesRead));
    if (offset > 0) lines.shift(); // The first line can start in the middle of a receipt.
    return {
      lines: lines.slice(-VIEW_MAX_ROWS),
      partial: offset > 0 || lines.length > VIEW_MAX_ROWS || bytesRead !== buffer.length,
    };
  } finally {
    closeSync(fd);
  }
}

export function verifyProjectReceiptDetails(stateDir: string, folder: string): ProjectReceiptVerification[];
export function verifyProjectReceiptDetails(stateDir: string, folder: string, scope: MilestoneReceiptScope, cache?: MilestoneReceiptCache): ScopedReceiptVerification;
export function verifyProjectReceiptDetails(stateDir: string, folder: string, scope?: MilestoneReceiptScope, cache?: MilestoneReceiptCache): ProjectReceiptVerification[] | ScopedReceiptVerification {
  const projectKey = projectFolderKey(folder);
  const path = archive(stateDir, projectKey, false);
  if (!existsSync(path)) return scope === undefined ? [] : { receipts: [], partial: false };
  const cacheKey = scope === undefined || cache === undefined ? undefined : JSON.stringify([path, scope]);
  const previous = cacheKey === undefined ? undefined : cache!.get(cacheKey);
  const revision = cacheKey === undefined ? "" : fileRevision(path);
  const signingRevision = cacheKey === undefined ? "" : fileRevision(join(stateDir, "signing"));
  const reusable = previous?.signingDir === signingRevision ? previous : undefined;
  if (reusable !== undefined && reusable.archive === revision) return reusable.result;
  const scanned = new Map<string, ProjectReceiptVerification>();
  const { lines, partial } = scope === undefined
    ? { lines: receiptLines(readFileSync(path, "utf8")), partial: false }
    : readReceiptTail(path);
  const keys = new Map<string, KeyObject | null>();
  const lookup = (id: string): KeyObject | null => {
    if (!keys.has(id)) {
      const path = join(childDir(stateDir, "signing", false), id + ".pem");
      checkFile(path);
      keys.set(id, existsSync(path) ? createPublicKey(readFileSync(path)) : null);
    }
    return keys.get(id) ?? null;
  };
  const receipts: ProjectReceiptVerification[] = [];
  let oldestTimestamp: number | undefined;
  for (const line of scope === undefined ? lines : lines.reverse()) {
    let kind: ReceiptKind | null = null;
    // Read from newest to oldest. A broken row can belong to this scope
    // unless the next dated row already predates the current work.
    let matched = scope?.since === undefined || oldestTimestamp === undefined || oldestTimestamp >= scope.since;
    try {
      const row = JSON.parse(line);
      if (row === null || typeof row !== "object" || !Object.hasOwn(row, "payload")) throw new Error("Invalid receipt row");
      if (scope?.since !== undefined) {
        const timestamp = Date.parse(row?.signedAt);
        if (Number.isFinite(timestamp)) oldestTimestamp = timestamp;
      }
      if (isReceiptKind(row?.kind)) kind = row.kind;
      const id: unknown = row?.payload?.projectId;
      if (scope !== undefined) {
        // A damaged receipt can still claim this milestone. Its attribution
        // stays unverified and is used only to surface the problem on the card.
        const sameProject = id === null ? row?.payload?.sessionId === scope.sessionId : id === scope.projectId;
        matched = kind !== "gate-verdict" && sameProject &&
          row?.payload?.milestoneId === scope.milestoneId &&
          (scope.runIds === undefined || (kind === "milestone-report"
            ? row.payload.version === scope.version
            : scope.runIds.includes(row.payload.runId)));
      }
      if (!matched) continue;
      const cached = reusable?.rows.get(line);
      if (cached !== undefined) {
        receipts.push(cached);
        scanned.set(line, cached);
        continue;
      }
      const status = verifyReceipt(row, projectKey, lookup);
      const projectId = kind !== null &&
        (status === "valid" || status === "unsigned") && typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
      const verified = { kind, status, projectId };
      receipts.push(verified);
      if (cacheKey !== undefined) scanned.set(line, verified);
    } catch {
      if (matched) receipts.push({ kind, status: "bad-signature", projectId: null });
    }
  }
  if (scope === undefined) return receipts;
  const reachedStart = scope.since !== undefined && oldestTimestamp !== undefined && oldestTimestamp < scope.since;
  const result = { receipts: receipts.reverse(), partial: partial && !reachedStart };
  if (cacheKey !== undefined && cache !== undefined) {
    cache.delete(cacheKey);
    cache.set(cacheKey, { archive: revision, signingDir: signingRevision, rows: scanned, result });
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return result;
}

export function verifyProjectReceipts(stateDir: string, folder: string): ReceiptStatus[] {
  return verifyProjectReceiptDetails(stateDir, folder).map(({ status }) => status);
}
