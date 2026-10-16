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

  it('clears the escalated flag between commands', async () => {
    // A grant that ran ONE command outside the sandbox must not make the
    // NEXT row claim the same.
    const { tool, rec } = build({
      approved: true,
      confirmationRequested: false,
    });
    tool.setEscalated(true);
    await tool.execute(call('echo one'));
    tool.setEscalated(false);
    await tool.execute(call('echo two'));
    expect(rec.rows[0]?.gatePath).toBe('escalated-out-of-sandbox');
    expect(rec.rows[1]?.gatePath).toBe('auto-allow-sandboxed');
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
