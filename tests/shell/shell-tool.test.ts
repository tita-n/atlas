import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { openDatabase } from '../../src/memory/database.js';
import { ConfirmationFlow } from '../../src/permissions/confirmation-flow.js';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import { ShellSession } from '../../src/shell/shell-session.js';
import { ShellTool } from '../../src/shell/shell-tool.js';
import type { LLMProvider } from '../../src/providers/provider.interface.js';

const directories: string[] = [];
const sessions: ShellSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  tool: ShellTool;
  audit: AuditLog;
  confirmText: ReturnType<typeof vi.fn>;
  close: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-shell-tool-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'atlas.db'));
  const session = new ShellSession({ timeoutMs: 5_000 });
  sessions.push(session);
  const audit = new AuditLog(database);
  const provider: LLMProvider = {
    name: 'mock',
    chatCompletion: () =>
      Promise.resolve({
        content: 'This command changes a scoped path.',
        model: 'mock',
      }),
  };
  const confirmText = vi.fn().mockResolvedValue(false);
  const confirmation = new ConfirmationFlow({
    provider,
    model: 'mock',
    confirmText,
    wait: () => Promise.resolve(),
  });
  const tool = new ShellTool({
    session,
    classifier: new RiskClassifier(),
    confirmation,
    auditLog: audit,
  });
  return {
    tool,
    audit,
    confirmText,
    close: () => {
      database.close();
    },
  };
}

describe('ShellTool', () => {
  it('executes Tier 0 without invoking confirmation', async () => {
    const fixtureValue = await fixture();
    try {
      const result = await fixtureValue.tool.execute({
        id: 'call-1',
        name: 'shell',
        arguments: { command: 'printf safe' },
      });

      expect(result.isError).toBe(false);
      expect(result.content).toContain('safe');
      expect(fixtureValue.confirmText).not.toHaveBeenCalled();
      expect(fixtureValue.audit.list()[0]).toMatchObject({
        command: 'printf safe',
        decision: 'allowed',
        riskTier: 0,
      });
    } finally {
      fixtureValue.close();
    }
  });

  it('blocks Tier 1 before confirmation and records the attempt', async () => {
    const fixtureValue = await fixture();
    try {
      const result = await fixtureValue.tool.execute({
        id: 'call-1',
        name: 'shell',
        arguments: { command: 'rm -rf /' },
      });

      expect(result.isError).toBe(true);
      expect(fixtureValue.confirmText).not.toHaveBeenCalled();
      expect(fixtureValue.audit.list()[0]).toMatchObject({
        command: 'rm -rf /',
        decision: 'blocked',
        riskTier: 1,
        outcome: 'not executed',
      });
    } finally {
      fixtureValue.close();
    }
  });

  it('executes an approved Tier 2 command and records approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-tier2-'));
    directories.push(directory);
    const target = join(directory, 'target.txt');
    await writeFile(target, 'before');
    const fixtureValue = await fixture();
    fixtureValue.confirmText.mockResolvedValue(true);
    try {
      const result = await fixtureValue.tool.execute({
        id: 'call-1',
        name: 'shell',
        arguments: { command: `chmod 600 ${JSON.stringify(target)}` },
      });

      expect(result.isError).toBe(false);
      expect(fixtureValue.confirmText).toHaveBeenCalledOnce();
      expect(fixtureValue.audit.list()[0]).toMatchObject({
        decision: 'asked-approved',
        riskTier: 2,
      });
    } finally {
      fixtureValue.close();
    }
  });

  it('does not execute a denied Tier 2 command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-tier2-deny-'));
    directories.push(directory);
    const target = join(directory, 'target.txt');
    await writeFile(target, 'before');
    const fixtureValue = await fixture();
    fixtureValue.confirmText.mockResolvedValue(false);
    try {
      const result = await fixtureValue.tool.execute({
        id: 'call-1',
        name: 'shell',
        arguments: { command: `chmod 600 ${JSON.stringify(target)}` },
      });

      expect(result.isError).toBe(true);
      expect(fixtureValue.confirmText).toHaveBeenCalledOnce();
      expect(fixtureValue.audit.list()[0]).toMatchObject({
        decision: 'asked-denied',
        outcome: 'not executed',
      });
    } finally {
      fixtureValue.close();
    }
  });
});
