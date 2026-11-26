import { DEFAULT_DOCUMENT_MAX_BYTES } from "./extractor-types.js";

const MAX_FRAGMENTS = 4096;
const MAX_FRAGMENT_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_WORK = 3 * 1024 * 1024;

/** Bound the total work even when a container repeats the same fragment. */
export class FragmentBudget {
  #parts = 0;
  #bytes = 0;
  #work = 0;
  #text = 0;
  #exhausted = false;
  #formattingLimited = false;
  readonly #textLimit: number;
  readonly #inputLimit: number;
  readonly #workLimit: number;

  constructor(maxBytes = DEFAULT_DOCUMENT_MAX_BYTES) {
    this.#textLimit = maxBytes;
    this.#inputLimit = Math.min(64 * 1024 * 1024, Math.max(MAX_FRAGMENT_BYTES, maxBytes * 4));
    this.#workLimit = Math.min(MAX_RENDER_WORK, Math.max(128 * 1024, Math.floor(maxBytes * 0.3)));
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get textRemaining(): number {
    return this.#textLimit - this.#text;
  }

  get canFormat(): boolean {
    return !this.#formattingLimited;
  }

  canTake(bytes: number): boolean {
    return !this.#exhausted && this.#parts < MAX_FRAGMENTS &&
      (this.textRemaining > 0 || bytes === 0) && bytes <= this.#inputLimit - this.#bytes;
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
  takeWork(work: number): boolean {
    if (this.#formattingLimited || work > this.#workLimit - this.#work) {
      this.#formattingLimited = true;
      return false;
    }
    this.#work += work;
    return true;
  }

  includeText(value: string, cut = false): string {
    const limit = this.textRemaining;
    const size = Buffer.byteLength(value);
    if (size <= limit) {
      this.#text += size;
      this.#exhausted ||= cut;
      return value;
    }
    this.#exhausted = true;
    if (limit === 0) return "";
    const bytes = Buffer.from(value);
    let end = limit;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    this.#text += end;
    return bytes.toString("utf8", 0, end);
  }

  noteTruncation(): void {
    this.#exhausted = true;
  }
}
