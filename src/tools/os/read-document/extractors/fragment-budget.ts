import { DEFAULT_DOCUMENT_MAX_BYTES } from "./extractor-types.js";

const MAX_FRAGMENTS = 128;
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
    return !this.#exhausted && this.#parts < MAX_FRAGMENTS && bytes <= this.#inputLimit - this.#bytes;
  }

  take(bytes: number): boolean {
    if (!this.canTake(bytes)) {
      this.#exhausted = true;
      return false;
    }
    this.#parts++;
    this.#bytes += bytes;
    return true;
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
    const text = value.slice(0, limit);
    this.#text += text.length;
    this.#exhausted ||= cut || value.length > limit;
    return text;
  }
}
