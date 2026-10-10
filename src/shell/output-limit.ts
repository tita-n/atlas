/**
 * Caps how much shell output is handed to the model and stored in history.
 *
 * Without a cap, one command such as `seq 1 200000` puts a megabyte of text
 * into the conversation, which is replayed on every later turn. That burns
 * tokens, costs money, and can make the session unrecoverable once the
 * request exceeds the model's context window.
 */

/** Default character budget for one tool result. */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 30_000;

/** Default cap for a single output line, so minified files cannot dominate. */
export const DEFAULT_MAX_LINE_CHARS = 2_000;

const TRUNCATION_MARKER = ['', '[output truncated by Atlas]', ''].join('\n');

/** Result of clamping a stream of shell output. */
export interface TruncatedOutput {
  /** Text safe to send to the model, with markers where text was removed. */
  readonly text: string;
  /** Whether anything was removed. */
  readonly truncated: boolean;
  /** Character count before truncation. */
  readonly originalChars: number;
  /** Character count actually kept. */
  readonly keptChars: number;
}

function marker(
  originalChars: number,
  keptChars: number,
  maxChars: number,
): string {
  return (
    `${TRUNCATION_MARKER}Showing the first and last part of ${originalChars} ` +
    `characters (kept ${keptChars} of ${maxChars} allowed). ` +
    'Re-run with a narrower command such as head, grep, or a smaller range ' +
    'to read the rest.'
  );
}

function clampLines(text: string, maxLineChars: number): string {
  if (!text.includes('\n')) {
    return text.length <= maxLineChars
      ? text
      : `${text.slice(0, maxLineChars)}… [+${text.length - maxLineChars} chars on this line]`;
  }
  return text
    .split('\n')
    .map((line) =>
      line.length <= maxLineChars
        ? line
        : `${line.slice(0, maxLineChars)}… [+${line.length - maxLineChars} chars on this line]`,
    )
    .join('\n');
}

/**
 * Clamps tool output to a character budget, keeping the head and the tail.
 *
 * The head carries the command result and the tail usually carries the error
 * or summary, so both ends matter more than the middle.
 */
export function truncateToolOutput(
  text: string,
  options: {
    readonly maxChars?: number;
    readonly maxLineChars?: number;
  } = {},
): TruncatedOutput {
  const maxChars = options.maxChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const originalChars = text.length;

  const lineClamped = clampLines(text, maxLineChars);
  if (lineClamped.length <= maxChars) {
    return {
      text: lineClamped,
      truncated: lineClamped.length !== originalChars,
      originalChars,
      keptChars: lineClamped.length,
    };
  }

  // The marker embeds the kept-character count, so its own length depends on
  // the budget it reserves. Solve for a fixed point instead of guessing, or
  // the result drifts a few characters over the cap.
  let budget = Math.max(
    0,
    maxChars - marker(originalChars, 0, maxChars).length - 1,
  );
  let head = '';
  let tail = '';
  let note = marker(originalChars, 0, maxChars);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headLength = Math.ceil(budget / 2);
    const tailLength = budget - headLength;
    head = lineClamped.slice(0, headLength);
    tail = tailLength > 0 ? lineClamped.slice(-tailLength) : '';
    const nextNote = marker(originalChars, head.length + tail.length, maxChars);
    if (nextNote.length === note.length) {
      note = nextNote;
      break;
    }
    note = nextNote;
    budget = Math.max(0, maxChars - note.length - 1);
  }

  const result = `${head}\n${note}${tail}`;
  return {
    text: result.length > maxChars ? result.slice(0, maxChars) : result,
    truncated: true,
    originalChars,
    keptChars: result.length,
  };
}

/** Reads the configured cap from the environment, ignoring invalid values. */
export function maxToolOutputChars(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.ATLAS_MAX_TOOL_OUTPUT_CHARS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  }
  return parsed;
}
