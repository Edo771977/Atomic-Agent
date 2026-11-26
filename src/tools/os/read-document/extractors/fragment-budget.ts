const MAX_FRAGMENTS = 128;
const MAX_FRAGMENT_BYTES = 16 * 1024 * 1024;

/** Bound the total work even when a container repeats the same fragment. */
export class FragmentBudget {
  #parts = 0;
  #bytes = 0;
  #exhausted = false;

  get exhausted(): boolean {
    return this.#exhausted;
  }

  take(bytes: number): boolean {
    if (this.#exhausted || this.#parts >= MAX_FRAGMENTS || bytes > MAX_FRAGMENT_BYTES - this.#bytes) {
      this.#exhausted = true;
      return false;
    }
    this.#parts++;
    this.#bytes += bytes;
    return true;
  }
}
