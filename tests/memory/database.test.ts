import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/memory/database.js';

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-db-'));
  temporaryDirectories.push(directory);
  return join(directory, 'atlas.db');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('openDatabase', () => {
  it('creates a private database and applies the initial migration', async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);

    try {
      expect(database.getAppliedMigrations()).toEqual([
        expect.objectContaining({ version: 1, name: 'initial' }),
        expect.objectContaining({ version: 2, name: 'shell_audit' }),
      ]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      database.close();
    }
  });

  it('reopens an already-migrated database without duplicate migrations', async () => {
    const path = await temporaryDatabasePath();
    const first = openDatabase(path);
    first.close();

    const second = openDatabase(path);
    try {
      expect(second.getAppliedMigrations()).toHaveLength(2);
      expect(
        second.getAppliedMigrations().map((migration) => migration.version),
      ).toEqual([1, 2]);
    } finally {
      second.close();
    }
  });
});
