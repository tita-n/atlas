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
      const applied = database.getAppliedMigrations();
      // The earliest migrations are fixed history; later phases append to this
      // list, so assert the known prefix and that nothing was skipped.
      expect(applied.slice(0, 2)).toEqual([
        expect.objectContaining({ version: 1, name: 'initial' }),
        expect.objectContaining({ version: 2, name: 'shell_audit' }),
      ]);
      expect(applied.map((migration) => migration.version)).toEqual(
        applied.map((_, index) => index + 1),
      );
      expect(applied.length).toBeGreaterThanOrEqual(2);
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
      const reopened = second.getAppliedMigrations();
      expect(reopened.length).toBeGreaterThanOrEqual(2);
      expect(
        reopened.slice(0, 2).map((migration) => migration.version),
      ).toEqual([1, 2]);
    } finally {
      second.close();
    }
  });
});
