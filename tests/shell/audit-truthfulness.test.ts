import { describe, expect, it } from 'vitest';
import { ShellTool } from '../../src/shell/shell-tool.js';
import type { AuditEntry, AuditLog } from '../../src/audit/audit-log.js';
import type { AuditEntryInput } from '../../src/audit/audit-log.schema.js';
import type { ToolCall } from '../../src/providers/provider.interface.js';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import { ConfirmationFlow } from '../../src/permissions/confirmation-flow.js';
import type { ExecutionSession } from '../../src/execution/environment.js';
import type { CommandResult } from '../../src/shell/command-result.js';

/**
 * The audit log's job is to be reviewable. A row that claims a human was
 * asked when nobody was asked makes every unattended run look supervised,
 * which is the specific confusion the `gate_path` column was widened to fix.
 */

interface Recorded {
  rows: AuditEntry[];
  ran: string[];
}

/** A session that records what it was asked to run and always succeeds. */
function session(ran: string[]): ExecutionSession {
  return {
    currentDirectory: '/work',
    running: true,
    execute(command: string): Promise<CommandResult> {
      ran.push(command);
      return Promise.resolve({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      } as CommandResult);
    },
    restart(): void {
      /* a test session is never torn down */
    },
    close(): void {
      /* a test session is never torn down */
    },
  };
}

/** A ConfirmationFlow whose review outcome the caller controls. */
function gate(
  approved: boolean,
  confirmationRequested: boolean,
  onExplanations?: () => void,
): ConfirmationFlow {
  return {
    review: () => {
      onExplanations?.();
      return Promise.resolve({
        approved,
        choice: approved ? 'once' : 'deny',
        explanation: 'because',
        confirmationRequested,
        informational: false,
      });
    },
  } as unknown as ConfirmationFlow;
}

const call = (command: string): ToolCall => ({
  id: 'call_test',
  name: 'shell',
  arguments: { command },
});

const sandbox = (backend: 'bwrap' | 'local') => () => ({
  backend,
  profile: 'workspace-write' as const,
  writableRoots: ['/work'],
  networkEnabled: false,
  escalated: false,
});

function build(opts: {
  approved: boolean;
  confirmationRequested: boolean;
  backend?: 'bwrap' | 'local';
}): { tool: ShellTool; rec: Recorded } {
  const rec: Recorded = { rows: [], ran: [] };
  const audit = {
    append(input: AuditEntryInput): AuditEntry {
      // Defaults FIRST, then the real values, so a provided field wins
      // without the optional-undefined type leaking through the spread.
      const entry = {
        eventKind: 'command',
        summary: null,
        gatePath: null,
        autonomy: null,
        sandbox: null,
        ...input,
        id: rec.rows.length + 1,
      } as AuditEntry;
      rec.rows.push(entry);
      return entry;
    },
  };
  const tool = new ShellTool({
    session: session(rec.ran),
    classifier: new RiskClassifier(),
    confirmation: gate(opts.approved, opts.confirmationRequested),
    auditLog: audit as unknown as AuditLog,
    sandbox: sandbox(opts.backend ?? 'bwrap'),
  });
  return { tool, rec };
}

describe('truthful gate_path', () => {
  it('a durable grant CANNOT skip the hard floor', async () => {
    // The bug: a stored grant dropped a command to tier 0, which skipped
    // review() - and review() was the only place the floor ran, so one
    // remembered approval disabled the floor permanently. The floor is now
    // evaluated in the shell tool, before the grant is consulted.
    const rec: Recorded = { rows: [], ran: [] };
    const audit = {
      append(input: AuditEntryInput): AuditEntry {
        const entry = {
          eventKind: 'command',
          summary: null,
          gatePath: null,
          autonomy: null,
          sandbox: null,
          ...input,
          id: rec.rows.length + 1,
        } as AuditEntry;
        rec.rows.push(entry);
        return entry;
      },
    };
    // A grant that matches ANY command, including the floor command below. The
    // command is chosen so the classifier really is talked down to tier 0 by
    // the grant (`permission-grant`, `allow`): that is the only shape where the
    // floor is the sole thing standing between the grant and the action.
    const grant = {
      id: '11111111-1111-4111-8111-111111111111',
      executablePath: '/usr/bin/tee',
      argv: [],
      cwd: '/work',
      createdAt: new Date().toISOString(),
    };
    const grantStore = {
      match: () => grant,
    };
    const classifier = new RiskClassifier({
      grantMatcher: grantStore,
    });
    const command = "echo '{}' > ~/.atlas/permissions.json";
    // Preconditions, asserted so the test cannot pass for the wrong reason: the
    // classifier ALLOWS it because of the grant, and only the floor objects.
    expect(classifier.assess(command, '/work').decision).toBe('allow');
    expect(classifier.assess(command, '/work').tier).toBe(0);
    const tool = new ShellTool({
      session: session(rec.ran),
      classifier,
      confirmation: gate(true, false),
      auditLog: audit as unknown as AuditLog,
      grantStore: grantStore as never,
      sandbox: sandbox('bwrap'),
    });

    const result = await tool.execute(call(command));
    expect(rec.ran).toEqual([]);
    expect(rec.rows[0]?.decision).toBe('blocked');
    expect(rec.rows[0]?.outcome).toBe('denied');
    expect(rec.rows[0]?.gatePath).toBe('denied-hard-floor');
    expect(result.isError).toBe(true);
  });

  it('records asked-approved only when a human was actually asked', async () => {
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: true,
    });
    // Needs confirmation, but is deliberately NOT a hard-floor command:
    // `rm -rf /` is refused before the gate is ever consulted, so it cannot
    // exercise the asked/not-asked distinction at all.
    await tool.execute(call('npm publish --access public'));
    expect(rec.rows[0]?.decision).toBe('asked-approved');
  });

  it('does NOT claim a human was asked when autonomy auto-approved', async () => {
    // The bug this file exists for: requiresConfirmation is true, the gate
    // approves without prompting, and the row still said asked-approved.
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: false,
    });
    await tool.execute(call('npm publish --access public'));
    expect(rec.rows[0]?.decision).toBe('allowed');
    expect(rec.rows[0]?.gatePath).not.toBe('text-safe-word');
    expect(rec.rows[0]?.gatePath).not.toBe('voice-paired');
  });

  it('names the sandbox when it was the boundary', async () => {
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: false,
    });
    await tool.execute(call('echo hi'));
    expect(rec.rows[0]?.gatePath).toBe('auto-allow-sandboxed');
  });

  it('does not claim a sandbox when there is none', async () => {
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: false,
      backend: 'local',
    });
    await tool.execute(call('echo hi'));
    // Claiming confinement that is not there is the failure that matters.
    expect(rec.rows[0]?.gatePath).toBe('auto-allow');
  });

  it('stamps the isolation context on every row', async () => {
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: false,
    });
    await tool.execute(call('echo hi'));
    expect(rec.rows[0]?.sandbox?.backend).toBe('bwrap');
    expect(rec.rows[0]?.sandbox?.writableRoots).toEqual(['/work']);
    expect(rec.rows[0]?.sandbox?.escalated).toBe(false);
  });

  it('never claims an escape: every row records escalated=false', async () => {
    // There is no escalation flow, so nothing runs outside the profile the
    // status reports and no row may say otherwise. `escalated-out-of-sandbox`
    // is reserved vocabulary, not a produced value.
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: false,
    });
    await tool.execute(call('echo one'));
    await tool.execute(call('echo two'));
    expect(rec.rows.map((row) => row.sandbox?.escalated)).toEqual([false, false]);
    expect(rec.rows.map((row) => row.gatePath)).not.toContain(
      'escalated-out-of-sandbox',
    );
  });

  it('records a real user denial on the path that asked', async () => {
    const { tool, rec } = build({
      approved: false,
      confirmationRequested: true,
    });
    await tool.execute(call('npm publish --access public'));
    expect(rec.rows[0]?.decision).toBe('asked-denied');
    expect(rec.rows[0]?.outcome).toBe('denied');
    // The typed-safe-word path IS what produced the decision, so the gate path
    // names it; the decision column is what says it was a denial.
    expect(rec.rows[0]?.gatePath).toBe('text-safe-word');
  });

  it('does NOT claim a human denied when block mode refused unprompted', async () => {
    // The mirror of the auto-approve bug, and the one that was still shipping:
    // block mode refuses inside review() WITHOUT asking and reports
    // confirmationRequested=false. Hardcoding `asked-denied` credited a human
    // with a mechanical refusal.
    const { tool, rec } = build({
      approved: false,
      confirmationRequested: false,
    });
    await tool.execute(call('npm publish --access public'));
    expect(rec.rows[0]?.decision).toBe('blocked');
    expect(rec.rows[0]?.gatePath).toBe('hard-block');
    expect(rec.rows[0]?.decision).not.toBe('asked-denied');
  });

  it('stamps the isolation context on denial rows too', async () => {
    const { tool, rec } = build({
      approved: false,
      confirmationRequested: true,
    });
    await tool.execute(call('npm publish --access public'));
    expect(rec.rows[0]?.sandbox?.backend).toBe('bwrap');
    expect(rec.rows[0]?.sandbox?.writableRoots).toEqual(['/work']);
  });
});
