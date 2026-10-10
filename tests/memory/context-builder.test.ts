import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  DEFAULT_ATLAS_PERSONALITY,
} from '../../src/memory/context-builder.js';
import type { MemoryFact } from '../../src/memory/facts-repository.js';

const fact: MemoryFact = {
  id: 1,
  content: 'I prefer concise answers.',
  category: 'preference',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sourceMessageId: null,
};

describe('buildSystemPrompt', () => {
  it('includes the base personality and formatted facts', () => {
    const prompt = buildSystemPrompt([fact]);

    expect(prompt).toContain(DEFAULT_ATLAS_PERSONALITY);
    expect(prompt).toContain('Known facts about the user:');
    expect(prompt).toContain('- [preference] I prefer concise answers.');
  });

  it('returns only the base personality when there are no facts', () => {
    expect(buildSystemPrompt([])).toBe(DEFAULT_ATLAS_PERSONALITY);
  });
});
