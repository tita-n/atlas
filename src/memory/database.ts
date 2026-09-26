import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryError } from '../errors.js';

/** A typed better-sqlite3 database connection. */
export type SqliteDatabase = Database.Database;

/** Metadata for one applied SQL migration. */
export interface MigrationRecord {
  /** Numeric migration version. */
  version: number;
  /** Filename-derived migration name. */
  name: string;
  /** ISO timestamp recorded when the migration was applied. */
  appliedAt: string;
}

/** Lifecycle and migration interface for Atlas's SQLite store. */
export interface MemoryDatabase {
  /** Underlying typed SQLite connection used by repositories. */
  readonly connection: SqliteDatabase;
  /** Resolved database path, or `:memory:` for an in-memory database. */
  readonly path: string;
  /** Returns all migrations currently recorded as applied. */
  getAppliedMigrations(): MigrationRecord[];
  /** Closes the connection. Safe to call more than once. */
  close(): void;
}

interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

interface MigrationVersionRow {
  version: number;
  name: string;
  applied_at: string;
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

function discoverMigrations(): MigrationFile[] {
  const directory = migrationsDirectory();
  const files: MigrationFile[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)_([\w-]+)\.sql$/.exec(entry.name);
    if (match === null) continue;
    const version = Number(match[1]);
    const name = match[2];
    if (!Number.isSafeInteger(version) || name === undefined) continue;
    files.push({ version, name, path: resolve(directory, entry.name) });
  }

  return files.sort((left, right) => left.version - right.version);
}

function ensureMigrationTable(connection: SqliteDatabase): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function applyMigrations(connection: SqliteDatabase): void {
  ensureMigrationTable(connection);
  const appliedRows = connection
    .prepare<[], MigrationVersionRow>(
      'SELECT version, name, applied_at FROM schema_migrations',
    )
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of discoverMigrations()) {
    if (applied.has(migration.version)) continue;

    const sql = readFileSync(migration.path, 'utf8');
    const insert = connection.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );
    const transaction = connection.transaction(() => {
      connection.exec(sql);
      insert.run(migration.version, migration.name, new Date().toISOString());
    });

    try {
      transaction();
    } catch (error) {
      throw new MemoryError(
        `Could not apply database migration ${migration.version}_${migration.name}.`,
        { cause: error },
      );
    }
  }
}

/** Returns the standard Atlas SQLite database path. */
export function getDefaultDatabasePath(homeDirectory = homedir()): string {
  return resolve(homeDirectory, '.atlas', 'atlas.db');
}

/** Resolves an explicit path, ATLAS_DB_PATH, or the default database location. */
export function resolveDatabasePath(
  databasePath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (databasePath === ':memory:') return databasePath;
  if (databasePath !== undefined && databasePath !== '') {
    return resolve(databasePath);
  }
  if (
    environment.ATLAS_DB_PATH !== undefined &&
    environment.ATLAS_DB_PATH !== ''
  ) {
    return resolve(environment.ATLAS_DB_PATH);
  }
  return getDefaultDatabasePath();
}

/** Opens SQLite, applies pending migrations, and returns the database handle. */
export function openDatabase(databasePath?: string): MemoryDatabase {
  const path = resolveDatabasePath(databasePath);
  let connection: SqliteDatabase | undefined;
  let closed = false;

  try {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    connection = new Database(path);
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    if (path !== ':memory:') {
      chmodSync(path, 0o600);
    }
    applyMigrations(connection);
  } catch (error) {
    connection?.close();
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(`Could not open Atlas database at ${path}.`, {
      cause: error,
    });
  }

  const openedConnection = connection;
  return {
    connection: openedConnection,
    path,
    getAppliedMigrations(): MigrationRecord[] {
      const rows = openedConnection
        .prepare<[], MigrationVersionRow>(
          'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
        )
        .all();
      return rows.map((row) => ({
        version: row.version,
        name: row.name,
        appliedAt: row.applied_at,
      }));
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (openedConnection.open) openedConnection.close();
    },
  };
}

/** Returns whether a filesystem path currently exists. */
export function databaseFileExists(path: string): boolean {
  return path !== ':memory:' && existsSync(path);
}
