/**
 * Bounded, append-friendly buffer for a shell output stream.
 *
 * A model-chosen command such as `yes` or `find /` can emit output far faster
 * than anyone can read it. Concatenating it all would grow without limit and
 * exhaust memory, and re-scanning the whole buffer for the completion marker
 * on every chunk is quadratic. This keeps a fixed head plus a rolling tail, so
 * memory is capped no matter how much a command writes, and the marker scan
 * only ever looks at recent text.
 */

/** Characters retained before the tail starts evicting the head. */
export const DEFAULT_STREAM_HEAD_CHARS = 1_000_000;

/** Characters retained from the end of the stream. */
export const DEFAULT_STREAM_TAIL_CHARS = 64_000;

/** Append-only stream buffer with a hard memory ceiling. */
export class BoundedStreamBuffer {
  #head = '';
  #tail = '';
  #droppedChars = 0;
  readonly #headLimit: number;
  readonly #tailLimit: number;

  public constructor(
    headLimit = DEFAULT_STREAM_HEAD_CHARS,
    tailLimit = DEFAULT_STREAM_TAIL_CHARS,
  ) {
    this.#headLimit = headLimit;
    this.#tailLimit = tailLimit;
  }

  /** Characters discarded so far because the stream exceeded the cap. */
  public get dropped(): number {
    return this.#droppedChars;
  }

  /** Appends a chunk, evicting the oldest head text when over budget. */
  public append(chunk: string): void {
    if (chunk === '') return;
    this.#head += chunk;
    if (this.#head.length <= this.#headLimit) return;

    // Move the overflow from the head into the rolling tail, then trim the
    // tail, so at most headLimit + tailLimit characters are ever retained.
    const overflow = this.#head.length - this.#headLimit;
    const moved = this.#head.slice(this.#headLimit);
    this.#head = this.#head.slice(0, this.#headLimit);
    this.#droppedChars += overflow;

    this.#tail += moved;
    if (this.#tail.length > this.#tailLimit) {
      const cut = this.#tail.length - this.#tailLimit;
      this.#tail = this.#tail.slice(cut);
      this.#droppedChars += cut;
    }
  }

  /**
   * Returns recent text, searching at most `window` characters from the end.
   *
   * The completion marker is always emitted at the very end of a command, so
   * a bounded window is sufficient and avoids rescanning megabytes per chunk.
   */
  public findFromEnd(needle: string, window = this.#tailLimit): number {
    const searchFrom = Math.max(
      0,
      this.#head.length + this.#tail.length - window,
    );
    return this.#headPlusTail().indexOf(needle, searchFrom);
  }

  /** Human-readable note about discarded output, or an empty string. */
  public droppedNotice(): string {
    return this.#droppedChars === 0
      ? ''
      : `[${this.#droppedChars} characters of earlier output were dropped by Atlas to stay within its memory limit]\n`;
  }

  /** Retained text up to `end`, or everything when `end` is not finite. */
  public prefix(end: number): string {
    const full = this.#headPlusTail();
    return Number.isFinite(end) ? full.slice(0, end) : full;
  }

  /** Full retained text: head, an elision marker if any, then the tail. */
  public toString(): string {
    if (this.#droppedChars === 0) return this.#head + this.#tail;
    return `${this.#head}\n[${this.#droppedChars} characters of earlier output were dropped]\n${this.#tail}`;
  }

  #headPlusTail(): string {
    return this.#head + this.#tail;
  }
}
