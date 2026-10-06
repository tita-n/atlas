import { z } from 'zod';
import { MemoryOperationError } from '../errors.js';
import type { MemoryDatabase } from '../memory/database.js';
import {
  auditEntryInputSchema,
  type AuditDecision,
  type AuditEntryInput,
  type AuditEventKind,
  type AuditOutcome,
  type GatePath,
  type AuditQuery,
} from './audit-log.schema.js';

interface AuditRow {
  id: number;
  timestamp: string;
  event_kind: AuditEventKind;
  command: string;
  summary: string | null;
  gate_path: GatePath | null;
  autonomy: 'confirm-everything' | 'scoped-approval' | 'unattended' | null;
  risk_tier: 0 | 1 | 2 | 3;
  matched_rule: string;
  decision: AuditDecision;
  outcome: AuditOutcome;
  exit_code: number | null;
  duration_ms: number | null;
}

/** One queryable audit-log row, with every optional field resolved. */
export interface AuditEntry extends Omit<
  AuditEntryInput,
  'eventKind' | 'summary' | 'gatePath'
> {
  /** SQLite audit row identifier. */
  id: number;
  eventKind: AuditEventKind;
  summary: string | null;
  gatePath: GatePath | null;
  autonomy: 'confirm-everything' | 'scoped-approval' | 'unattended' | null;
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
    const entry = {
      ...parsed,
      eventKind: parsed.eventKind ?? ('command' as const),
      summary: parsed.summary ?? null,
      gatePath: parsed.gatePath ?? null,
      autonomy: parsed.autonomy ?? null,
    };
    try {
      const result = this.#database.connection
        .prepare(
          `INSERT INTO audit_log
           (timestamp, event_kind, command, summary, gate_path, autonomy,
            risk_tier, matched_rule, decision, outcome, exit_code, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.timestamp,
          entry.eventKind,
          entry.command,
          entry.summary,
          entry.gatePath,
          entry.autonomy,
          parsed.riskTier,
          parsed.matchedRule,
          parsed.decision,
          parsed.outcome,
          parsed.exitCode,
          parsed.durationMs,
        );
      return { id: Number(result.lastInsertRowid), ...entry };
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
    if (query.until !== undefined) {
      z.string().datetime().parse(query.until);
      conditions.push('timestamp <= ?');
      values.push(query.until);
    }
    if (query.outcome !== undefined) {
      conditions.push('outcome = ?');
      values.push(query.outcome);
    }
    if (query.gatePath !== undefined) {
      conditions.push('gate_path = ?');
      values.push(query.gatePath);
    }
    if (query.autonomy !== undefined) {
      conditions.push('autonomy = ?');
      values.push(query.autonomy);
    }
    if (query.eventKind !== undefined) {
      conditions.push('event_kind = ?');
      values.push(query.eventKind);
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
        `SELECT id, timestamp, event_kind, command, summary, gate_path,
                autonomy, risk_tier, matched_rule, decision, outcome,
                exit_code, duration_ms
         FROM audit_log
         ${where}
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(...values);
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      eventKind: row.event_kind,
      command: row.command,
      summary: row.summary,
      gatePath: row.gate_path,
      autonomy: row.autonomy,
      riskTier: row.risk_tier,
      matchedRule: row.matched_rule,
      decision: row.decision,
      outcome: row.outcome,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
    }));
  }
}
