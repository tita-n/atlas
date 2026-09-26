import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { loadPermissionConfig } from '../../src/config/permission-config.js';
import { ConfirmationFlow } from '../../src/permissions/confirmation-flow.js';
import { PermissionGrantStore } from '../../src/permissions/grant-store.js';
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

describe('durable grant integration', () => {
  it('remembers an approved Tier 2 command and skips the identical repeat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-grant-int-'));
    directories.push(directory);
    const target = join(directory, 'target.txt');
    await writeFile(target, 'before');
    const configPath = join(directory, 'permissions.json');
    const config = { rules: [], grants: [], sourcePath: configPath };
    const store = PermissionGrantStore.fromConfig(config);
    const database = (
      await import('../../src/memory/database.js')
    ).openDatabase(join(directory, 'atlas.db'));
    const provider: LLMProvider = {
      name: 'mock',
      chatCompletion: () =>
        Promise.resolve({
          content: 'This changes file permissions.',
          model: 'mock',
        }),
    };
    const confirmText = vi.fn().mockResolvedValue('remember');
    const confirmation = new ConfirmationFlow({
      provider,
      model: 'mock',
      confirmText,
      wait: () => Promise.resolve(),
    });
    const session = new ShellSession();
    sessions.push(session);
    const firstTool = new ShellTool({
      session,
      classifier: new RiskClassifier({ grantMatcher: store }),
      confirmation,
      auditLog: new AuditLog(database),
      grantStore: store,
    });

    const command = `chmod 600 ${JSON.stringify(target)}`;
    const first = await firstTool.execute({
      id: 'call-1',
      name: 'shell',
      arguments: { command },
    });
    expect(first.isError).toBe(false);
    expect(confirmText).toHaveBeenCalledOnce();

    const loaded = await loadPermissionConfig({ configPath });
    const reloadedStore = PermissionGrantStore.fromConfig(loaded);
    const secondConfirm = vi.fn().mockResolvedValue('deny');
    const secondTool = new ShellTool({
      session,
      classifier: new RiskClassifier({ grantMatcher: reloadedStore }),
      confirmation: new ConfirmationFlow({
        provider,
        model: 'mock',
        confirmText: secondConfirm,
        wait: () => Promise.resolve(),
      }),
      auditLog: new AuditLog(database),
      grantStore: reloadedStore,
    });
    const second = await secondTool.execute({
      id: 'call-2',
      name: 'shell',
      arguments: { command },
    });
    expect(second.isError).toBe(false);
    expect(secondConfirm).not.toHaveBeenCalled();
    database.close();
  });

  it('downgrades bash -c remember requests to one-time approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-grant-refuse-'));
    directories.push(directory);
    const configPath = join(directory, 'permissions.json');
    const store = PermissionGrantStore.fromConfig({
      rules: [],
      grants: [],
      sourcePath: configPath,
    });
    const result = await store.remember('bash -c "echo hi"');

    expect(result.persisted).toBe(false);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });
});
