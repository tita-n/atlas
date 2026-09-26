import { z } from 'zod';
import { MemoryOperationError } from '../errors.js';
import type { MemoryDatabase } from '../memory/database.js';
import {
  auditEntryInputSchema,
  type AuditDecision,
  type AuditEntryInput,
  type AuditQuery,
} from './audit-log.schema.js';

interface AuditRow {
  id: number;
  timestamp: string;
  command: string;
  risk_tier: 0 | 1 | 2 | 3;
  matched_rule: string;
  decision: AuditDecision;
  outcome: string;
  exit_code: number | null;
  duration_ms: number | null;
}

/** One queryable audit-log row. */
export interface AuditEntry extends AuditEntryInput {
  /** SQLite audit row identifier. */
  id: number;
}

/** Append-only shell audit writer. There is intentionally no delete/truncate API. */
export class AuditLog {
  readonly #database: MemoryDatabase;

  public constructor(database: MemoryDatabase) {
    this.#database = database;
  }

  /** Appends one command attempt. */
  public append(input: AuditEntryInput): AuditEntry {
    const parsed = auditEntryInputSchema.parse(input);
    try {
      const result = this.#database.connection
        .prepare(
          `INSERT INTO audit_log
           (timestamp, command, risk_tier, matched_rule, decision, outcome, exit_code, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.timestamp,
          parsed.command,
          parsed.riskTier,
          parsed.matchedRule,
          parsed.decision,
          parsed.outcome,
          parsed.exitCode,
          parsed.durationMs,
        );
      return {
        id: Number(result.lastInsertRowid),
        ...parsed,
      };
    } catch (error) {
      throw new MemoryOperationError('Could not append the audit entry.', {
        cause: error,
      });
    }
  }

  /** Lists recent entries matching optional filters. */
  public list(query: AuditQuery = {}): AuditEntry[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (query.tier !== undefined) {
      conditions.push('risk_tier = ?');
      values.push(query.tier);
    }
    if (query.since !== undefined) {
      z.string().datetime().parse(query.since);
      conditions.push('timestamp >= ?');
      values.push(query.since);
    }
    const limit =
      query.limit === undefined || !Number.isFinite(query.limit)
        ? 50
        : Math.max(1, Math.min(500, Math.floor(query.limit)));
    values.push(limit);
    const where =
      conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.#database.connection
      .prepare<(string | number)[], AuditRow>(
        `SELECT id, timestamp, command, risk_tier, matched_rule, decision,
                outcome, exit_code, duration_ms
         FROM audit_log
         ${where}
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(...values);
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      command: row.command,
      riskTier: row.risk_tier,
      matchedRule: row.matched_rule,
      decision: row.decision,
      outcome: row.outcome,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
    }));
  }
}
