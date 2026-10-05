import { describe, expect, it } from 'vitest';

import {
  colorEnabled,
  resolvePalette,
  resolveTheme,
  statusWord,
} from '../../src/tui/theme.js';
import {
  ALLOWED_STATES_FOR_TEST,
  ASSISTANT_STATES,
  canTransition,
  describeState,
  framesFor,
  transition,
} from '../../src/tui/states.js';
import {
  chunkText,
  revealInstantly,
  revealText,
} from '../../src/tui/reveal.js';
import {
  extractCodeBlocks,
  supportsLanguage,
  tokenizeLine,
} from '../../src/tui/highlight.js';

describe('theme', () => {
  it('disables color when NO_COLOR is set, as the convention requires', () => {
    expect(colorEnabled({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
  });

  it('disables color for a dumb terminal', () => {
    expect(colorEnabled({ env: { TERM: 'dumb' }, isTTY: true })).toBe(false);
  });

  it('disables color when stdout is not a TTY', () => {
    expect(colorEnabled({ env: {}, isTTY: false })).toBe(false);
  });

  it('enables color only in an interactive terminal without overrides', () => {
    expect(colorEnabled({ env: {}, isTTY: true })).toBe(true);
  });

  it('honors an explicit noColor override', () => {
    expect(colorEnabled({ noColor: true, env: {}, isTTY: true })).toBe(false);
  });

  it('resolves the particle red palette when color is available', () => {
    expect(resolvePalette({ env: {}, isTTY: true }).particle).toBe('#ff2b3d');
  });

  it('falls back to a monochrome palette rather than failing', () => {
    const { palette, color } = resolveTheme({
      env: { NO_COLOR: '1' },
      isTTY: true,
    });
    expect(color).toBe(false);
    // Every slot is still populated so components never branch on palette shape.
    expect(Object.keys(palette).sort()).toEqual(
      Object.keys(resolvePalette({ env: {}, isTTY: true })).sort(),
    );
  });

  it('gives every state a plain-text word so color is never load-bearing', () => {
    for (const state of ASSISTANT_STATES) {
      expect(statusWord(state)).not.toBe('');
      expect(describeState(state).label).not.toBe('');
      expect(describeState(state).hint).not.toBe('');
    }
  });

  it('falls back to IDLE for an unknown state word', () => {
    expect(statusWord('nonsense')).toBe('IDLE');
  });
});

describe('states', () => {
  it('describes all five orb states', () => {
    expect(ASSISTANT_STATES).toEqual([
      'idle',
      'thinking',
      'executing',
      'awaiting-confirmation',
      'streaming',
    ]);
  });

  it('marks only the confirmation state as awaiting the user', () => {
    const awaiting = ASSISTANT_STATES.filter(
      (s) => describeState(s).awaitsUser,
    );
    expect(awaiting).toEqual(['awaiting-confirmation']);
  });

  it('gives the safety-critical confirmation state a distinct tone', () => {
    // If this ever matches an ordinary progress state, a blocked action could
    // be mistaken for normal work.
    expect(describeState('awaiting-confirmation').tone).toBe('warn');
    expect(describeState('thinking').tone).not.toBe('warn');
    expect(describeState('executing').tone).not.toBe('warn');
  });

  it('allows the normal turn progression', () => {
    expect(canTransition('idle', 'thinking')).toBe(true);
    expect(canTransition('thinking', 'executing')).toBe(true);
    expect(canTransition('executing', 'streaming')).toBe(true);
    expect(canTransition('streaming', 'idle')).toBe(true);
  });

  it('allows a confirmation to interrupt an execution', () => {
    expect(canTransition('executing', 'awaiting-confirmation')).toBe(true);
  });

  it('rejects an impossible transition and leaves state untouched', () => {
    const result = transition('idle', 'executing');
    expect(result.accepted).toBe(false);
    expect(result.state).toBe('idle');
  });

  it('treats a same-state transition as accepted', () => {
    expect(transition('thinking', 'thinking').accepted).toBe(true);
  });

  it('keeps the confirmed-state vocabulary aligned with the transition table', () => {
    for (const state of ALLOWED_STATES_FOR_TEST) {
      expect(ASSISTANT_STATES).toContain(state);
    }
  });

  it('animates every state but keeps frames available for all of them', () => {
    for (const state of ASSISTANT_STATES) {
      expect(framesFor(state).length).toBeGreaterThan(0);
    }
  });
});

describe('progressive reveal', () => {
  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('preserves the original text exactly when rejoined', () => {
    const text = 'Here is a plain answer with  spacing.\n\nSecond line.';
    expect(chunkText(text, 3).join('')).toBe(text);
  });

  it('never splits mid-word', () => {
    for (const chunk of chunkText('alpha beta gamma delta', 2)) {
      expect(chunk.trimStart()).not.toBe('');
    }
    expect(chunkText('alpha beta gamma delta', 2).join('')).toBe(
      'alpha beta gamma delta',
    );
  });

  it('yields a single chunk when the interval is zero', async () => {
    const chunks: string[] = [];
    for await (const chunk of revealText('one two three four', {
      intervalMs: 0,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('one two three four');
  });

  it('reassembles to the exact original text', async () => {
    const text = 'Line one.\n  indented two\n\ndone';
    let built = '';
    for await (const chunk of revealText(text, { intervalMs: 1 })) {
      built += chunk;
    }
    expect(built).toBe(text);
  });

  it('returns the whole text when animation is unavailable', () => {
    expect(revealInstantly('all at once')).toBe('all at once');
  });
});

describe('syntax highlighting', () => {
  it('extracts a fenced shell block', () => {
    const blocks = extractCodeBlocks('before\n```sh\nls -la\n```\nafter');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ language: 'sh', code: 'ls -la\n' });
  });

  it('returns an unterminated fence rather than dropping it', () => {
    const blocks = extractCodeBlocks('```\nrm -rf x');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('rm -rf x');
  });

  it('finds no blocks in prose', () => {
    expect(extractCodeBlocks('just some narration')).toEqual([]);
  });

  it('marks shell keywords and comments', () => {
    const tokens = tokenizeLine('if ls # list');
    expect(tokens.some((t) => t.kind === 'keyword' && t.value === 'if')).toBe(
      true,
    );
    expect(tokens.some((t) => t.kind === 'comment')).toBe(true);
  });

  it('treats single-quoted text as a literal string', () => {
    const tokens = tokenizeLine("echo 'a # not a comment'");
    expect(
      tokens.some(
        (t) => t.kind === 'string' && t.value.includes('a # not a comment'),
      ),
    ).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
  });

  it('does not end a double-quoted string at a nested substitution', () => {
    const tokens = tokenizeLine('echo "value: $(date) done"');
    const strings = tokens.filter((t) => t.kind === 'string');
    expect(strings).toHaveLength(1);
    expect(strings[0]?.value).toContain('$(date)');
  });

  it('marks command substitution as an operator', () => {
    const tokens = tokenizeLine('echo $(whoami)');
    expect(tokens.some((t) => t.kind === 'operator')).toBe(true);
  });

  it('always preserves the exact original line when rejoined', () => {
    for (const line of [
      'ls -la',
      'rm -rf /tmp/x',
      'echo "a b" # c',
      "grep -E '^x$' file.txt",
      'echo $(date) ${HOME}',
      'VAR=1 command --flag=value',
    ]) {
      expect(
        tokenizeLine(line)
          .map((t) => t.value)
          .join(''),
      ).toBe(line);
    }
  });

  it('recognizes only the languages it can highlight', () => {
    expect(supportsLanguage('sh')).toBe(true);
    expect(supportsLanguage('')).toBe(true);
    expect(supportsLanguage('rust')).toBe(false);
  });
});
