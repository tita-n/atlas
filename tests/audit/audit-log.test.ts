import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { openDatabase } from '../../src/memory/database.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('AuditLog', () => {
  it('app/query filters attempts without exposing destructive methods', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-audit-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'atlas.db'));
    const audit = new AuditLog(database);

    try {
      audit.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        command: 'ls',
        riskTier: 0,
        matchedRule: 'default-tier-0',
        decision: 'allowed',
        outcome: 'succeeded',
        exitCode: 0,
        durationMs: 3,
        gatePath: 'auto-allow',
      });
      audit.append({
        timestamp: '2026-01-02T00:00:00.000Z',
        command: 'rm -rf /',
        riskTier: 1,
        matchedRule: 'hard-deny-rm-root',
        decision: 'blocked',
        outcome: 'denied',
        exitCode: null,
        durationMs: null,
        gatePath: 'hard-block',
      });

      expect(audit.list()).toHaveLength(2);
      expect(audit.list({ tier: 1 })[0]?.command).toBe('rm -rf /');
      expect(audit.list({ since: '2026-01-02T00:00:00.000Z' })).toHaveLength(1);
      expect('delete' in audit).toBe(false);
      expect('truncate' in audit).toBe(false);
    } finally {
      database.close();
    }
  });

  it('refuses to record a dangerous decision with no gate path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-audit-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'atlas.db'));
    const audit = new AuditLog(database);
    const base = {
      timestamp: '2026-01-01T00:00:00.000Z',
      command: 'rm -rf /tmp/x',
      riskTier: 3,
      matchedRule: 'confirm-tier-3',
      exitCode: null,
      durationMs: null,
    } as const;

    try {
      // The interim typed-safe-word period is only reviewable if every
      // dangerous approval names the path that approved it.
      for (const decision of ['asked-approved', 'asked-denied'] as const) {
        expect(() =>
          audit.append({ ...base, decision, outcome: 'succeeded' }),
        ).toThrow();
      }
      expect(() =>
        audit.append({ ...base, decision: 'blocked', outcome: 'denied' }),
      ).toThrow();
      expect(() =>
        audit.append({ ...base, decision: 'allowed', outcome: 'succeeded' }),
      ).toThrow();
      expect(
        database.connection
          .prepare('SELECT count(*) AS c FROM audit_log')
          .get() as { c: number },
      ).toEqual({ c: 0 });

      // With a path, the same entries are accepted.
      const entry = audit.append({
        ...base,
        decision: 'asked-approved',
        outcome: 'succeeded',
        gatePath: 'text-safe-word',
      });
      expect(entry.gatePath).toBe('text-safe-word');
      expect(audit.list({ gatePath: 'text-safe-word' })).toHaveLength(1);

      // A preview bypassed the gate, so it must not claim one.
      expect(() =>
        audit.append({
          ...base,
          decision: 'previewed',
          outcome: 'previewed-only',
          gatePath: 'text-safe-word',
        }),
      ).toThrow();
      audit.append({
        ...base,
        decision: 'previewed',
        outcome: 'previewed-only',
      });
      expect(audit.list({ gatePath: 'text-safe-word' })).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('filters on every query field and clamps the limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-audit-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'atlas.db'));
    const audit = new AuditLog(database);
    try {
      audit.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        eventKind: 'command',
        command: 'ls',
        gatePath: 'auto-allow',
        riskTier: 0,
        matchedRule: 'r0',
        decision: 'allowed',
        outcome: 'succeeded',
        exitCode: 0,
        durationMs: 1,
      });
      audit.append({
        timestamp: '2026-01-05T00:00:00.000Z',
        eventKind: 'command',
        command: 'rm -rf /tmp/x',
        gatePath: 'text-safe-word',
        riskTier: 3,
        matchedRule: 'r3',
        decision: 'asked-approved',
        outcome: 'succeeded',
        exitCode: 0,
        durationMs: 2,
      });
      audit.append({
        timestamp: '2026-01-09T00:00:00.000Z',
        eventKind: 'self-modification',
        command: 'settings update',
        riskTier: 3,
        matchedRule: 'self',
        decision: 'previewed',
        outcome: 'previewed-only',
        exitCode: null,
        durationMs: null,
      });

      expect(audit.list({ tier: 0 })).toHaveLength(1);
      expect(audit.list({ tier: 3 })).toHaveLength(2);
      expect(audit.list({ since: '2026-01-05T00:00:00.000Z' })).toHaveLength(2);
      expect(audit.list({ until: '2026-01-05T00:00:00.000Z' })).toHaveLength(2);
      expect(audit.list({ outcome: 'previewed-only' })).toHaveLength(1);
      expect(audit.list({ gatePath: 'auto-allow' })).toHaveLength(1);
      expect(audit.list({ eventKind: 'self-modification' })).toHaveLength(1);
      expect(audit.list({ eventKind: 'command' })).toHaveLength(2);
      expect(
        audit.list({ since: '2026-01-05T00:00:00.000Z', tier: 3 }),
      ).toHaveLength(2);

      // Most recent first, with id as the tiebreak.
      expect(audit.list().map((entry) => entry.command)).toEqual([
        'settings update',
        'rm -rf /tmp/x',
        'ls',
      ]);

      expect(audit.list({ limit: 1 })).toHaveLength(1);
      expect(audit.list({ limit: 0 })).toHaveLength(1);
      expect(audit.list({ limit: -5 })).toHaveLength(1);
      expect(audit.list({ limit: 10_000 })).toHaveLength(3);
      expect(audit.list({ limit: Number.NaN })).toHaveLength(3);

      // Unknown values must narrow to nothing, never widen to everything.
      const unknown = audit.list({
        outcome: 'nope' as never,
        gatePath: 'nope' as never,
        eventKind: 'nope' as never,
        tier: 9 as never,
      });
      expect(unknown).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects malformed entries instead of storing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-audit-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'atlas.db'));
    const audit = new AuditLog(database);
    const base = {
      timestamp: '2026-01-01T00:00:00.000Z',
      command: 'ls',
      gatePath: 'auto-allow' as const,
      riskTier: 0,
      matchedRule: 'r0',
      decision: 'allowed' as const,
      outcome: 'succeeded' as const,
      exitCode: 0,
      durationMs: 1,
    };
    try {
      const malformed: unknown[] = [
        { ...base, timestamp: 'not-a-timestamp' },
        { ...base, timestamp: '2026-01-01 00:00:00' },
        { ...base, riskTier: 9 },
        { ...base, riskTier: -1 },
        { ...base, riskTier: 1.5 },
        { ...base, decision: 'maybe' },
        { ...base, outcome: 'maybe' },
        { ...base, gatePath: 'telepathy' },
        { ...base, eventKind: 'self-destruction' },
        { ...base, command: undefined },
        { ...base, matchedRule: '' },
        { ...base, durationMs: -1 },
        { timestamp: base.timestamp, gatePath: base.gatePath },
      ];
      for (const entry of malformed) {
        expect(
          () => audit.append(entry as never),
          JSON.stringify(entry),
        ).toThrow();
      }
      expect(
        database.connection
          .prepare('SELECT count(*) AS c FROM audit_log')
          .get() as { c: number },
      ).toEqual({ c: 0 });
    } finally {
      database.close();
    }
  });
});
