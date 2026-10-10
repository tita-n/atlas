/**
 * The record of self-modification attempts.
 *
 * Append-only, and stored beside Atlas's other state rather than in the repo,
 * so the thing that rewrites the code cannot also rewrite the record of having
 * rewritten it.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AttemptOutcome =
  | 'proposed'
  | 'refused-protected'
  | 'failed-verification'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'snapshot-failed'
  | 'rolled-back';

export interface LedgerEntry {
  readonly at: string;
  readonly outcome: AttemptOutcome;
  readonly summary: string;
  /** Files the change would have written. */
  readonly paths: readonly string[];
  /** Plain-language explanation shown to the user. */
  readonly explanation: string;
  /** Snapshot sha once applied. */
  readonly sha?: string | undefined;
  /** Set when health failed and rollback ran. */
  readonly rolledBack?: boolean | undefined;
  readonly detail?: string | undefined;
}

export function ledgerPath(atlasHome: string): string {
  return join(atlasHome, 'selfmod-ledger.jsonl');
}

/** Appends one record. Best effort: a ledger write must not break the flow. */
export function appendLedger(atlasHome: string, entry: LedgerEntry): void {
  try {
    appendFileSync(ledgerPath(atlasHome), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Losing a ledger line is bad; crashing a task over it is worse.
  }
}

/** Reads the record back, skipping any malformed line rather than failing. */
export function readLedger(atlasHome: string): LedgerEntry[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(atlasHome), 'utf8');
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as LedgerEntry);
      }
    } catch {
      // A torn line is skipped; the rest of the record still reads.
    }
  }
  return entries;
}

/** Snapshots that were applied and not subsequently rolled back. */
export function appliedSnapshots(entries: readonly LedgerEntry[]): {
  sha: string;
  summary: string;
  at: string;
}[] {
  const rolledBackShas = new Set(
    entries
      .filter((entry) => entry.rolledBack === true)
      .map((entry) => entry.sha ?? ''),
  );
  return entries
    .filter(
      (entry) =>
        entry.outcome === 'applied' &&
        typeof entry.sha === 'string' &&
        entry.sha !== '' &&
        !rolledBackShas.has(entry.sha),
    )
    .map((entry) => ({
      sha: entry.sha ?? '',
      summary: entry.summary,
      at: entry.at,
    }));
}
