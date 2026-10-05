/**
 * Progressive reveal for assistant replies.
 *
 * Atlas resolves a whole turn before rendering it (see docs/tui-design.md
 * section 3), so this replays finished text a few words at a time. It is
 * presentation only: it never changes what gets said, only when each piece
 * becomes visible.
 *
 * The step size is expressed in words and the animation is time-based, so a
 * slow terminal shows the same text in the same order, just less smoothly.
 * With a zero interval the full text is yielded at once.
 */

export interface RevealOptions {
  /** Milliseconds between chunks. Zero or less yields everything at once. */
  readonly intervalMs?: number;
  /** Words revealed per chunk. */
  readonly wordsPerChunk?: number;
  /** Injected sleep, so tests do not depend on wall-clock timing. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 28;
const DEFAULT_WORDS_PER_CHUNK = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits text into reveal chunks on word boundaries.
 *
 * Splitting on spaces and rejoining with the original separators keeps
 * whitespace, indentation, and blank lines exactly as written, which matters
 * for code blocks in the detail panel.
 */
export function chunkText(
  text: string,
  wordsPerChunk: number = DEFAULT_WORDS_PER_CHUNK,
): string[] {
  if (text === '') return [];
  const size = Math.max(1, Math.floor(wordsPerChunk));
  // Capture the whitespace after each word so it travels with that word.
  const tokens = text.match(/\S+\s*/g) ?? [text];
  if (tokens.length === 0) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += size) {
    chunks.push(tokens.slice(i, i + size).join(''));
  }
  return chunks;
}

/**
 * Yields the text in chunks.
 *
 * The first chunk is yielded immediately so a reply never appears after a
 * visible delay.
 */
export async function* revealText(
  text: string,
  options: RevealOptions = {},
): AsyncGenerator<string, void, undefined> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const chunks = chunkText(
    text,
    options.wordsPerChunk ?? DEFAULT_WORDS_PER_CHUNK,
  );
  if (chunks.length === 0) return;
  for (const chunk of chunks) {
    yield chunk;
    if (intervalMs > 0 && chunk !== chunks[chunks.length - 1]) {
      await sleep(intervalMs);
    }
  }
}

/** The whole text, for when animation is unavailable. */
export function revealInstantly(text: string): string {
  return text;
}

/**
 * Whether to animate the reveal at all.
 *
 * Reduced-motion support and a low frame budget both mean "do not animate",
 * and in that case callers should render the text in one piece.
 */
export function shouldReveal(options: { animate: boolean }): boolean {
  return options.animate;
}
