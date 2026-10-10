import { MemoryOperationError } from '../errors.js';
import type { MemoryDatabase } from './database.js';

/** A durable fact about the user. */
export interface MemoryFact {
  /** SQLite fact identifier. */
  id: number;
  /** Standalone factual statement. */
  content: string;
  /** Optional flexible category label. */
  category: string | null;
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO timestamp of the last content update. */
  updatedAt: string;
  /** User message that led to this fact, when known. */
  sourceMessageId: number | null;
}

/** Optional deterministic clock dependency for tests. */
export interface FactsRepositoryOptions {
  /** Clock used for generated timestamps. */
  now?: (() => string) | undefined;
}

interface MemoryFactRow {
  id: number;
  content: string;
  category: string | null;
  created_at: string;
  updated_at: string;
  source_message_id: number | null;
}

function toMemoryFact(row: MemoryFactRow): MemoryFact {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceMessageId: row.source_message_id,
  };
}

function cleanContent(content: string): string {
  const cleaned = content.trim();
  if (cleaned === '') {
    throw new MemoryOperationError('A memory fact must contain text.');
  }
  return cleaned;
}

function cleanCategory(category: string | null | undefined): string | null {
  const cleaned = category?.trim();
  return cleaned === undefined || cleaned === '' ? null : cleaned;
}

/** Typed CRUD operations for durable user facts. */
export class FactsRepository {
  readonly #database: MemoryDatabase;
  readonly #now: () => string;

  public constructor(
    database: MemoryDatabase,
    options: FactsRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Adds one durable fact and returns its persisted representation. */
  public addFact(
    content: string,
    category: string | null = null,
    sourceMessageId: number | null = null,
  ): MemoryFact {
    const cleaned = cleanContent(content);
    const now = this.#now();
    const insert = this.#database.connection.prepare(
      'INSERT INTO memory_facts (content, category, created_at, updated_at, source_message_id) VALUES (?, ?, ?, ?, ?)',
    );
    let result: ReturnType<typeof insert.run>;
    try {
      result = insert.run(
        cleaned,
        cleanCategory(category),
        now,
        now,
        sourceMessageId,
      );
    } catch (error) {
      throw new MemoryOperationError('Could not add the memory fact.', {
        cause: error,
      });
    }
    const id = Number(result.lastInsertRowid);

    try {
      return (
        this.getFact(id) ?? {
          id,
          content: cleaned,
          category: cleanCategory(category),
          createdAt: now,
          updatedAt: now,
          sourceMessageId,
        }
      );
    } catch (error) {
      throw new MemoryOperationError('Could not read the new memory fact.', {
        cause: error,
      });
    }
  }

  /** Returns every stored fact in creation order. */
  public getAllFacts(): MemoryFact[] {
    const rows = this.#database.connection
      .prepare<[], MemoryFactRow>(
        `SELECT id, content, category, created_at, updated_at, source_message_id
         FROM memory_facts
         ORDER BY created_at ASC, id ASC`,
      )
      .all();
    return rows.map(toMemoryFact);
  }

  /** Updates a fact's content, returning the updated row when it exists. */
  public updateFact(id: number, content: string): MemoryFact | undefined {
    const cleaned = cleanContent(content);
    const update = this.#database.connection.prepare(
      'UPDATE memory_facts SET content = ?, updated_at = ? WHERE id = ?',
    );
    try {
      const result = update.run(cleaned, this.#now(), id);
      return result.changes === 0 ? undefined : this.getFact(id);
    } catch (error) {
      throw new MemoryOperationError('Could not update the memory fact.', {
        cause: error,
      });
    }
  }

  /** Deletes one fact and reports whether a row was removed. */
  public deleteFact(id: number): boolean {
    try {
      const result = this.#database.connection
        .prepare('DELETE FROM memory_facts WHERE id = ?')
        .run(id);
      return result.changes > 0;
    } catch (error) {
      throw new MemoryOperationError('Could not delete the memory fact.', {
        cause: error,
      });
    }
  }

  /** Deletes all facts and returns the number removed. */
  public clearFacts(): number {
    try {
      return this.#database.connection.prepare('DELETE FROM memory_facts').run()
        .changes;
    } catch (error) {
      throw new MemoryOperationError('Could not clear memory facts.', {
        cause: error,
      });
    }
  }

  private getFact(id: number): MemoryFact | undefined {
    const row = this.#database.connection
      .prepare<[number], MemoryFactRow>(
        `SELECT id, content, category, created_at, updated_at, source_message_id
         FROM memory_facts
         WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? undefined : toMemoryFact(row);
  }
}
