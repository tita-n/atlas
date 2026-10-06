/**
 * Separating model reasoning from the answer the user should see.
 *
 * Reasoning reaches a harness in two unrelated ways. Providers with a dedicated
 * reasoning channel send it in a separate field, which must be kept out of the
 * narration stream entirely. Open-weight models served through free routers
 * instead write it inline, wrapped in tags, and that inline form has three real
 * shapes - not one:
 *
 *   complete      <think>...</think> answer
 *   unterminated  <think>...            (output budget ran out mid-reasoning)
 *   bare closer   ...</think> answer     (no opening tag at all)
 *
 * The bare-closer and unterminated cases are the ones that break naive
 * handling. A regex needing both tags never matches an unterminated block, so
 * the entire reasoning fragment survives into the reply - which is exactly the
 * reported failure, where the user saw raw reasoning and then nothing.
 *
 * This is incremental by construction: tags routinely straddle stream chunks
 * (`<th` in one, `ink>` in the next), so text is only released once it cannot
 * turn out to be part of a tag or of a reasoning span.
 */

/**
 * How much leading content is held before deciding it is not reasoning.
 *
 * The bare-closer shape puts reasoning FIRST, so a closer can arrive after text
 * has already been released - and released text cannot be retracted. The only
 * way to catch it is to hold the opening of the response for a bounded window.
 * Past that window the stream is treated as ordinary narration, which keeps
 * latency bounded at the cost of missing an unusually long unclosed block.
 */
export const LEADING_HOLD_CHARS = 128;

export const OPEN_TAG = '<think>';
export const CLOSE_TAG = '</think>';

/** Longest prefix of either tag that could still be completed. */
const MAX_TAG_PREFIX = OPEN_TAG.length;

/**
 * Whether the buffered opening reads like an answer rather than a monologue.
 *
 * Structured text - a line break, a list, a heading - is overwhelmingly an
 * answer; reasoning traces are prose without shape. Releasing on that signal
 * keeps the cost of the leading hold to one chunk for ordinary replies.
 */
function looksLikeProse(text: string): boolean {
  return /[\n]\s*(?:[-*#]|\d+[.)])\s|\n\n|\n- /.test(text);
}

/** Trailing run of characters that might be the start of a tag. */
function partialTagLength(text: string): number {
  // Up to the full tag length, not one short: `</think` is the whole closer
  // minus its final character, and must still be held rather than misread as
  // reasoning content.
  for (
    let length = Math.min(MAX_TAG_PREFIX, text.length);
    length > 0;
    length -= 1
  ) {
    const tail = text.slice(text.length - length);
    if (OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail)) return length;
  }
  return 0;
}

export interface ReasoningSplit {
  /** Text the user should see. */
  readonly narration: string;
  /** Reasoning seen so far. Never merged into narration. */
  readonly reasoning: string;
  /** True while the stream is still inside an opening-tagged block. */
  readonly insideReasoning: boolean;
  /** True when a closer arrived with no opener: earlier text was reasoning. */
  readonly sawBareCloser: boolean;
}

/**
 * Incremental reasoning filter.
 *
 * Feed it the content stream; it hands back whatever is now safe to show.
 */
export class ReasoningFilter {
  #held = '';
  #reasoning = '';
  #inside = false;
  #sawBareCloser = false;
  /** Whether narration has been handed to the caller. */
  #released = false;
  /** Narration produced during the leading hold; still retractable. */
  #leadingHeld = '';

  /** Whether the stream is currently inside an opening-tagged block. */
  public get insideReasoning(): boolean {
    return this.#inside;
  }

  /** True when a closer arrived with no matching opener. */
  public get sawBareCloser(): boolean {
    return this.#sawBareCloser;
  }

  /** Reasoning accumulated so far. */
  public get reasoning(): string {
    return this.#reasoning;
  }

  /** Text the user should see, deferred until known to be safe. */
  public get pending(): string {
    return this.#held;
  }

  /**
   * Feeds a chunk and returns the narration it released.
   *
   * Returns an empty string while text is still ambiguous, which is what keeps
   * a half-arrived `<th` from ever reaching the screen.
   */
  public push(chunk: string): string {
    if (chunk === '') return '';
    this.#held += chunk;
    return this.#drain(false);
  }

  /**
   * Ends the stream and returns whatever narration remains safe to show.
   *
   * A stream that ends inside a reasoning block yields nothing: there was no
   * answer, and showing the fragment would present an incomplete generation as
   * a reply.
   */
  public finish(): string {
    const out = this.#drain(true);
    // Anything still inside the opening hold is ordinary narration now that
    // the stream has ended without a bare closer.
    if (this.#leadingHeld !== '') {
      const held = this.#leadingHeld;
      this.#leadingHeld = '';
      this.#released = true;
      return out + held;
    }
    return out;
  }

  /** Whether any real answer content was ever produced. */
  public get producedAnswer(): boolean {
    return this.#sawAnswer;
  }
  #sawAnswer = false;

  #drain(final: boolean): string {
    let narration = '';
    let index = 0;

    while (index < this.#held.length) {
      if (this.#inside) {
        const close = this.#held.indexOf(CLOSE_TAG, index);
        if (close === -1) {
          // Everything left is reasoning, except a trailing partial closer that
          // a later chunk may still complete. Consuming that tail as reasoning
          // would swallow the closer and leak the answer that follows it.
          const tail = final ? 0 : partialTagLength(this.#held.slice(index));
          const reasoning = this.#held.slice(index, this.#held.length - tail);
          this.#reasoning += reasoning;
          this.#held = this.#held.slice(this.#held.length - tail);
          index = this.#held.length;
          continue;
        }
        this.#reasoning += this.#held.slice(index, close);
        this.#held = this.#held.slice(close + CLOSE_TAG.length);
        this.#inside = false;
        index = 0;
        continue;
      }

      const open = this.#held.indexOf(OPEN_TAG, index);
      const close = this.#held.indexOf(CLOSE_TAG, index);
      const nextOpen = open === -1 ? Infinity : open;
      const nextClose = close === -1 ? Infinity : close;

      if (nextOpen === Infinity && nextClose === Infinity) {
        // Hold the opening of the response: a bare closer may still arrive and
        // turn everything released so far into reasoning.
        if (
          !final &&
          !this.#released &&
          this.#held.length <= LEADING_HOLD_CHARS &&
          !looksLikeProse(this.#held)
        ) {
          break;
        }
        if (!this.#released) {
          // Past the bound: this is ordinary narration, so release it and stop
          // treating later text as retractable.
          this.#released = true;
          this.#leadingHeld = '';
          narration += this.#held;
          if (this.#held.trim() !== '') this.#sawAnswer = true;
          this.#held = '';
          index = 0;
          continue;
        }
        const tail = final ? 0 : partialTagLength(this.#held.slice(index));
        const emit = this.#held.slice(index, this.#held.length - tail);
        this.#held = this.#held.slice(this.#held.length - tail);
        narration += emit;
        if (emit.trim() !== '') this.#sawAnswer = true;
        this.#released = true;
        index = this.#held.length;
        continue;
      }

      if (nextClose < nextOpen) {
        // A bare closer with no opener: everything before it was reasoning,
        // including anything held back during the leading hold.
        if (this.#released) {
          this.#reasoning += this.#leadingHeld;
          this.#leadingHeld = '';
        } else {
          this.#reasoning += this.#held.slice(index, close);
        }
        this.#held = this.#held.slice(close + CLOSE_TAG.length);
        this.#sawBareCloser = true;
        this.#sawAnswer = false;
        index = 0;
        continue;
      }

      // An opening tag: text before it is the answer so far.
      const before = this.#held.slice(index, open);
      narration += before;
      if (before.trim() !== '') this.#sawAnswer = true;
      this.#released = true;
      this.#held = this.#held.slice(open + OPEN_TAG.length);
      this.#inside = true;
      index = 0;
    }

    return narration;
  }
}

/** One-shot split for a complete, non-streamed response. */
export function splitReasoning(text: string): ReasoningSplit {
  const filter = new ReasoningFilter();
  const narration = filter.push(text) + filter.finish();
  return {
    narration,
    reasoning: filter.reasoning,
    insideReasoning: filter.insideReasoning,
    sawBareCloser: filter.sawBareCloser,
  };
}
