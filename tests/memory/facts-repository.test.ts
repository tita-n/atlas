import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  type MemoryDatabase,
} from '../../src/memory/database.js';
import { FactsRepository } from '../../src/memory/facts-repository.js';

const temporaryDirectories: string[] = [];
const openDatabases: MemoryDatabase[] = [];

async function createRepository(): Promise<FactsRepository> {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-facts-'));
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

describe('FactsRepository', () => {
  it('supports fact creation, listing, updates, and deletion', async () => {
    const repository = await createRepository();
    const fact = repository.addFact(
      '  I prefer concise answers.  ',
      'preference',
      null,
    );

    expect(fact.content).toBe('I prefer concise answers.');
    expect(fact.category).toBe('preference');
    expect(repository.getAllFacts()).toHaveLength(1);

    const updated = repository.updateFact(
      fact.id,
      'I prefer detailed answers.',
    );
    expect(updated?.content).toBe('I prefer detailed answers.');
    expect(repository.deleteFact(fact.id)).toBe(true);
    expect(repository.getAllFacts()).toEqual([]);
    expect(repository.deleteFact(fact.id)).toBe(false);
  });

  it('clears all stored facts', async () => {
    const repository = await createRepository();
    repository.addFact('One');
    repository.addFact('Two');

    expect(repository.clearFacts()).toBe(2);
    expect(repository.getAllFacts()).toEqual([]);
  });
});
