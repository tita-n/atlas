import { z } from 'zod';

import { MemoryOperationError } from '../errors.js';
import type { MemoryDatabase } from './database.js';

/** One logged voice interaction awaiting a possible correction. */
export interface VoiceCorrectionEntry {
  readonly id: number;
  /** ISO timestamp of the interaction. */
  readonly timestamp: string;
  /** What speech-to-text produced. */
  readonly heardTranscript: string;
  /** What the user said it actually was; null until corrected. */
  readonly correctedTranscript: string | null;
  /** Path to the saved audio clip, never inline audio. */
  readonly audioReference: string;
  /** Conversation the transcript was handled in. */
  readonly conversationId: string | null;
}

interface CorrectionRow {
  id: number;
  timestamp: string;
  heard_transcript: string;
  corrected_transcript: string | null;
  audio_reference: string;
  conversation_id: string | null;
}

const correctionRowSchema = z.object({
  id: z.number(),
  timestamp: z.string(),
  heard_transcript: z.string(),
  corrected_transcript: z.string().nullable(),
  audio_reference: z.string(),
  conversation_id: z.string().nullable(),
});

/** Repository for the Phase 3 voice correction log. */
export class VoiceCorrectionsRepository {
  readonly #connection: MemoryDatabase['connection'];

  public constructor(database: MemoryDatabase) {
    this.#connection = database.connection;
  }

  /** Inserts a heard transcript. */
  public create(input: {
    readonly heardTranscript: string;
    readonly audioReference?: string;
    readonly conversationId?: string | null;
    readonly timestamp?: string;
  }): number {
    const timestamp = input.timestamp ?? new Date().toISOString();
    try {
      const result = this.#connection
        .prepare(
          `INSERT INTO voice_corrections
             (timestamp, heard_transcript, corrected_transcript, audio_reference, conversation_id)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run(
          timestamp,
          input.heardTranscript,
          input.audioReference ?? '',
          input.conversationId ?? null,
        );
      const id = (result as { lastInsertRowid?: number }).lastInsertRowid;
      if (typeof id !== 'number') {
        throw new MemoryOperationError(
          'Voice correction insert returned no id.',
        );
      }
      return id;
    } catch (cause) {
      if (cause instanceof MemoryOperationError) throw cause;
      throw new MemoryOperationError('Could not log the voice transcript.', {
        cause,
      });
    }
  }

  /** Fills in the correction for an entry. */
  public correct(id: number, correctedTranscript: string): boolean {
    try {
      const result = this.#connection
        .prepare(
          `UPDATE voice_corrections
              SET corrected_transcript = ?
            WHERE id = ? AND corrected_transcript IS NULL`,
        )
        .run(correctedTranscript, id);
      return (result as { changes?: number }).changes === 1;
    } catch (cause) {
      throw new MemoryOperationError('Could not save the voice correction.', {
        cause,
      });
    }
  }

  /** The most recent entry that has not been corrected yet. */
  public latestUncorrected(): VoiceCorrectionEntry | undefined {
    const row = this.#connection
      .prepare(
        `SELECT * FROM voice_corrections
          WHERE corrected_transcript IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get();
    return this.#toEntry(row);
  }

  /** One entry by id. */
  public getById(id: number): VoiceCorrectionEntry | undefined {
    const row = this.#connection
      .prepare('SELECT * FROM voice_corrections WHERE id = ?')
      .get(id);
    return this.#toEntry(row);
  }

  /** Entries, newest first. */
  public list(limit = 20): readonly VoiceCorrectionEntry[] {
    const rows = this.#connection
      .prepare('SELECT * FROM voice_corrections ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as CorrectionRow[];
    const entries: VoiceCorrectionEntry[] = [];
    for (const row of rows) {
      const entry = this.#toEntry(row);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  }

  /** Total number of logged entries. */
  public count(): number {
    const row = this.#connection
      .prepare('SELECT COUNT(*) AS total FROM voice_corrections')
      .get() as { total: number };
    return row.total;
  }

  /** How many entries were later corrected. */
  public correctedCount(): number {
    const row = this.#connection
      .prepare(
        'SELECT COUNT(*) AS total FROM voice_corrections WHERE corrected_transcript IS NOT NULL',
      )
      .get() as { total: number };
    return row.total;
  }

  /** Removes one entry, by id. */
  public delete(id: number): boolean {
    const result = this.#connection
      .prepare('DELETE FROM voice_corrections WHERE id = ?')
      .run(id);
    return (result as { changes?: number }).changes === 1;
  }

  #toEntry(row: unknown): VoiceCorrectionEntry | undefined {
    if (row === undefined || row === null) return undefined;
    const parsed = correctionRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    return {
      id: parsed.data.id,
      timestamp: parsed.data.timestamp,
      heardTranscript: parsed.data.heard_transcript,
      correctedTranscript: parsed.data.corrected_transcript,
      audioReference: parsed.data.audio_reference,
      conversationId: parsed.data.conversation_id,
    };
  }
}
