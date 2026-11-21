/**
 * The shared gate must actually carry the autonomy level through.
 *
 * `tests/permissions/autonomy-wiring.test.ts` builds a `ConfirmationFlow`
 * directly and passes `autonomy` to it, so it passes whether or not the real
 * product path passes one. `createGate` - the single construction path both
 * front-ends use - built the options object by hand and simply left `autonomy`
 * out. `ConfirmationFlow` then read `undefined` and fell back to
 * 'confirm-everything', so `atlas autonomy --level unattended` was accepted,
 * stored, displayed, audited... and did nothing.
 *
 * These tests go through `createGate`, which is the only way to catch that.
 */
import { describe, expect, it } from 'vitest';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLog } from '../../src/audit/audit-log.js';
import { createGate } from '../../src/permissions/gate.js';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import {
  DEFAULT_PERMISSION_RULES,
  HARD_DENY_RULES,
} from '../../src/permissions/default-rules.js';
import type { AutonomyLevel } from '../../src/permissions/autonomy.js';
import { openDatabase } from '../../src/memory/database.js';
import type { ExecutionSession } from '../../src/execution/environment.js';
import { ShellTool } from '../../src/shell/shell-tool.js';

const HOME = '/home/tester';

/**
 * A command that needs a person at confirm-everything but is recoverable, so
 * the only thing separating "asked" from "ran" is the autonomy level itself.
 */
const RECOVERABLE_DANGEROUS = 'systemctl restart nginx';

function harness(level: AutonomyLevel): {
  readonly tool: ShellTool;
  readonly prompts: () => number;
  /** Commands that actually reached the execution session. */
  readonly executed: () => readonly string[];
  readonly close: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'atlas-gate-wiring-'));
  const database = openDatabase(join(home, 'atlas.db'));
  const audit = new AuditLog(database);
  // A recording session, not a real shell.
  //
  // Before the autonomy fix this test never executed anything, because the gate
  // always asked and the harness always declined. Once `unattended` started
  // working for real, the test began running `systemctl restart nginx` on the
  // developer's machine - which hung intermittently and failed the suite for
  // reasons that had nothing to do with what it was testing.
  const executed: string[] = [];
  const session: ExecutionSession = {
    currentDirectory: HOME,
    running: true,
    execute: (command: string) => {
      executed.push(command);
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
      });
    },
    restart: () => undefined,
    close: () => undefined,
  };
  let prompts = 0;

  const confirmation = createGate({
    provider: {
      name: 'stub',
      chatCompletion: () => Promise.resolve({ content: '', model: 'stub' }),
    },
    model: 'stub',
    blockAll: false,
    autonomy: () => level,
    home: HOME,
    // Declines, so a test that expects a prompt cannot then run systemctl.
    ask: () => {
      prompts += 1;
      return Promise.resolve('deny');
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
    autonomy: () => level,
  });

  return {
    tool,
    prompts: () => prompts,
    executed: () => executed,
    close: () => {
      database.close();
    },
  };
}

describe('the shared gate forwards the autonomy level', () => {
  it('asks at confirm-everything', async () => {
    const h = harness('confirm-everything');
    try {
      await h.tool.execute({
        id: '1',
        name: 'shell',
        arguments: { command: RECOVERABLE_DANGEROUS },
      });
      expect(h.prompts()).toBe(1);
    } finally {
      h.close();
    }
  });

  it('does not ask at unattended', async () => {
    const h = harness('unattended');
    try {
      await h.tool.execute({
        id: '2',
        name: 'shell',
        arguments: { command: 'echo unattended-reaches-the-gate' },
      });
      // A benign command never prompts at any level, so the assertion that
      // actually distinguishes the levels is on a tier-2 command below.
      expect(h.prompts()).toBe(0);
    } finally {
      h.close();
    }
  });

  it('does not prompt for a tier-2 command at unattended, and runs it', async () => {
    const h = harness('unattended');
    try {
      await h.tool.execute({
        id: '1',
        name: 'shell',
        arguments: { command: RECOVERABLE_DANGEROUS },
      });
      expect(h.prompts()).toBe(0);
      // The positive half. "No prompt" would also be satisfied by a silent
      // refusal, which is a different and much worse bug; the whole point of
      // unattended is that the command runs without asking.
      expect(h.executed()).toContain(RECOVERABLE_DANGEROUS);
    } finally {
      h.close();
    }
  });

  it('still applies the hard floor at unattended', async () => {
    const h = harness('unattended');
    try {
      const result = await h.tool.execute({
        id: '3',
        name: 'shell',
        arguments: { command: 'rm -rf ~/*' },
      });
      // The floor is not a prompt, it is a refusal: unattended must not make
      // this one ask, and must not let it run.
      expect(h.prompts()).toBe(0);
      expect(result.isError).toBe(true);
    } finally {
      h.close();
    }
  });
});