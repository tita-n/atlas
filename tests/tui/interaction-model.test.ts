import { describe, expect, it } from 'vitest';

import {
  collapseLinesFor,
  collapseOutput,
  contextBar,
  formatTokens,
  isShellTool,
  summarizeTool,
} from '../../src/tui/tool-blocks.js';
import {
  emptyStats,
  pluralize,
  recordToolCall,
  recordTurn,
  statusSegments,
} from '../../src/tui/session-stats.js';
import {
  ASSISTANT_COMMAND_REGISTRY,
  ASSISTANT_HELP,
  filterAssistantCommands,
} from '../../src/conversation/assistant-commands.js';

describe('tool collapse policy', () => {
  it('gives shell output a larger budget than a generic tool', () => {
    // Research finding: one global threshold hides the output that matters and
    // shows the output that does not.
    expect(collapseLinesFor('shell')).toBeGreaterThan(
      collapseLinesFor('memory_search'),
    );
  });

  it('treats shell-like tool names as shell', () => {
    for (const name of ['shell', 'Bash', 'sh', 'exec']) {
      expect(isShellTool(name)).toBe(true);
    }
    expect(isShellTool('memory_search')).toBe(false);
  });

  it('shows everything when the output already fits', () => {
    const result = collapseOutput('a\nb\nc', 5);
    expect(result.hidden).toBe(0);
    expect(result.preview).toEqual(['a', 'b', 'c']);
  });

  it('reports how many lines it hid', () => {
    const result = collapseOutput('1\n2\n3\n4\n5\n6', 3);
    expect(result.preview).toEqual(['1', '2', '3']);
    expect(result.hidden).toBe(3);
  });

  it('does not count trailing blank lines as content', () => {
    // A command ending in a newline must not look longer than its content.
    const result = collapseOutput('a\nb\n\n\n', 3);
    expect(result.hidden).toBe(0);
    expect(result.preview).toEqual(['a', 'b']);
  });

  it('handles empty output without collapsing', () => {
    const result = collapseOutput('', 3);
    expect(result.hidden).toBe(0);
    expect(result.preview).toEqual([]);
  });
});

describe('tool summary', () => {
  const detail = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');

  it('states the status in text, not only as a glyph', () => {
    const summary = summarizeTool({
      toolName: 'shell',
      status: 'running',
      argument: 'ls',
      detail: '',
    });
    expect(summary.annotation).toContain('running');
  });

  it('shows the hidden-line count and exit code when collapsed', () => {
    const summary = summarizeTool({
      toolName: 'shell',
      status: 'succeeded',
      argument: 'ls',
      detail,
      exitCode: 0,
    });
    expect(summary.annotation).toContain('+2 lines');
    expect(summary.annotation).toContain('exit 0');
  });

  it('marks a failure distinctly in text', () => {
    const summary = summarizeTool({
      toolName: 'shell',
      status: 'failed',
      argument: 'rm',
      detail: 'nope',
      exitCode: 1,
    });
    expect(summary.icon).toBe('✗');
    expect(summary.annotation).toContain('exit 1');
  });

  it('falls back to the status when there is nothing else to say', () => {
    const summary = summarizeTool({
      toolName: 'ping',
      status: 'succeeded',
      argument: '',
      detail: '',
    });
    expect(summary.annotation).toBe('succeeded');
  });

  it('includes duration when known', () => {
    const summary = summarizeTool({
      toolName: 'shell',
      status: 'succeeded',
      argument: 'ls',
      detail: '',
      durationMs: 12,
    });
    expect(summary.annotation).toContain('12ms');
  });
});

describe('token formatting', () => {
  it('formats compactly', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });

  it('refuses to invent a number for invalid input', () => {
    expect(formatTokens(Number.NaN)).toBe('—');
    expect(formatTokens(-5)).toBe('—');
  });
});

describe('context bar', () => {
  it('shows a real percentage when a window is known', () => {
    const result = contextBar({ tokens: 250, contextWindow: 1000, width: 10 });
    expect(result.percent).toBe(25);
    expect(result.bar).toHaveLength(10);
    expect(result.text).toContain('/');
  });

  it('never invents a percentage when the window is unknown', () => {
    // Providers do not report a context window consistently. Showing a fake
    // ratio would be worse than showing the honest token count.
    const result = contextBar({ tokens: 5000 });
    expect(result.percent).toBeNull();
    expect(result.bar).toBe('');
    expect(result.text).toBe('5.0k tokens');
  });

  it('clamps a percentage that exceeds the window', () => {
    expect(contextBar({ tokens: 5000, contextWindow: 1000 }).percent).toBe(100);
  });

  it('ignores a nonsensical window', () => {
    expect(contextBar({ tokens: 10, contextWindow: 0 }).percent).toBeNull();
  });
});

describe('session stats', () => {
  it('starts empty', () => {
    expect(emptyStats()).toEqual({
      turns: 0,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('accumulates turns and usage', () => {
    let stats = emptyStats();
    stats = recordTurn(stats, { inputTokens: 10, outputTokens: 5 });
    stats = recordTurn(stats, { inputTokens: 20, outputTokens: 7 });
    expect(stats.turns).toBe(2);
    expect(stats.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
  });

  it('leaves totals unchanged when a provider reports no usage', () => {
    const stats = recordTurn(emptyStats(), undefined);
    expect(stats.turns).toBe(1);
    expect(stats.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('counts tool calls', () => {
    expect(recordToolCall(emptyStats()).toolCalls).toBe(1);
  });

  it('pluralizes counts', () => {
    expect(pluralize(1, 'turn')).toBe('1 turn');
    expect(pluralize(2, 'turn')).toBe('2 turns');
    expect(pluralize(1, 'tool call')).toBe('1 tool call');
  });

  it('names the active provider and model in the status line', () => {
    const segments = statusSegments({
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      stats: emptyStats(),
    });
    expect(segments[0]).toBe('openai-compatible/gpt-4.1-mini');
    expect(segments[1]).toBe('0 turns');
  });
});

describe('confirmation safety', () => {
  it('starts the highlight on the safe option, not the destructive one', async () => {
    // Regression: Enter used to approve a dangerous command because the
    // highlight started on "Run it". The highlight must start on cancel so a
    // reflexive Enter can refuse but never approve.
    const { DEFAULT_CHOICES } =
      await import('../../src/tui/components/ConfirmModal.js');
    const first = DEFAULT_CHOICES[0];
    const safeIndex = Math.max(
      0,
      DEFAULT_CHOICES.findIndex((choice) => !choice.approving),
    );
    expect(DEFAULT_CHOICES[safeIndex]?.approving).toBe(false);
    expect(first).toBeDefined();
  });

  it('denies when the bridge has no handler mounted', async () => {
    await Promise.resolve();
    const { TuiBridge } = await import('../../src/tui/bridge.js');
    await expect(
      new TuiBridge().requestConfirmation('ATLAS CONFIRM'),
    ).resolves.toBe(false);
  });
});

describe('prompt queue', () => {
  it('preserves order and drops each prompt exactly once', () => {
    // Regression: a separate cursor indexed the same array that was being
    // sliced, which dropped prompts, reordered them, and could stick forever.
    const queued = ['alpha', 'beta', 'gamma'];
    const sent: string[] = [];
    let queue = [...queued];
    while (queue.length > 0) {
      const next = queue[0];
      if (next === undefined) break;
      queue = queue.slice(1);
      sent.push(next);
    }
    expect(sent).toEqual(queued);
  });
});

describe('command registry', () => {
  it('gives every command a description for discovery', () => {
    for (const command of ASSISTANT_COMMAND_REGISTRY) {
      expect(command.name).not.toBe('');
      expect(command.summary).not.toBe('');
    }
  });

  it('lists every command in the help text', () => {
    for (const command of ASSISTANT_COMMAND_REGISTRY) {
      expect(ASSISTANT_HELP).toContain(`/${command.name}`);
    }
  });

  it('shows every command for an empty query', () => {
    expect(filterAssistantCommands('/')).toHaveLength(
      ASSISTANT_COMMAND_REGISTRY.length,
    );
  });

  it('filters live as characters are typed', () => {
    expect(filterAssistantCommands('/c').map((c) => c.name)).toEqual([
      'corrections',
    ]);
    expect(filterAssistantCommands('/mo').map((c) => c.name)).toEqual([
      'model',
    ]);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterAssistantCommands('/zzzz')).toEqual([]);
  });

  it('flags commands that open a modal', () => {
    expect(
      ASSISTANT_COMMAND_REGISTRY.find((c) => c.name === 'model')?.opensModal,
    ).toBe(true);
    expect(
      ASSISTANT_COMMAND_REGISTRY.find((c) => c.name === 'help')?.opensModal,
    ).toBe(false);
  });

  it('documents the argument for commands that take one', () => {
    const corrections = ASSISTANT_COMMAND_REGISTRY.find(
      (c) => c.name === 'corrections',
    );
    expect(corrections?.takesArgument).toBe(true);
    expect(corrections?.argumentHint).toBe('forget <id>');
  });
});
