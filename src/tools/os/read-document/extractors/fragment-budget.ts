import { DEFAULT_DOCUMENT_MAX_BYTES } from "./extractor-types.js";

const MAX_FRAGMENTS = 4096;
const MAX_FRAGMENT_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_WORK = 3 * 1024 * 1024;

/** Bound the total work even when a container repeats the same fragment. */
export class FragmentBudget {
  #parts = 0;
  #bytes = 0;
  #work = 0;
  #exhausted = false;
  #formattingLimited = false;
  readonly maxOutputBytes: number;
  readonly #inputLimit: number;
  readonly #workLimit: number;

  constructor(maxBytes = DEFAULT_DOCUMENT_MAX_BYTES) {
    this.maxOutputBytes = maxBytes;
    this.#inputLimit = Math.min(64 * 1024 * 1024, Math.max(MAX_FRAGMENT_BYTES, maxBytes * 5));
    this.#workLimit = Math.min(MAX_RENDER_WORK, Math.max(128 * 1024, Math.floor(maxBytes * 0.3)));
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get canFormat(): boolean {
    return !this.#formattingLimited;
  }

  canTake(bytes: number): boolean {
    return !this.#exhausted && this.#parts < MAX_FRAGMENTS && bytes <= this.#inputLimit - this.#bytes;
  }

  take(bytes: number): number | undefined {
    if (!this.canTake(bytes) && (this.#exhausted || this.#parts > 0)) {
      this.#exhausted = true;
      return undefined;
    }
    // A first fragment that exceeds the input cap can still show a prefix.
    const accepted = Math.min(bytes, this.#inputLimit - this.#bytes);
    this.#parts++;
    this.#bytes += accepted;
    return accepted;
  }

  /** Once formatting is exhausted, subsequent fragments can use plain text. */
  takeWork(work: number, wholeDocument = false): boolean {
    if (!wholeDocument && (this.#formattingLimited || work > this.#workLimit - this.#work)) {
      this.#formattingLimited = true;
      return false;
    }
    this.#work += work;
    this.#formattingLimited = this.#work >= this.#workLimit;
    return true;
  }

  noteTruncation(): void {
    this.#exhausted = true;
  }
}

/** Account for the bytes actually displayed, including framing and metadata. */
export class FragmentOutput {
  #used = 0;
  #hasItem = false;
  truncated = false;
  stopped = false;
  partialItem = false;
  framingLimited = false;
  attachmentListingLimited = false;

  constructor(readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.#used;
  }

  append(value: string): string {
    const limit = this.remaining;
    const size = Buffer.byteLength(value);
    if (size <= limit) {
      this.#used += size;
      return value;
    }
    this.truncated = true;
    if (limit === 0) return "";
    const bytes = Buffer.from(value);
    let end = limit;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    this.#used += end;
    return bytes.toString("utf8", 0, end);
  }

  appendItem(prefix: string, value: string, clipped = false, compactPrefix = prefix): {
    text: string;
    status: "complete" | "deferred" | "partial";
  } {
    const valueBytes = Buffer.byteLength(value);
    let prefixBytes = Buffer.byteLength(prefix);
    if (!clipped && prefix !== compactPrefix && prefixBytes + valueBytes > this.limit) {
      const compactBytes = Buffer.byteLength(compactPrefix);
      if (compactBytes + valueBytes <= this.limit) {
        prefix = compactPrefix;
        prefixBytes = compactBytes;
      }
    }
    const size = prefixBytes + valueBytes;
    if (valueBytes > 0 && size > this.remaining &&
        this.remaining - prefixBytes < Buffer.byteLength(String.fromCodePoint(value.codePointAt(0)!))) {
      this.framingLimited = !this.#hasItem;
      this.stop();
      return { text: "", status: "deferred" };
    }
    const fitsFresh = !clipped && Buffer.byteLength(prefix.trimStart()) + valueBytes <= this.limit;
    if (this.#hasItem && size > this.remaining && (fitsFresh || this.remaining <= prefixBytes)) {
      this.stopped = this.truncated = true;
      return { text: "", status: "deferred" };
    }
    const partial = clipped || size > this.remaining;
    const text = this.append(prefix + value);
    this.#hasItem = true;
    if (partial) this.partialItem = this.stopped = this.truncated = true;
    return { text, status: partial ? "partial" : "complete" };
  }

  stop(): void {
    this.stopped = this.truncated = true;
  }
}
