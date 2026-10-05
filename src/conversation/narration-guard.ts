/**
 * Incremental guard for streaming narration.
 *
 * `stripExecutionLeakage` cleans a finished reply, but a live stream cannot
 * clean text it has already shown. This guard holds back any text that could
 * still turn out to be leakage and emits only the prefix that is provably
 * safe, so the narration/execution separation rule holds *during* streaming,
 * not just at the end.
 *
 * Withheld cases:
 *   - anything inside an unterminated ``` fence;
 *   - anything from an unbalanced `{`, which could still become an inline JSON
 *     tool payload such as `{"tool_calls": [{"command": "rm -rf ...`;
 *   - a trailing partial line that has begun to look like a reasoning header.
 *
 * The guard is deliberately conservative: withholding too much only costs a
 * moment of latency, while withholding too little would put raw tool-call
 * text on screen.
 */

import { stripExecutionLeakage } from './narration.js';

const FENCE = '```';

/**
 * Length of a trailing run of one or two backticks at the end of the text.
 *
 * Such a run is a fence that may still be completed by the next chunk.
 */
function trailingFencePrefix(text: string): number {
  let count = 0;
  while (
    count < 2 &&
    count < text.length &&
    text[text.length - 1 - count] === '`'
  ) {
    count += 1;
  }
  return text.length - count;
}

export class NarrationStreamGuard {
  /** Text received but not yet known to be safe to show. */
  #buffered = '';
  /** Whether an odd number of fences is currently open. */
  #insideFence = false;
  /** Unbalanced `{` depth at the end of what has been received. */
  #depth = 0;

  /**
   * Adds a chunk and returns the safe prefix to display now.
   *
   * Returns an empty string when nothing is provably safe yet, which is the
   * common case for a chunk that opens a payload.
   */
  public push(chunk: string): string {
    if (chunk === '') return '';
    this.#buffered += chunk;
    const boundary = this.#safeBoundary();
    if (boundary <= 0) return '';
    const safe = this.#buffered.slice(0, boundary);
    this.#buffered = this.#buffered.slice(boundary);
    return safe;
  }

  /**
   * Ends the stream and returns whatever is left.
   *
   * The final text is passed through the same whole-text rules as a
   * non-streamed reply, so the end of a stream can never smuggle in a payload
   * the incremental guard was still holding.
   */
  public flush(): string {
    const remainder = this.#buffered;
    this.#buffered = '';
    this.#insideFence = false;
    this.#depth = 0;
    return stripStreamingTail(remainder);
  }

  /**
   * Index just past the last position that is safe to emit.
   *
   * Scans left to right and stops emitting permanently at the first sign of
   * leakage. It deliberately does *not* resume afterwards: a live stream
   * cannot un-show text, so anything after a suspected payload is withheld
   * until the stream ends and the whole-text rules run over the remainder.
   * That costs a pause in the live preview, never correctness.
   */
  #safeBoundary(): number {
    const text = this.#buffered;
    let fence = this.#insideFence;
    let depth = this.#depth;

    for (let index = 0; index < text.length; index += 1) {
      if (text.startsWith(FENCE, index)) {
        fence = !fence;
        // Withhold from the fence's first backtick, not from inside it.
        if (fence) return index;
        index += FENCE.length - 1;
        continue;
      }

      const char = text[index];
      if (char === '{') {
        depth += 1;
        return index; // could still become an inline tool payload
      }
      if (char === '}') {
        depth = Math.max(0, depth - 1);
        continue;
      }

      if (fence || depth > 0) continue;
    }

    this.#insideFence = fence;
    this.#depth = depth;
    // A chunk that ends mid-fence (one or two backticks) must not be shown:
    // the next chunk could complete the fence, and showing the opening would
    // let the enclosed content leak.
    return trailingFencePrefix(text);
  }
}

/**
 * Final safety net applied to whatever the guard still held.
 *
 * Complete fenced blocks are dropped whole, and an unterminated trailing fence
 * takes the rest of the stream with it. Text that merely followed a *closed*
 * fence survives, so an early code block does not swallow the whole reply.
 */
function stripStreamingTail(text: string): string {
  const withoutBlocks = text.replace(
    new RegExp(`${FENCE}[\\s\\S]*?${FENCE}`, 'g'),
    '',
  );
  const withoutTrailingFence = withoutBlocks.replace(
    new RegExp(`${FENCE}[\\s\\S]*$`),
    '',
  );
  return stripExecutionLeakage(withoutTrailingFence);
}
