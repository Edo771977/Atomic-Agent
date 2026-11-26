const MAX_FRAGMENTS = 128;
const MAX_FRAGMENT_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_WORK = 1536 * 1024;
const MAX_TEXT_CHARS = 5 * 1024 * 1024;

/** Bound the total work even when a container repeats the same fragment. */
export class FragmentBudget {
  #parts = 0;
  #bytes = 0;
  #work = 0;
  #text = 0;
  #exhausted = false;
  #formattingLimited = false;

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get textRemaining(): number {
    return MAX_TEXT_CHARS - this.#text;
  }

  get canFormat(): boolean {
    return !this.#formattingLimited;
  }

  canTake(bytes: number): boolean {
    return !this.#exhausted && this.#parts < MAX_FRAGMENTS && bytes <= MAX_FRAGMENT_BYTES - this.#bytes;
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
    if (this.#formattingLimited || work > MAX_RENDER_WORK - this.#work) {
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
