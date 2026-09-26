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
        outcome: 'exit code 0',
        exitCode: 0,
        durationMs: 3,
      });
      audit.append({
        timestamp: '2026-01-02T00:00:00.000Z',
        command: 'rm -rf /',
        riskTier: 1,
        matchedRule: 'hard-deny-rm-root',
        decision: 'blocked',
        outcome: 'not executed',
        exitCode: null,
        durationMs: null,
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
});
