import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const RECEIPT_KINDS = ["artifact-manifest", "check-run-record", "gate-verdict", "milestone-report"] as const;
export type ReceiptKind = typeof RECEIPT_KINDS[number];
export function isReceiptKind(value: unknown): value is ReceiptKind {
  return RECEIPT_KINDS.some(kind => kind === value);
}
export type ReceiptStatus = "valid" | "hash-mismatch" | "bad-signature" | "unknown-key" | "unsigned" | "unknown-kind";
export interface Receipt {
  kind: ReceiptKind;
  payload: unknown;
  payloadHash: string;
  signature: string | null;
  keyId: string | null;
  signedAt: string;
  status?: "unsigned";
}

const normalized = (s: string) => s.replace(/\r\n?/g, "\n").normalize("NFC");

/** Encode JSON directly: JSON.stringify(object) would reorder numeric property names. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(normalized(value));
  if (Array.isArray(value)) return "[" + Array.from(value, canonicalJson).join(",") + "]";
  if (typeof value !== "object" || value === null ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error("Expected a JSON value");
  const fields = new Map<string, string>();
  for (const [key, val] of Object.entries(value)) {
    const name = normalized(key);
    if (fields.has(name)) throw new Error("Duplicate normalized JSON key");
    fields.set(name, canonicalJson(val));
  }
  return "{" + [...fields.keys()].sort().map(k => JSON.stringify(k) + ":" + fields.get(k)).join(",") + "}";
}

export function receiptHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function publicKeyId(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 32);
}

function signedBytes({ kind, payloadHash, keyId, signedAt }: Receipt, projectKey: string): Buffer {
  return Buffer.from(canonicalJson(["atomic-agent/receipt/v1", projectKey, kind, payloadHash, keyId, signedAt]));
}

export function makeReceipt(kind: ReceiptKind, payload: unknown, key: KeyObject | null, signedAt: string, projectKey: string): Receipt {
  const row: Receipt = { kind, payload, payloadHash: receiptHash(payload), keyId: null, signature: null, signedAt };
  if (!key) return { ...row, status: "unsigned" };
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 signing key");
  row.keyId = publicKeyId(createPublicKey(key));
  row.signature = sign(null, signedBytes(row, projectKey), key).toString("base64");
  return row;
}

export function verifyReceipt(row: Receipt, projectKey: string, lookup: (id: string) => KeyObject | null): ReceiptStatus {
  if (receiptHash(row.payload) !== row.payloadHash) return "hash-mismatch";
  const kind: unknown = row.kind;
  if (!isReceiptKind(kind)) return typeof kind === "string" && kind.length > 0 ? "unknown-kind" : "bad-signature";
  if (row.signature === null && row.keyId === null && row.status === "unsigned") return "unsigned";
  if (typeof row.signature !== "string" || row.status !== undefined || typeof row.keyId !== "string" ||
      !/^[a-f0-9]{32}$/.test(row.keyId) || typeof row.signedAt !== "string") return "bad-signature";
  const key = lookup(row.keyId);
  if (!key) return "unknown-key";
  if (key.asymmetricKeyType !== "ed25519" || publicKeyId(key) !== row.keyId) return "bad-signature";
  const sig = Buffer.from(row.signature, "base64");
  return sig.length === 64 && sig.toString("base64") === row.signature && verify(null, signedBytes(row, projectKey), key, sig)
    ? "valid" : "bad-signature";
}
