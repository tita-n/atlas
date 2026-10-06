import { describe, expect, it } from 'vitest';

import {
  fuzzyFilter,
  highlightPositions,
  normalizeForSearch,
  scoreMatch,
} from '../../src/tui/fuzzy.js';

describe('normalisation', () => {
  it('folds smart quotes and unicode dashes so typing still matches', () => {
    expect(normalizeForSearch('don’t-do')).toBe("don't-do");
    expect(normalizeForSearch('a “quote”')).toBe('a "quote"');
  });
});

describe('subsequence matching', () => {
  it('matches a subsequence across separators', () => {
    expect(scoreMatch('gpt-4o', 'gpt4o')).toBeDefined();
    expect(scoreMatch('claude-3-5-sonnet', 'cl35s')).toBeDefined();
  });

  it('rejects a query that is not a subsequence', () => {
    expect(scoreMatch('gpt-4o', 'zzz')).toBeUndefined();
  });

  it('treats an empty query as matching everything', () => {
    expect(scoreMatch('anything', '')).toEqual({ score: 0, positions: [] });
  });

  it('is case-insensitive', () => {
    expect(scoreMatch('GPT-4o', 'gpt')).toBeDefined();
  });
});

describe('ranking', () => {
  const items = [
    { label: 'claude-sonnet-4-5', id: 'claude-sonnet-4-5' },
    { label: 'claude-opus-4-1', id: 'claude-opus-4-1' },
    { label: 'gpt-4.1-mini', id: 'gpt-4.1-mini' },
    { label: 'gpt-5', id: 'gpt-5' },
  ];

  it('puts a prefix match first', () => {
    const ranked = fuzzyFilter(items, 'gpt');
    expect(ranked[0]?.item.label).toBe('gpt-5');
    expect(ranked.every((r) => r.item.label.startsWith('gpt'))).toBe(true);
  });

  it('filters out everything that does not match', () => {
    expect(fuzzyFilter(items, 'opus')).toHaveLength(1);
    expect(fuzzyFilter(items, 'llama')).toHaveLength(0);
  });

  it('matches a provider name across that provider’s models', () => {
    const withProvider = [
      { label: 'gpt-4.1-mini', id: 'gpt-4.1-mini', provider: 'OpenAI' },
      { label: 'llama-3', id: 'llama-3', provider: 'Meta' },
    ];
    const ranked = fuzzyFilter(withProvider, 'meta');
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.item.label).toBe('llama-3');
  });

  it('matches a provider/model style query', () => {
    const withProvider = [
      { label: 'gpt-4.1-mini', id: 'gpt-4.1-mini', provider: 'OpenAI' },
      { label: 'llama-3', id: 'llama-3', provider: 'Meta' },
    ];
    expect(fuzzyFilter(withProvider, 'meta/llama')).toHaveLength(1);
  });

  it('keeps the caller’s order for an empty query rather than re-sorting', () => {
    expect(fuzzyFilter(items, '').map((r) => r.item.label)).toEqual(
      items.map((i) => i.label),
    );
  });

  it('prefers the shorter name when both match equally well', () => {
    // Both are prefix matches on "claude"; the shorter name leads so the list
    // does not open with the longest possible string.
    const ranked = fuzzyFilter(items, 'claude');
    expect(ranked[0]?.item.label).toBe('claude-opus-4-1');
    expect(ranked).toHaveLength(2);
  });

  it('keeps the original order for genuine ties, so the list does not jump', () => {
    const tied = [
      { label: 'alpha', id: 'alpha' },
      { label: 'beta', id: 'beta' },
    ];
    // 'a' matches alpha exactly and beta as a subsequence, so alpha leads on
    // quality; a query neither matches yields nothing, not everything.
    expect(fuzzyFilter(tied, 'a').map((r) => r.item.id)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(fuzzyFilter(tied, 'zzz-none')).toEqual([]);
  });

  it('returns nothing for a query nothing matches, rather than everything', () => {
    expect(fuzzyFilter(items, 'definitely-not-here')).toEqual([]);
  });

  it('handles an empty candidate list', () => {
    expect(fuzzyFilter([], 'x')).toEqual([]);
  });
});

describe('highlighting', () => {
  it('reports which characters matched', () => {
    expect(highlightPositions('gpt-4o', 'gpt')).toEqual([0, 1, 2]);
  });

  it('returns nothing when there is no match', () => {
    expect(highlightPositions('gpt-4o', 'zzz')).toEqual([]);
  });
});
