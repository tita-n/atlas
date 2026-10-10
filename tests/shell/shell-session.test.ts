import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellSession } from '../../src/shell/shell-session.js';

const sessions: ShellSession[] = [];
const directories: string[] = [];

function createSession(timeoutMs = 5_000): ShellSession {
  const session = new ShellSession({ timeoutMs });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ShellSession', () => {
  it('preserves cwd and exported environment across commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-shell-'));
    directories.push(directory);
    const session = createSession();

    await session.execute(`cd ${JSON.stringify(directory)}`);
    const exportResult = await session.execute(
      'export ATLAS_SHELL_TEST=persisted',
    );
    const readResult = await session.execute(
      'printf "%s:%s" "$PWD" "$ATLAS_SHELL_TEST"',
    );

    expect(exportResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toBe(`${directory}:persisted`);
  });

  it('captures stdout and stderr separately', async () => {
    const session = createSession();
    const result = await session.execute('printf out; printf err >&2');

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.exitCode).toBe(0);
  });

  it('kills timed-out commands and restarts a usable shell', async () => {
    const session = createSession(100);
    const timedOut = await session.execute('sleep 5');
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).toBe(124);

    const recovered = await session.execute('printf recovered');
    expect(recovered.stdout).toBe('recovered');
    expect(recovered.timedOut).toBe(false);
  });
});
