/**
 * Per-session accounting for the status surface.
 *
 * Display only: it counts what this session has used and nothing more. There is
 * no persisted history and no cost calculation, because a cost figure Atlas
 * cannot derive accurately is worse than none.
 *
 * A context window is optional and is never guessed. Providers do not report
 * one consistently, so Atlas shows a real token count and, when a window is
 * configured, a real percentage. Otherwise it says the window is unknown.
 */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SessionStats {
  /** Turns completed in this session. */
  readonly turns: number;
  /** Tool calls executed in this session. */
  readonly toolCalls: number;
  /** Sum of provider-reported usage across the session. */
  readonly usage: TokenUsage;
}

export function emptyStats(): SessionStats {
  return { turns: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 } };
}

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (b === undefined) return a;
  return {
    inputTokens:
      a.inputTokens + (Number.isFinite(b.inputTokens) ? b.inputTokens : 0),
    outputTokens:
      a.outputTokens + (Number.isFinite(b.outputTokens) ? b.outputTokens : 0),
  };
}

/** Records a completed turn. Pure, so the totals are testable. */
export function recordTurn(
  stats: SessionStats,
  usage: TokenUsage | undefined,
): SessionStats {
  return {
    ...stats,
    turns: stats.turns + 1,
    usage: addUsage(stats.usage, usage),
  };
}

/** Records an executed tool call. */
export function recordToolCall(stats: SessionStats): SessionStats {
  return { ...stats, toolCalls: stats.toolCalls + 1 };
}

/** Pluralizes a count for the status line: 1 turn, 2 turns. */
export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export interface StatusLineParts {
  readonly model: string;
  readonly provider: string;
  readonly stats: SessionStats;
  readonly contextWindow?: number | undefined;
}

/**
 * Builds the status line as plain segments.
 *
 * Segments are returned separately from their separator so a caller can render
 * them without color, and so tests can assert on content rather than glyphs.
 */
export function statusSegments(input: StatusLineParts): readonly string[] {
  return [
    `${input.provider}/${input.model}`,
    pluralize(input.stats.turns, 'turn'),
    pluralize(input.stats.toolCalls, 'tool call'),
  ];
}
