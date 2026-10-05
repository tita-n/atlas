/**
 * Standing corrections learned from user feedback.
 *
 * A correction is stored as an instruction plus the terms that make it relevant.
 * Nothing here trains or fine-tunes a model: the corrections are retrieved and
 * injected into later prompts, which is what a harness can actually guarantee.
 */
import { z } from 'zod';

import { MemoryOperationError } from '../errors.js';
import type { MemoryDatabase } from './database.js';

/** One durable correction. */
export interface AssistantCorrection {
  readonly id: number;
  readonly createdAt: string;
  /** The standing instruction given to the assistant. */
  readonly instruction: string;
  /** Terms that make this correction relevant to a turn. */
  readonly triggerTerms: readonly string[];
  readonly sourceMessageId: number | null;
}

interface CorrectionRow {
  id: number;
  created_at: string;
  instruction: string;
  trigger_terms: string;
  source_message_id: number | null;
}

const rowSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  instruction: z.string(),
  trigger_terms: z.string(),
  source_message_id: z.number().nullable(),
});

/** Words too common to be useful as relevance triggers. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'as',
  'it',
  'its',
  'i',
  'me',
  'my',
  'you',
  'your',
  'we',
  'our',
  'do',
  'does',
  'did',
  'not',
  'no',
  'so',
  'up',
  'out',
  'about',
  'into',
  'over',
  'just',
  'like',
]);

/** Extracts lowercase trigger terms, dropping stop words and short noise. */
export function deriveTriggerTerms(text: string, limit = 12): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const term = raw.replace(/^[.'-]+|[.'-]+$/g, '');
    if (term.length < 3) continue;
    if (STOP_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Storage for standing corrections. */
export class CorrectionsRepository {
  readonly #connection: MemoryDatabase['connection'];

  public constructor(database: MemoryDatabase) {
    this.#connection = database.connection;
  }

  /** Records a correction and returns its ID. */
  public record(input: {
    instruction: string;
    triggerTerms?: readonly string[];
    sourceMessageId?: number | null;
    now?: string;
  }): number {
    const instruction = input.instruction.trim();
    if (instruction === '') {
      throw new MemoryOperationError('A correction needs an instruction.');
    }
    const terms =
      input.triggerTerms !== undefined && input.triggerTerms.length > 0
        ? [...input.triggerTerms]
        : deriveTriggerTerms(instruction);
    try {
      const result = this.#connection
        .prepare(
          `INSERT INTO assistant_corrections
             (created_at, instruction, trigger_terms, source_message_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.now ?? new Date().toISOString(),
          instruction,
          terms.join(' '),
          input.sourceMessageId ?? null,
        );
      const id = (result as { lastInsertRowid?: number }).lastInsertRowid;
      if (typeof id !== 'number') {
        throw new MemoryOperationError('Correction insert returned no id.');
      }
      return id;
    } catch (cause) {
      if (cause instanceof MemoryOperationError) throw cause;
      throw new MemoryOperationError('Could not store the correction.', {
        cause,
      });
    }
  }

  /** All corrections, newest first. */
  public list(limit = 100): AssistantCorrection[] {
    const rows = this.#connection
      .prepare('SELECT * FROM assistant_corrections ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as CorrectionRow[];
    const out: AssistantCorrection[] = [];
    for (const row of rows) {
      const parsed = rowSchema.safeParse(row);
      if (!parsed.success) continue;
      out.push({
        id: parsed.data.id,
        createdAt: parsed.data.created_at,
        instruction: parsed.data.instruction,
        triggerTerms: parsed.data.trigger_terms
          .split(/\s+/)
          .filter((term) => term !== ''),
        sourceMessageId: parsed.data.source_message_id,
      });
    }
    return out;
  }

  /** Corrections whose terms overlap a message, most relevant first. */
  public relevant(message: string, limit = 8): AssistantCorrection[] {
    const terms = new Set(deriveTriggerTerms(message, 40));
    const scored = this.list(200).map((correction) => ({
      correction,
      score: correction.triggerTerms.filter((term) => terms.has(term)).length,
    }));
    return scored
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.correction);
  }

  /** One correction by ID. */
  public getById(id: number): AssistantCorrection | undefined {
    const row = this.#connection
      .prepare('SELECT * FROM assistant_corrections WHERE id = ?')
      .get(id) as CorrectionRow | undefined;
    if (row === undefined) return undefined;
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    return {
      id: parsed.data.id,
      createdAt: parsed.data.created_at,
      instruction: parsed.data.instruction,
      triggerTerms: parsed.data.trigger_terms
        .split(/\s+/)
        .filter((t) => t !== ''),
      sourceMessageId: parsed.data.source_message_id,
    };
  }

  public count(): number {
    const row = this.#connection
      .prepare('SELECT COUNT(*) AS total FROM assistant_corrections')
      .get() as { total: number };
    return row.total;
  }

  /** Removes one correction. */
  public delete(id: number): boolean {
    const result = this.#connection
      .prepare('DELETE FROM assistant_corrections WHERE id = ?')
      .run(id);
    return (result as { changes?: number }).changes === 1;
  }
}
