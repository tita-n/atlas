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
  sandbox_backend: 'local' | 'bwrap' | 'refusing' | null;
  sandbox_profile: 'read-only' | 'workspace-write' | 'full-access' | null;
  sandbox_writable_roots: string | null;
  sandbox_network: 0 | 1 | null;
  escalated: 0 | 1;
  risk_tier: 0 | 1 | 2 | 3;
  matched_rule: string;
  decision: AuditDecision;
  outcome: AuditOutcome;
  exit_code: number | null;
  duration_ms: number | null;
}

/** The isolation context stamped onto an audit row. */
export type SandboxContext = NonNullable<
  z.infer<typeof auditEntryInputSchema>['sandbox']
>;

/** One queryable audit-log row, with every optional field resolved. */
export interface AuditEntry extends Omit<
  AuditEntryInput,
  'eventKind' | 'summary' | 'gatePath' | 'sandbox'
> {
  /** SQLite audit row identifier. */
  id: number;
  eventKind: AuditEventKind;
  summary: string | null;
  gatePath: GatePath | null;
  autonomy: 'confirm-everything' | 'scoped-approval' | 'unattended' | null;
  sandbox: SandboxContext | null;
}

/**
 * Rehydrates the isolation context.
 *
 * A malformed blob is treated as absent rather than thrown on: refusing to
 * show an audit row because one optional column is corrupt would be a worse
 * failure than showing the row with the context missing.
 */
function parseSandbox(row: AuditRow): SandboxContext | null {
  if (
    row.sandbox_backend === null ||
    row.sandbox_profile === null
  ) {
    return null;
  }
  let roots: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.sandbox_writable_roots ?? '[]');
    if (Array.isArray(parsed)) roots = parsed.map(String);
  } catch {
    roots = [];
  }
  return {
    backend: row.sandbox_backend,
    profile: row.sandbox_profile,
    writableRoots: roots,
    networkEnabled: row.sandbox_network === 1,
    escalated: row.escalated === 1,
  };
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
      sandbox: parsed.sandbox ?? null,
    };
    try {
      const result = this.#database.connection
        .prepare(
          `INSERT INTO audit_log
           (timestamp, event_kind, command, summary, gate_path, autonomy,
            sandbox_backend, sandbox_profile, sandbox_writable_roots,
            sandbox_network, escalated,
            risk_tier, matched_rule, decision, outcome, exit_code, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.timestamp,
          entry.eventKind,
          entry.command,
          entry.summary,
          entry.gatePath,
          entry.autonomy,
          entry.sandbox?.backend ?? null,
          entry.sandbox?.profile ?? null,
          entry.sandbox == null
            ? null
            : JSON.stringify(entry.sandbox.writableRoots),
          entry.sandbox == null
            ? null
            : entry.sandbox.networkEnabled
              ? 1
              : 0,
          entry.sandbox?.escalated === true ? 1 : 0,
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
                autonomy, sandbox_backend, sandbox_profile,
                sandbox_writable_roots, sandbox_network, escalated,
                risk_tier, matched_rule, decision, outcome,
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
      sandbox: parseSandbox(row),
      riskTier: row.risk_tier,
      matchedRule: row.matched_rule,
      decision: row.decision,
      outcome: row.outcome,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
    }));
  }
}
