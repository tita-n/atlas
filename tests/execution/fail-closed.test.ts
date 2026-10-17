/**
 * The fail-closed guarantee.
 *
 * The bug these tests exist for: when bubblewrap was unusable, Atlas fell back
 * to a plain host shell, labelled itself `full-access | network: on`, and really
 * wrote to the real filesystem. These tests drive the replacement state and the
 * predicate that guards it, and they assert on FILESYSTEM EFFECT, not on banner
 * text - a refusal that still ran the command is the thing being ruled out.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { positivelyReadOnly } from '../../src/execution/read-only-clear.js';
import {
  REFUSED_EXIT_CODE,
  RefusingEnvironment,
} from '../../src/execution/refusing-environment.js';
import { interpretIsolation } from '../../src/execution/bwrap/bwrap-environment.js';

const CWD = mkdtempSync(join(tmpdir(), 'atlas-refuse-'));

describe('positivelyReadOnly', () => {
  it('clears read-only diagnostics', () => {
    for (const command of [
      'ls',
      'ls -la',
      'cat /etc/hostname',
      'id',
      'pwd',
      'echo hello',
      'ps aux',
      'df -h',
      'grep -n root /etc/passwd',
    ]) {
      expect(
        positivelyReadOnly(command, CWD).cleared,
        `expected "${command}" to be cleared`,
      ).toBe(true);
    }
  });

  it('refuses anything that can write, install, or read a secret', () => {
    const dangerous = [
      // A write redirect is the single most common shape of "harmless command,
      // destructive spelling".
      'echo x > sentinel.txt',
      'echo x >> sentinel.txt',
      'rm -rf /home',
      'truncate -s 0 sentinel.txt',
      'find / -delete',
      'cp /tmp/evil.json /home/titan/.atlas/config.json',
      'curl https://example.com',
      'git commit -m x',
      'dnf install -y curl',
      'chmod 777 sentinel.txt',
      // A secret read is not read-only-and-harmless even though `cat` is.
      'cat /home/titan/.ssh/id_rsa',
      // An unknown binary must not be cleared by default.
      'frobnicate --now',
      // Base64-piped payload: the text hides the write, and the classifier put
      // it above tier 0.
      'echo cm0gLXJmIC8K | base64 -d | bash',
    ];
    for (const command of dangerous) {
      expect(
        positivelyReadOnly(command, CWD).cleared,
        `expected "${command}" to be refused`,
      ).toBe(false);
    }
  });
});

describe('RefusingEnvironment', () => {
  const environment = new RefusingEnvironment({
    cwd: CWD,
    reason: 'sandbox unavailable: bubblewrap was not found',
  });

  it('reports a distinct state, never full-access', () => {
    expect(environment.status.backend).toBe('refusing');
    expect(environment.status.sandboxed).toBe(false);
    expect(environment.status.profile).toBe('read-only');
    expect(environment.status.networkEnabled).toBe(false);
    expect(environment.status.writableRoots).toEqual([]);
  });

  it('describes itself without the fail-open labels', () => {
    const line = environment.describe();
    expect(line).toContain('refusing');
    expect(line).not.toContain('full-access');
    expect(line).not.toContain('network: on');
  });

  it('refuses a write and leaves NO side effect on the host', async () => {
    const session = environment.createSession();
    const sentinel = join(CWD, `refused-${String(Date.now())}.txt`);
    const result = await session.execute(`echo x > ${sentinel}`);
    expect(result.exitCode).toBe(REFUSED_EXIT_CODE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no sandbox is available');
    // The whole point: the command did not run.
    expect(existsSync(sentinel)).toBe(false);
    session.close();
  });

  it('refuses a delete and leaves the file intact', async () => {
    const session = environment.createSession();
    const victim = join(CWD, `victim-${String(Date.now())}.txt`);
    writeFileSync(victim, 'still here\n');
    const result = await session.execute(`rm -f ${victim}`);
    expect(result.exitCode).toBe(REFUSED_EXIT_CODE);
    expect(existsSync(victim)).toBe(true);
    session.close();
  });

  it('still runs a cleared read-only command', async () => {
    const session = environment.createSession();
    const result = await session.execute('ls');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    session.close();
  });
});

describe('interpretIsolation', () => {
  const good = [
    'NNP=1',
    'CAPEFF=0000000000000000',
    'ROOTRW=0',
    'CHECK_DONE',
  ].join('\n');

  it('passes when every property holds', () => {
    const report = interpretIsolation(good, ['/home/x/.ssh']);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it('FAILS when the check did not finish, instead of assuming it passed', () => {
    // "We learned nothing" must not read as "isolated".
    const report = interpretIsolation('NNP=1\nCAPEFF=0000', ['/home/x/.ssh']);
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('did not finish');
  });

  it('fails on a weakened argv: NoNewPrivs missing', () => {
    const report = interpretIsolation(
      good.replace('NNP=1', 'NNP=0'),
      ['/home/x/.ssh'],
    );
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('no-new-privs');
  });

  it('fails when a capability survived', () => {
    const report = interpretIsolation(
      good.replace('CAPEFF=0000000000000000', 'CAPEFF=0000000000000001'),
      ['/home/x/.ssh'],
    );
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('capabilities-dropped');
  });

  it('fails when the sandbox root is writable', () => {
    const report = interpretIsolation(good.replace('ROOTRW=0', 'ROOTRW=1'), [
      '/home/x/.ssh',
    ]);
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('root-read-only');
  });

  it('fails when an expected mask is readable', () => {
    const report = interpretIsolation(
      ['NNP=1', 'CAPEFF=0000000000000000', 'ROOTRW=0', 'MASKLEAK=/home/x/.ssh', 'CHECK_DONE'].join(
        '\n',
      ),
      ['/home/x/.ssh'],
    );
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('/home/x/.ssh');
  });
});

process.on('exit', () => {
  rmSync(CWD, { recursive: true, force: true });
});
