import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FactExtractor,
  parseFactExtraction,
} from '../../src/memory/fact-extractor.js';
import { FactsRepository } from '../../src/memory/facts-repository.js';
import {
  openDatabase,
  type MemoryDatabase,
} from '../../src/memory/database.js';
import type { LLMProvider } from '../../src/providers/provider.interface.js';

const temporaryDirectories: string[] = [];
const openDatabases: MemoryDatabase[] = [];

async function createFactsRepository(): Promise<FactsRepository> {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-extractor-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'atlas.db'));
  openDatabases.push(database);
  return new FactsRepository(database);
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('parseFactExtraction', () => {
  it('parses fenced JSON and rejects malformed output conservatively', () => {
    expect(
      parseFactExtraction(
        '```json\n{"facts":[{"content":"I live in Berlin.","category":"identity"}]}\n```',
      ),
    ).toEqual([{ content: 'I live in Berlin.', category: 'identity' }]);
    expect(parseFactExtraction('not json')).toEqual([]);
  });
});

describe('FactExtractor', () => {
  it('uses the provider abstraction and stores returned facts', async () => {
    const factsRepository = await createFactsRepository();
    const chatCompletion = vi
      .fn<LLMProvider['chatCompletion']>()
      .mockResolvedValue({
        content:
          '{"facts":[{"content":"I am working on Atlas.","category":"project"}]}',
        model: 'mock-model',
      });
    const provider: LLMProvider = { name: 'mock', chatCompletion };
    const extractor = new FactExtractor({
      provider,
      factsRepository,
      model: 'mock-model',
    });

    const stored = await extractor.extractAndStore({
      userContent: 'I am working on Atlas.',
      assistantContent: 'That is useful context.',
      sourceMessageId: null,
    });

    expect(stored).toHaveLength(1);
    expect(factsRepository.getAllFacts()[0]).toMatchObject({
      content: 'I am working on Atlas.',
      category: 'project',
      sourceMessageId: null,
    });
    expect(chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mock-model', temperature: 0 }),
    );
  });

  it('does not store duplicate facts across repeated turns', async () => {
    const factsRepository = await createFactsRepository();
    const chatCompletion = vi
      .fn<LLMProvider['chatCompletion']>()
      .mockResolvedValue({
        content: '{"facts":[{"content":"I prefer tea."}]}',
        model: 'mock-model',
      });
    const extractor = new FactExtractor({
      provider: { name: 'mock', chatCompletion },
      factsRepository,
      model: 'mock-model',
    });
    const exchange = {
      userContent: 'I prefer tea.',
      assistantContent: 'Noted.',
    };

    await extractor.extractAndStore(exchange);
    await extractor.extractAndStore(exchange);

    expect(factsRepository.getAllFacts()).toHaveLength(1);
  });
});
