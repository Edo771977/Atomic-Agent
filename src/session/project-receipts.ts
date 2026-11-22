import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  session: SessionState,
  kind: "gate-verdict" | "milestone-report",
  payload: () => Record<string, unknown>,
): void {
  try {
    const folder = session.projectRef?.folder ?? projectFolderOf(session);
    if (session.projectRef === undefined && lstatSync(projectFilePath(folder), { throwIfNoEntry: false })) return;
    writer(folder, kind, { ...payload(), projectId: session.projectRef?.id ?? null });
  } catch {
    warn?.("Could not save an evidence receipt. The project archive may be incomplete.");
  }
}

export interface ProjectReceiptVerification {
  kind: ReceiptKind | null;
  projectId: string | null;
  status: ReceiptStatus;
}

export function verifyProjectReceiptDetails(stateDir: string, folder: string): ProjectReceiptVerification[] {
  const projectKey = projectFolderKey(folder);
  const path = archive(stateDir, projectKey, false);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map(line => {
    let kind: ReceiptKind | null = null;
    try {
      const row = JSON.parse(line);
      if (isReceiptKind(row?.kind)) kind = row.kind;
      const status = verifyReceipt(row, projectKey, id => {
        const path = join(childDir(stateDir, "signing", false), id + ".pem");
        checkFile(path);
        return existsSync(path) ? createPublicKey(readFileSync(path)) : null;
      });
      const id: unknown = row.payload?.projectId;
      const projectId = (kind === "gate-verdict" || kind === "milestone-report") &&
        (status === "valid" || status === "unsigned") && typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
      return { kind, status, projectId };
    } catch { return { kind, status: "bad-signature", projectId: null }; }
  });
}

export function verifyProjectReceipts(stateDir: string, folder: string): ReceiptStatus[] {
  return verifyProjectReceiptDetails(stateDir, folder).map(({ status }) => status);
}
