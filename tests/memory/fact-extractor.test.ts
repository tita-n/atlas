import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FactExtractor,
  isSupportedByUserText,
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

/** Builds an extractor over a stub provider and a throwaway repository. */
async function makeExtractor(provider: LLMProvider): Promise<FactExtractor> {
  const facts = await createFactsRepository();
  return new FactExtractor({ provider, factsRepository: facts, model: 'stub' });
}

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
        '```json\n{"facts":[{"content":"I live in Berlin.","category":"identity","quote":"i live in berlin"}]}\n```',
      ),
    ).toEqual([
      {
        content: 'I live in Berlin.',
        category: 'identity',
        quote: 'i live in berlin',
      },
    ]);
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
          '{"facts":[{"content":"I am working on Atlas.","category":"project","quote":"i am working on atlas"}]}',
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
        content:
          '{"facts":[{"content":"I prefer tea.","quote":"i prefer tea"}]}',
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

describe('fabrication guard', () => {
  it('stores nothing when the model invents facts about the user', async () => {
    // The exact eval repro: a single generic message produced nine invented
    // facts (a parrot, a dog, PC specs, editor and language preferences) which
    // were then injected into every later turn as authoritative.
    const provider = {
      name: 'stub',
      chatCompletion: () =>
        Promise.resolve({
          content: JSON.stringify({
            facts: [
              { content: 'user has a pet parrot named Ricochet' },
              { content: 'user owns a dog' },
              { content: 'user runs an RTX 4090' },
              { content: 'user prefers vim over emacs' },
              { content: 'user speaks German' },
            ],
          }),
          model: 'stub',
        }),
    } as unknown as LLMProvider;
    const facts = await (
      await makeExtractor(provider)
    ).extractAndStore({
      userContent: 'Say OK.',
      assistantContent: 'OK',
      sourceMessageId: null,
    });
    // No quote, no fact - the model cited nothing, so none of it is real.
    expect(facts).toEqual([]);
  });

  it('stores a fact that cites real supporting text', async () => {
    const provider = {
      name: 'stub',
      chatCompletion: () =>
        Promise.resolve({
          content: JSON.stringify({
            facts: [
              {
                content: 'user is called Sam',
                quote: 'my name is Sam',
              },
            ],
          }),
          model: 'stub',
        }),
    } as unknown as LLMProvider;
    const facts = await (
      await makeExtractor(provider)
    ).extractAndStore({
      userContent: "hi, my name is Sam and I'm a machinist",
      assistantContent: 'Nice to meet you Sam.',
      sourceMessageId: null,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.content).toBe('user is called Sam');
  });

  it('rejects a quote that does not occur in the user message', async () => {
    const provider = {
      name: 'stub',
      chatCompletion: () =>
        Promise.resolve({
          content: JSON.stringify({
            facts: [
              {
                content: 'user has a parrot',
                quote: 'i have a parrot named ratchet',
              },
            ],
          }),
          model: 'stub',
        }),
    } as unknown as LLMProvider;
    const facts = await (
      await makeExtractor(provider)
    ).extractAndStore({
      userContent: 'Say OK.',
      assistantContent: 'OK',
      sourceMessageId: null,
    });
    expect(facts).toEqual([]);
  });

  it('tolerates whitespace and casing differences in the quote', () => {
    expect(
      isSupportedByUserText('My  Name IS Sam', 'hi my name is sam here'),
    ).toBe(true);
    expect(isSupportedByUserText('   ', 'anything')).toBe(false);
    expect(isSupportedByUserText('', 'anything')).toBe(false);
  });
});
