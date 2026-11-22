import { describe, expect, it, vi } from 'vitest';

import type { CommandResult } from '../../src/shell/command-result.js';
import {
  VerifiedBwrapSession,
  type IsolationReport,
} from '../../src/execution/bwrap/bwrap-environment.js';
import type { ExecutionSession } from '../../src/execution/environment.js';

const report = (ok: boolean): IsolationReport => ({
  ok,
  detail: ok ? 'isolation verified' : 'isolation mismatch',
  checks: [],
});

function fakeSession(cwd: string): ExecutionSession {
  let running = false;
  return {
    currentDirectory: cwd,
    get running() {
      return running;
    },
    execute(): Promise<CommandResult> {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    restart() {
      running = true;
    },
    close() {
      running = false;
    },
  };
}

describe('VerifiedBwrapSession', () => {
  it('verifies isolation before the initial start and every restart', async () => {
    const verify = vi.fn(() => Promise.resolve(report(true)));
    const create = vi.fn((cwd: string) => Promise.resolve(fakeSession(cwd)));
    const session = new VerifiedBwrapSession(create, verify, '/work');

    session.restart();
    await session.execute('true');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);

    session.restart();
    await session.execute('true');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refuses to start a shell when the isolation check mismatches', async () => {
    const verify = vi.fn(() => Promise.resolve(report(false)));
    const create = vi.fn((cwd: string) => Promise.resolve(fakeSession(cwd)));
    const session = new VerifiedBwrapSession(create, verify, '/work');

    session.restart();
    await expect(session.execute('touch sentinel')).rejects.toThrow(
      /isolation could not be confirmed/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(session.running).toBe(false);
  });
});
