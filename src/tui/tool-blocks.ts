/**
 * How much tool output to show, and how to summarise what is hidden.
 *
 * A single global expand/collapse toggle does not work in practice: the people
 * who build these terminals report that a global toggle is all-or-nothing and
 * users leave it off, because most tool output is noise and the few tools that
 * matter get lost with it. So collapse is decided per tool and per block, and
 * each block expands on its own.
 *
 * The thresholds differ by tool because the output does: a directory listing or
 * a file read is short and mostly noise, while shell output is where a
 * command's actual effect shows up.
 */

/** Lines kept visible once a block is expanded. */
export const DEFAULT_COLLAPSE_LINES = 3;

/** Shell output is worth more context than a generic tool's. */
export const SHELL_COLLAPSE_LINES = 10;

/** Tool names treated as shell-like, which get the larger threshold. */
const SHELL_TOOLS = new Set(['shell', 'bash', 'sh', 'run', 'exec', 'command']);

/** Whether a tool's output counts as shell-like. */
export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase());
}

/** Visible line count for a tool, before any user preference. */
export function collapseLinesFor(toolName: string): number {
  return isShellTool(toolName) ? SHELL_COLLAPSE_LINES : DEFAULT_COLLAPSE_LINES;
}

export interface CollapsedBlock {
  /** Lines shown while collapsed. */
  readonly preview: readonly string[];
  /** Lines deliberately hidden, for the "+N" indicator. */
  readonly hidden: number;
}

/**
 * Shortens output to a preview.
 *
 * Counts only non-blank lines toward the threshold, so trailing blank space
 * cannot make a block look longer than its content.
 */
export function collapseOutput(output: string, limit: number): CollapsedBlock {
  const lines = output.split('\n');
  // Trailing newline from a command should not count as content.
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '')
    lines.pop();
  if (lines.length <= limit) {
    return { preview: lines, hidden: 0 };
  }
  return { preview: lines.slice(0, limit), hidden: lines.length - limit };
}

export type ToolStatus = 'running' | 'succeeded' | 'failed';

/** One-line summary shown while a tool block is collapsed. */
export interface ToolSummary {
  readonly icon: string;
  readonly label: string;
  /** Right-hand side: timing, exit code, or the hidden-line count. */
  readonly annotation: string;
}

/**
 * Formats the collapsed one-liner.
 *
 * The status word is always present in text form, never only as a colour or a
 * glyph, so the state survives with colour disabled.
 */
export function summarizeTool(input: {
  readonly toolName: string;
  readonly status: ToolStatus;
  readonly argument: string;
  readonly detail: string;
  readonly durationMs?: number | undefined;
  readonly exitCode?: number | null | undefined;
}): ToolSummary {
  const icon =
    input.status === 'running' ? '⟳' : input.status === 'failed' ? '✗' : '✓';
  const label = `${icon} ${input.toolName}`;
  const parts: string[] = [];

  if (input.status === 'running') {
    parts.push('running');
  } else {
    const { hidden } = collapseOutput(
      input.detail,
      collapseLinesFor(input.toolName),
    );
    if (hidden > 0) parts.push(`+${hidden} lines`);
    if (input.exitCode !== undefined && input.exitCode !== null) {
      parts.push(`exit ${input.exitCode}`);
    }
    if (parts.length === 0) parts.push(input.status);
  }
  if (input.durationMs !== undefined) parts.push(`${input.durationMs}ms`);

  return { icon, label, annotation: parts.join(' · ') };
}

/** Formats token counts compactly: 1234 -> 1.2k, 1234567 -> 1.2M. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * A proportional bar for context usage.
 *
 * Rendering degrades to text when a bar cannot be drawn faithfully: without a
 * known context window there is no honest ratio to show, so Atlas shows the
 * token count and says the window is unknown rather than inventing one.
 */
export function contextBar(input: {
  readonly tokens: number;
  readonly contextWindow?: number | undefined;
  readonly width?: number;
}): { bar: string; percent: number | null; text: string } {
  const width = input.width ?? 10;
  const used = formatTokens(input.tokens);
  if (input.contextWindow === undefined || input.contextWindow <= 0) {
    return { bar: '', percent: null, text: `${used} tokens` };
  }
  const percent = Math.min(
    100,
    Math.max(0, (input.tokens / input.contextWindow) * 100),
  );
  const filled = Math.round((percent / 100) * width);
  return {
    bar: '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled)),
    percent,
    text: `${used} / ${formatTokens(input.contextWindow)}`,
  };
}
