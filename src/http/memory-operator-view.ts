import { maskSecrets, type KnownSecret } from "../error-reporting/secret-detector.js";
import { runtimeKnownSecrets } from "../runtime/runtime-known-secrets.js";
import type { HandlerContext } from "./request-context.js";
import { createHmac, randomBytes } from "node:crypto";
import { containsSecret, containsSecretPair, isSecretKey } from "../memory/memory-secret-guard.js";
import type { MemoryEntry } from "../memory/memory-store.js";
import type { ProfileFact } from "../memory/profile-store.js";
const MEMORY_DISPLAY_INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u2028\u2029\uFFF9-\uFFFB]/gu;

function isAllowedFormatCharacter(character: string): boolean {
  return character === "\u200C" || character === "\u200D" || character === "\u00AD";
}

const signingKey = randomBytes(32);

export function memoryFingerprint(entry: MemoryEntry | ProfileFact): string {
  const fields = "content" in entry
    ? ["note", entry.id, entry.content, entry.tags, entry.updatedAt, entry.disabledAt]
    : ["profile", entry.id, entry.key, entry.value, entry.keywords, entry.pinned, entry.updatedAt, entry.disabledAt];
  return createHmac("sha256", signingKey).update(JSON.stringify(fields)).digest("hex");
}

export function operatorMemoryText(value: string): string {
  if (containsSecret(value)) return "[redacted]";
  return value.replace(MEMORY_DISPLAY_INVISIBLE, (character) => isAllowedFormatCharacter(character) ? character :
    "\\u{" + character.codePointAt(0)!.toString(16).toUpperCase() + "}");
}

export function safeOperatorFact(fact: ProfileFact): boolean {
  return !isSecretKey(fact.key) && !containsSecret(fact.key) && !containsSecretPair(fact.key, fact.value);
}

/** Sanitize the operator projection, including historical rows written before credential validation. */
export function operatorMemoryPayload(value: unknown, ctx: HandlerContext): unknown {
  const known = runtimeKnownSecrets(ctx.runtime.config);
  if (ctx.apiKey) known.push({ label: "serve-key", value: ctx.apiKey, exact: true });
  return redact(value, known);
}

function redact(value: unknown, known: readonly KnownSecret[]): unknown {
  if (typeof value === "string") return operatorMemoryText(maskSecrets(value, known));
  if (Array.isArray(value)) return value.map((item) => redact(item, known));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const secretFact = typeof record.key === "string" && typeof record.value === "string"
    && (isSecretKey(record.key) || containsSecretPair(record.key, record.value));
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key, key === "value" && secretFact ? "[redacted]" : redact(item, known),
  ]));
}

/** Reject invisible characters and placeholders copied from this entry's display. */
export function isEditableMemoryText(value: string, original?: string, displayed?: string): boolean {
  if ([...value.matchAll(MEMORY_DISPLAY_INVISIBLE)].some(([character]) => !isAllowedFormatCharacter(character))) return false;
  for (const [, hex] of value.matchAll(/\\u\{([\da-f]+)\}/gi)) {
    const codePoint = Number.parseInt(hex!, 16);
    if (codePoint > 0x10ffff) continue;
    const character = String.fromCodePoint(codePoint);
    if (!isAllowedFormatCharacter(character) && character.search(MEMORY_DISPLAY_INVISIBLE) !== -1) return false;
  }
  if (displayed === undefined || displayed === original) return true;
  if (value === displayed) return false;
  const counts = (text: string): Map<string, number> => {
    const markers = new Map<string, number>();
    for (const [marker] of text.toLowerCase().matchAll(/\[redacted(?::[^\]]*)?\]/g)) {
      markers.set(marker, (markers.get(marker) ?? 0) + 1);
    }
    return markers;
  };
  const source = counts(original ?? "");
  const edited = counts(value);
  if (displayed.toLowerCase() === "[redacted]") return edited.size === 0;
  for (const [marker, displayedCount] of counts(displayed)) {
    const originalCount = source.get(marker) ?? 0;
    const added = displayedCount - originalCount;
    if (added > 0 && (edited.get(marker) ?? 0) > Math.max(0, originalCount - added)) return false;
  }
  return true;
}
