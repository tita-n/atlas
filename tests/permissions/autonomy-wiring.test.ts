/**
 * Live-wiring tests for autonomy and the hard floor.
 *
 * These deliberately go through a real `ShellTool` with a real `ShellSession`
 * and assert on the audit row plus whether a prompt happened.
 *
 * Reason this file exists: a previous version of the autonomy work passed 41
 * unit tests while `#hardFloor` and `#autonomy` were declared and read but
 * never assigned in the `ConfirmationFlow` constructor. Every one of those
 * tests called the pure functions directly, so the dead branch was invisible.
 * A test that only exercises `shouldAsk` is not evidence the gate is wired.
 */
import { describe, expect, it } from 'vitest';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLog } from '../../src/audit/audit-log.js';
import { ConfirmationFlow } from '../../src/permissions/confirmation-flow.js';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import {
  DEFAULT_PERMISSION_RULES,
  HARD_DENY_RULES,
} from '../../src/permissions/default-rules.js';
import type { AutonomyLevel } from '../../src/permissions/autonomy.js';
import {
  hardFloorVerdict,
  readAutonomySync,
  saveAutonomy,
} from '../../src/permissions/autonomy.js';
import { openDatabase } from '../../src/memory/database.js';
import { ShellSession } from '../../src/shell/shell-session.js';
import { ShellTool } from '../../src/shell/shell-tool.js';

const HOME = '/home/tester';

/** Records every prompt the gate raises, so "did it ask" is observable. */
interface Harness {
  readonly tool: ShellTool;
  readonly audit: AuditLog;
  readonly prompts: () => number;
  readonly close: () => void;
}

function harness(options: {
  level: AutonomyLevel;
  scopedCategories?: readonly string[];
  approve?: boolean;
}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'atlas-autonomy-live-'));
  const database = openDatabase(join(home, 'atlas.db'));
  const audit = new AuditLog(database);
  const session = new ShellSession();
  session.restart();
  let prompts = 0;
  // Declines by default. A test that asserts the gate *asked* must not then
  // execute whatever it asked about - systemctl and friends hang the suite and
  // depend on host state.
  const approve = options.approve ?? false;

  const confirmation = new ConfirmationFlow({
    provider: {
      name: 'stub',
      chatCompletion: () => Promise.resolve({ content: '', model: 'stub' }),
    },
    model: 'stub',
    phrase: 'ATLAS CONFIRM',
    hardFloor: (command) => hardFloorVerdict(command, { home: HOME }).applies,
    autonomy: () => ({
      level: options.level,
      ...(options.scopedCategories === undefined
        ? {}
        : { scopedCategories: options.scopedCategories }),
    }),
    confirmText: () => {
      prompts += 1;
      return Promise.resolve(approve);
    },
    wait: () => Promise.resolve(),
  });

  const tool = new ShellTool({
    session,
    classifier: new RiskClassifier({
      userRules: [...HARD_DENY_RULES, ...DEFAULT_PERMISSION_RULES],
      sudoWhitelistInstalled: false,
    }),
    confirmation,
    auditLog: audit,
    name: 'shell',
    autonomy: () => options.level,
  });

  return {
    tool,
    audit,
    prompts: () => prompts,
    close: () => {
      session.close();
      database.close();
    },
  };
}

async function run(
  h: Harness,
  command: string,
): Promise<{
  asked: boolean;
  entry: ReturnType<AuditLog['list']>[number] | undefined;
}> {
  const before = h.prompts();
  await h.tool.execute({ id: '1', name: 'shell', arguments: { command } });
  const asked = h.prompts() > before;
  const rows = h.audit.list({ limit: 1 });
  return { asked, entry: rows[0] };
}

describe('autonomy changes take effect without a restart', () => {
  // Regression: the level was read once when the runtime was constructed, so
  // lowering it - including via /autonomy in the same session - had no effect
  // on the running process. From the user's side that reads as "the setting
  // does nothing".
  it('picks up a level changed while the session is running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-hot-'));
    const database = openDatabase(join(home, 'atlas.db'));
    const audit = new AuditLog(database);
    const session = new ShellSession();
    session.restart();
    const settingsPath = join(home, 'autonomy.json');

    let prompts = 0;
    const confirmation = new ConfirmationFlow({
      provider: {
        name: 'stub',
        chatCompletion: () => Promise.resolve({ content: '', model: 'stub' }),
      },
      model: 'stub',
      phrase: 'ATLAS CONFIRM',
      hardFloor: (command) => hardFloorVerdict(command, { home: HOME }).applies,
      // The live shape: read the setting at decision time.
      autonomy: () => ({ level: readAutonomySync(home).level }),
      confirmText: () => {
        prompts += 1;
        return Promise.resolve(true);
      },
      wait: () => Promise.resolve(),
    });
    const tool = new ShellTool({
      session,
      classifier: new RiskClassifier({
        userRules: [...HARD_DENY_RULES, ...DEFAULT_PERMISSION_RULES],
        sudoWhitelistInstalled: false,
      }),
      confirmation,
      auditLog: audit,
      name: 'shell',
      autonomy: () => readAutonomySync(home).level,
    });

    const ask = async (): Promise<boolean> => {
      const before = prompts;
      await tool.execute({
        id: '1',
        name: 'shell',
        arguments: { command: 'touch /tmp/atlas-hot-probe' },
      });
      return prompts > before;
    };

    try {
      await saveAutonomy(home, 'confirm-everything');
      expect(await ask()).toBe(true);

      await saveAutonomy(home, 'unattended');
      expect(await ask()).toBe(false);

      await saveAutonomy(home, 'confirm-everything');
      expect(await ask()).toBe(true);
      expect(settingsPath).toContain('autonomy.json');
    } finally {
      session.close();
      database.close();
    }
  });
});

describe('autonomy wiring, end to end', () => {
  it('asks for everything at the default level', async () => {
    const h = harness({ level: 'confirm-everything' });
    try {
      const result = await run(h, 'systemctl stop nginx');
      expect(result.asked).toBe(true);
      expect(result.entry?.autonomy).toBe('confirm-everything');
    } finally {
      h.close();
    }
  });

  it('skips ordinary dangerous work when unattended', async () => {
    const h = harness({ level: 'unattended' });
    try {
      // Once unattended skips the prompt the command really runs, so these use
      // tier-2 commands that are harmless to execute for real. Asserting with
      // /etc or systemctl here would make the suite depend on host state.
      expect((await run(h, 'touch /tmp/atlas-live-probe')).asked).toBe(false);
      expect((await run(h, 'mkdir -p /tmp/atlas-live-dir')).asked).toBe(false);
    } finally {
      h.close();
    }
  });

  it('never lets an unattended run reach a filesystem-root wipe', async () => {
    const h = harness({ level: 'unattended' });
    try {
      // Two distinct mechanisms cover these, and neither permits execution:
      // tier 1 refuses them outright, and the hard floor would prompt if tier 1
      // had not. Asserting the *outcome* rather than "was prompted" covers both,
      // because being hard-denied is strictly stronger than being asked about.
      for (const command of [
        'rm -rf /',
        'rm -rf ~',
        'dd if=/dev/zero of=/dev/sda',
      ]) {
        const result = await run(h, command);
        expect(result.asked || result.entry?.decision === 'blocked').toBe(true);
        expect(result.entry?.outcome).toBe('denied');
        expect(result.entry?.exitCode).toBeNull();
      }
    } finally {
      h.close();
    }
  });

  it('prompts for a hard-floor action that is not already tier 1', async () => {
    const h = harness({ level: 'unattended' });
    try {
      // Not covered by a hard-deny rule, so the hard floor in ConfirmationFlow
      // is the only thing standing between this and execution. If that branch
      // is ever dead again, this assertion is what notices.
      const result = await run(
        h,
        'echo x > /home/tester/.atlas/permissions.json',
      );
      expect(result.asked).toBe(true);
    } finally {
      h.close();
    }
  });

  it('still prompts for hard-floor edits when unattended', async () => {
    const h = harness({ level: 'unattended' });
    try {
      expect(
        (await run(h, 'rm /home/tester/.atlas/permissions.json')).asked,
      ).toBe(true);
      expect((await run(h, 'rm ~/.atlas/autonomy.json')).asked).toBe(true);
    } finally {
      h.close();
    }
  });

  it('skips only what the declared scope covers', async () => {
    const h = harness({
      level: 'scoped-approval',
      scopedCategories: ['filesystem', 'packages'],
    });
    try {
      // filesystem is in scope, so this is skipped and really runs. `systemctl`
      // is out of scope, so it is refused and never executes.
      expect((await run(h, 'touch /tmp/atlas-scope-probe')).asked).toBe(false);
      expect((await run(h, 'systemctl stop nginx')).asked).toBe(true);
    } finally {
      h.close();
    }
  });

  it('asks for anything the scope cannot classify', async () => {
    const h = harness({
      level: 'scoped-approval',
      scopedCategories: ['filesystem'],
    });
    try {
      // Credential reads are deliberately not filed under filesystem, so an
      // approved filesystem scope cannot quietly authorise reading them.
      expect((await run(h, 'cat ~/.aws/credentials')).asked).toBe(true);
    } finally {
      h.close();
    }
  });

  it('records the active level on every audit row', async () => {
    const h = harness({ level: 'unattended' });
    try {
      await run(h, 'chmod 777 /etc/hosts');
      const rows = h.audit.list({ limit: 10 });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.autonomy).toBe('unattended');
    } finally {
      h.close();
    }
  });

  it('refuses an unattended command the user declines at the hard floor', async () => {
    const h = harness({ level: 'unattended', approve: false });
    try {
      const before = (await run(h, 'chmod 777 /etc/hosts')).entry?.exitCode;
      const result = await run(
        h,
        'echo x > /home/tester/.atlas/permissions.json',
      );
      // The gate asked and the answer was no, so nothing ran.
      expect(result.asked).toBe(true);
      expect(result.entry?.outcome).toBe('denied');
      expect(before).not.toBe(0);
    } finally {
      h.close();
    }
  });

  it('keeps previewing available at every level', async () => {
    for (const level of [
      'confirm-everything',
      'scoped-approval',
      'unattended',
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), 'atlas-dry-'));
      const database = openDatabase(join(home, 'atlas.db'));
      const audit = new AuditLog(database);
      const session = new ShellSession();
      session.restart();
      const tool = new ShellTool({
        session,
        classifier: new RiskClassifier({
          userRules: [...HARD_DENY_RULES, ...DEFAULT_PERMISSION_RULES],
          sudoWhitelistInstalled: false,
        }),
        confirmation: new ConfirmationFlow({
          provider: {
            name: 'stub',
            chatCompletion: () =>
              Promise.resolve({ content: '', model: 'stub' }),
          },
          model: 'stub',
          phrase: 'ATLAS CONFIRM',
          hardFloor: (command) =>
            hardFloorVerdict(command, { home: HOME }).applies,
          autonomy: () => ({ level }),
          confirmText: () => Promise.resolve(true),
          wait: () => Promise.resolve(),
        }),
        auditLog: audit,
        name: 'shell',
        autonomy: () => level,
        dryRun: () => Promise.resolve('preview output'),
      });
      const result = await tool.execute({
        id: '1',
        name: 'shell',
        arguments: {
          command: 'touch /tmp/atlas-dry-should-not-exist',
          dryRun: true,
        },
      });
      expect(result.content).toContain('Preview only');
      // A static plan deliberately executes nothing, so there is no native
      // output to show; the caveat must still be there.
      expect(result.content).toContain('describ');
      session.close();
      database.close();
    }
  });
});
