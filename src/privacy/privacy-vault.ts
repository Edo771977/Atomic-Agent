/**
 * Per-session reversible map behind Privacy Shield (ATO-599).
 *
 * `mask` swaps every private value `findPrivateSpans` finds for a stable
 * placeholder, `[EMAIL_1]`, `[CARD_2]`, `[SECRET_1]`: the same value
 * always gets the same placeholder for the life of the vault, so a
 * request built from the same history masks to the same bytes (the
 * cloud's prompt cache keeps working) and the model can refer to "the
 * address in [EMAIL_1]" across turns. `unmask` puts the values back on
 * this machine, in the reply and in tool-call arguments, before anything
 * runs. The idea is Hermes' vault handle (the model holds an opaque
 * handle, the local side holds the value) applied to any text.
 *
 * The map lives in memory only and is never written anywhere: the
 * session history keeps the real text (it is local), and a new process
 * builds a new map from it.
 *
 * Once a value has been masked it is masked everywhere it appears later,
 * even in a context the detector would not recognise on its own (a key
 * first seen as `API_KEY=…`, later pasted bare).
 */

import type { KnownSecret } from "../error-reporting/secret-detector.js";
import { findPrivateSpans, findSecretSpans, PRIVATE_KINDS, type PrivateKind } from "./detect-private-data.js";

/** `[EMAIL_1]` and friends; anything else in square brackets is left alone. */
export const PLACEHOLDER = /\[(SECRET|IBAN|CARD|EMAIL|PHONE)_(\d{1,6})\]/g;

/** Shortest value the exact-match pass reapplies; shorter ones would shred ordinary words. */
const MIN_REAPPLY_LENGTH = 6;
const LITERAL_REFERENCE = /^\[(?:SECRET|IBAN|CARD|EMAIL|PHONE)_\d{1,6}\]$/;

/** Deepest nesting the deep walkers visit; anything below is left as is. */
const MAX_DEPTH = 32;
const MAX_CACHE_CHARS = 3 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 2048;
const MAX_ARCHIVE_CHARS = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;

export interface PrivacyVaultStats {
  /** Distinct values this vault has masked so far. */
  distinct: number;
  /** The same, by kind. */
  byKind: Record<PrivateKind, number>;
  /** Distinct values in the most recent `beginRequest` … mask calls. */
  lastRequest: number;
  /** Requests that had at least one value masked. */
  maskedRequests: number;
}

export interface UnmaskOptions {
  /**
   * The text is the inside of a JSON string (tool-call arguments as they
   * stream): values are inserted JSON-escaped, so a quote or a backslash
   * in a real value cannot break the arguments.
   */
  json?: boolean;
}

export class PrivacyVault {
  readonly #byValue = new Map<string, string>();
  #archiveChars = 0;
  readonly #byPlaceholder = new Map<string, string>();
  private readonly counters: Record<PrivateKind, number> = {
    SECRET: 0,
    IBAN: 0,
    CARD: 0,
    EMAIL: 0,
    PHONE: 0,
  };
  /** Values reapplied by exact match, longest first; rebuilt lazily. */
  #reapply: string[] | null = null;
  readonly #maskCache = new Map<string, { masked: string; references: Set<string>; chars: number }>();
  #maskCacheChars = 0;
  #knownCacheKey = "";
  private lastRequest = 0;
  private maskedRequests = 0;

  /** `known` is read on every mask: the agent's own keys, which can change. */
  constructor(private readonly known: () => readonly KnownSecret[] = () => []) {}

  /** The placeholder for `value`, minted on first sight. */
  private placeholderFor(value: string, kind: PrivateKind): string {
    const existing = this.#byValue.get(value);
    if (existing !== undefined) return existing;
    if (this.#byValue.size >= MAX_ARCHIVE_ENTRIES || this.#archiveChars + value.length > MAX_ARCHIVE_CHARS) {
      throw new Error("Privacy Shield archive limit reached");
    }
    this.#archiveChars += value.length;
    this.counters[kind] += 1;
    const placeholder = `[${kind}_${this.counters[kind]}]`;
    this.#byValue.set(value, placeholder);
    this.#byPlaceholder.set(placeholder, value);
    this.#reapply = null;
    this.clearMaskCache();
    return placeholder;
  }

  beginRequest(): Set<string> {
    return new Set();
  }

  endRequest(request: ReadonlySet<string>): void {
    this.lastRequest = request.size;
    if (this.lastRequest > 0) this.maskedRequests += 1;
  }

  /**
   * `text` with every private value replaced by its placeholder. `known`
   * defaults to the vault's own source; {@link maskDeep} reads it once
   * for a whole request.
   */
  mask(text: string, known: readonly KnownSecret[] = this.known(), request?: Set<string>): string {
    if (text.length === 0) return text;
    const spans = findPrivateSpans(text, known);
    const escapeLiterals = (plain: string): string => plain.replace(PLACEHOLDER, (literal) => {
      const reference = this.placeholderFor(literal, "SECRET");
      request?.add(reference);
      return reference;
    });
    let out: string;
    if (spans.length > 0) {
      const parts: string[] = [];
      let last = 0;
      for (const span of spans) {
        parts.push(escapeLiterals(text.slice(last, span.start)));
        const placeholder = this.placeholderFor(span.value, span.kind);
        request?.add(placeholder);
        parts.push(placeholder);
        last = span.end;
      }
      parts.push(escapeLiterals(text.slice(last)));
      out = parts.join("");
    } else {
      out = escapeLiterals(text);
    }
    if (this.#byValue.size === 0) return out;
    this.#reapply ??= [...this.#byValue.keys()]
      .filter((v) => v.length >= MIN_REAPPLY_LENGTH && !LITERAL_REFERENCE.test(v))
      .sort((a, b) => b.length - a.length);
    for (const value of this.#reapply) {
      if (!out.includes(value)) continue;
      const placeholder = this.#byValue.get(value)!;
      request?.add(placeholder);
      out = out.split(value).join(placeholder);
    }
    return out;
  }

  /** `text` with every placeholder this vault minted put back. Unknown ones stay. */
  unmask(text: string, options: UnmaskOptions = {}): string {
    if (this.#byPlaceholder.size === 0 || !text.includes("[")) return text;
    PLACEHOLDER.lastIndex = 0;
    return text.replace(PLACEHOLDER, (match) => {
      const value = this.#byPlaceholder.get(match);
      if (value === undefined) return match;
      return options.json ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  private clearMaskCache(): void {
    this.#maskCache.clear();
    this.#maskCacheChars = 0;
  }

  private maskCached(text: string, known: readonly KnownSecret[], request?: Set<string>): string {
    let entry = this.#maskCache.get(text);
    if (!entry) {
      const references = new Set<string>();
      const masked = this.mask(text, known, references);
      entry = { masked, references, chars: text.length + masked.length };
      if (entry.chars <= MAX_CACHE_CHARS) {
        while (this.#maskCache.size >= MAX_CACHE_ENTRIES ||
          this.#maskCacheChars + entry.chars > MAX_CACHE_CHARS) {
          const oldest = this.#maskCache.keys().next().value!;
          this.#maskCacheChars -= this.#maskCache.get(oldest)!.chars;
          this.#maskCache.delete(oldest);
        }
        this.#maskCache.set(text, entry);
        this.#maskCacheChars += entry.chars;
      }
    }
    if (request) for (const reference of entry.references) request.add(reference);
    return entry.masked;
  }

  /**
   * Mask every string inside plain objects and arrays. A named JSON field
   * is decoded before masking so escaping cannot hide a private value.
   */
  maskDeep<T>(value: T, options: { jsonField?: string; request?: Set<string> } = {}): T {
    const known = this.known();
    const knownKey = JSON.stringify(known);
    if (knownKey !== this.#knownCacheKey) {
      this.clearMaskCache();
      this.#knownCacheKey = knownKey;
    }
    const mask = (text: string): string => this.maskCached(text, known, options.request);
    return mapStrings(value, (text, key) => {
      if (key === undefined || key !== options.jsonField) return mask(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return mask(text);
      }
      const masked = mapStrings(parsed, (value, field) => {
        if (field !== undefined && secretAssignment(field, value)) {
          const placeholder = this.placeholderFor(value, "SECRET");
          options.request?.add(placeholder);
          return placeholder;
        }
        return mask(value);
      });
      return masked === parsed ? text : JSON.stringify(masked);
    }) as T;
  }

  /** {@link unmask} on every string inside plain objects and arrays. */
  unmaskDeep<T>(value: T): T {
    if (this.#byPlaceholder.size === 0) return value;
    return mapStrings(value, (s) => this.unmask(s)) as T;
  }

  /** Whether this vault has masked anything yet. */
  get isEmpty(): boolean {
    return this.#byValue.size === 0;
  }

  stats(): PrivacyVaultStats {
    const byKind = Object.fromEntries(PRIVATE_KINDS.map((k) => [k, this.counters[k]])) as Record<
      PrivateKind,
      number
    >;
    return {
      distinct: this.#byValue.size,
      byKind,
      lastRequest: this.lastRequest,
      maskedRequests: this.maskedRequests,
    };
  }
}

/** Reuse assignment detection for a decoded JSON property, with its original field name. */
function secretAssignment(field: string, value: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(field)) return false;
  const quote = value.includes('"') ? "'" : '"';
  const prefix = `${field}=${quote}`;
  return findSecretSpans(`${prefix}${value}${quote}`).some(
    span => span.start === prefix.length && span.value === value,
  );
}

/**
 * `value` with `fn` applied to every string inside it. Plain objects and
 * arrays are copied only on the path to a changed string, so the input
 * is never mutated and an unchanged value comes back as itself.
 */
function mapStrings(
  value: unknown,
  fn: (s: string, key?: string) => string,
  depth = 0,
  key?: string,
): unknown {
  if (typeof value === "string") return fn(value, key);
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = mapStrings(value[i], fn, depth + 1);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = mapStrings(child, fn, depth + 1, key);
    if (next !== child) {
      out ??= { ...(value as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return out ?? value;
}
