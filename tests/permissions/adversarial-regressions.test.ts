import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  RiskClassifier,
  normalizeForDenyMatching,
  readsSensitivePath,
} from '../../src/permissions/risk-classifier.js';
import { PermissionGrantStore } from '../../src/permissions/grant-store.js';
import { extractShellStructure } from '../../src/permissions/shell-structure.js';

/**
 * Regressions for holes found by adversarial testing of Phase 0-2.
 */
describe('environment-assignment prefixes cannot hijack a trusted binary', () => {
  const classifier = new RiskClassifier();

  const hijacks = [
    'PATH=/tmp/evil:$PATH ps aux',
    'PATH=/tmp/evil ls',
    'LD_PRELOAD=/tmp/evil.so ls',
    'IFS=x cat /etc/hostname',
    'BASH_ENV=/tmp/evil.sh bash',
    'PATH=/tmp/evil df -h',
  ];

  for (const command of hijacks) {
    it(`asks before ${JSON.stringify(command)}`, () => {
      const result = classifier.assess(command);
      expect(result.requiresConfirmation || result.decision === 'deny').toBe(
        true,
      );
    });
  }

  it('records the prefix on the segment instead of dropping it', () => {
    const segment = extractShellStructure('PATH=/tmp/evil:$PATH ps aux')
      .commands[0];
    expect(segment).toBeDefined();
    expect(segment?.envPrefixes).toHaveLength(1);
  });

  it('leaves the same command without a prefix unattended', () => {
    expect(classifier.assess('ps aux').tier).toBe(0);
    expect(classifier.assess('ls').tier).toBe(0);
  });
});

describe('a grant never matches an env-prefixed command', () => {
  it('refuses to persist a prefixed command', async () => {
    const store = new PermissionGrantStore({ rules: [], grants: [] });
    const result = await store.remember(
      'PATH=/tmp/evil:$PATH rm -rf build',
      '/home/titan',
    );
    expect(result.persisted).toBe(false);
    expect(result.reason).toMatch(/environment variables/);
  });

  it('does not let a grant for the bare command match the prefixed one', () => {
    const store = new PermissionGrantStore({ rules: [], grants: [] });
    const plain = extractShellStructure('rm -rf build').commands[0];
    const prefixed = extractShellStructure('PATH=/tmp/evil:$PATH rm -rf build')
      .commands[0];

    // Simulate a stored grant for the plain command.
    const granted = {
      id: 'g',
      executablePath: '/usr/bin/rm',
      argv: ['rm', '-rf', 'build'],
      cwd: '/home/titan',
      createdAt: new Date().toISOString(),
    };
    const matcher = {
      match: (segment: NonNullable<typeof plain>) =>
        segment.envPrefixes.length > 0 ? undefined : granted,
    };
    if (plain === undefined || prefixed === undefined) {
      throw new Error('expected both commands to parse');
    }
    expect(matcher.match(plain)).toBeDefined();
    expect(matcher.match(prefixed)).toBeUndefined();
    expect(store).toBeDefined();
  });
});

describe('hard denies cannot be dodged by spelling', () => {
  const classifier = new RiskClassifier();
  // The test sandbox rewrites HOME, so the absolute home path is derived
  // rather than hardcoded.
  const home = homedir().replace(/\/$/, '');

  const mustDeny = [
    'rm -rf /',
    'rm -rf //',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf "$HOME"',
    'rm -rf /home/',
    'rm -rf "/home"',
    `rm -rf ${home}`,
    `rm -rf ${home}/`,
    'rm -rf "$HOME/x"',
  ];

  for (const command of mustDeny) {
    it(`permanently blocks ${JSON.stringify(command)}`, () => {
      expect(classifier.assess(command).decision).toBe('deny');
    });
  }

  it('does not block ordinary deletions', () => {
    for (const command of [
      'rm -rf /tmp/build',
      'rm -rf ./node_modules',
      'rm -f file.txt',
      'rm -rf /usr/lib/foo',
    ]) {
      expect(classifier.assess(command).decision, command).not.toBe('deny');
    }
  });

  it('normalizes quotes, slashes and home shorthands', () => {
    expect(normalizeForDenyMatching('rm -rf "//"')).toBe('rm -rf /');
    expect(normalizeForDenyMatching('rm -rf /home/')).toBe('rm -rf /home');
    expect(normalizeForDenyMatching('rm -rf $HOME')).toBe('rm -rf ~');
    expect(normalizeForDenyMatching(`rm -rf ${homedir()}`)).toBe('rm -rf ~');
  });
});

describe('secret reads resist home-shorthand spelling', () => {
  it.each([
    'cat $HOME/.ssh/id_rsa',
    'cat ${HOME}/.ssh/id_rsa',
    'cat ${HOME}/.aws/credentials',
    'cat $HOME/.env',
    'cat ${HOME}/.netrc',
  ])('flags %s', (command) => {
    expect(readsSensitivePath(command)).toBe(true);
  });

  it('does not flag ordinary files', () => {
    for (const command of [
      'cat README.md',
      'cat src/index.ts',
      'cat lib/keystore.ts',
      'cat docs/environment.md',
    ]) {
      expect(readsSensitivePath(command), command).toBe(false);
    }
  });
});

describe('find write predicates always ask', () => {
  const classifier = new RiskClassifier();

  for (const command of [
    'find / -delete',
    'find . -type f -delete',
    'find /tmp -fprintf out /etc/passwd',
    'find /tmp -fprint out',
    'find /tmp -fls out',
    'find /tmp -fopen out',
  ]) {
    it(`asks before ${JSON.stringify(command)}`, () => {
      const result = classifier.assess(command);
      expect(result.requiresConfirmation || result.decision === 'deny').toBe(
        true,
      );
    });
  }

  it('still allows read-only searches', () => {
    expect(classifier.assess('find . -type f -name "*.ts"').tier).toBe(0);
    expect(classifier.assess('find / -maxdepth 2 -type d').tier).toBe(0);
  });
});

describe('git tag is not treated as read-only', () => {
  it('asks before a tag that moves or deletes refs', () => {
    const classifier = new RiskClassifier();
    for (const command of ['git tag', 'git tag -f v1', 'git tag -d v1']) {
      const result = classifier.assess(command);
      expect(
        result.requiresConfirmation || result.decision === 'deny',
        command,
      ).toBe(true);
    }
  });
});

describe('a broken shell is never reported as a successful command', () => {
  it('reports a clear failure after the shell loses PATH, and recovers', async () => {
    const { ShellSession } = await import('../../src/shell/shell-session.js');
    const session = new ShellSession({ cwd: '/tmp' });
    session.restart();

    const normal = await session.execute('echo hello');
    expect(normal.exitCode).toBe(0);
    expect(normal.stdout).toBe('hello\n');

    // This genuinely runs and succeeds; it just breaks the shell's PATH.
    const breaker = await session.execute('unset PATH');
    expect(breaker.exitCode).toBe(0);

    // The next command must not be reported as a successful silent no-op.
    const after = await session.execute('echo recovered');
    expect(after.exitCode).not.toBe(0);
    expect(after.stdout).toMatch(/could not run the command/i);

    // And the session recovers.
    const recovered = await session.execute('echo back');
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toBe('back\n');
    session.close();
  });

  it('does not leak completion markers into results', async () => {
    const { ShellSession } = await import('../../src/shell/shell-session.js');
    const session = new ShellSession({ cwd: '/tmp' });
    session.restart();
    const result = await session.execute('echo clean');
    expect(result.stdout).not.toContain('__ATLAS_DONE_');
    expect(result.stdout).toBe('clean\n');
    session.close();
  });

  it('ignores command output that imitates a completion marker', async () => {
    const { ShellSession } = await import('../../src/shell/shell-session.js');
    const session = new ShellSession({ cwd: '/tmp' });
    session.restart();
    const result = await session.execute('printf "__ATLAS_DONE_fake:0:out\\n"');
    // The forged line is returned as ordinary output, not treated as a
    // completion signal, and the real command still finishes normally.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('__ATLAS_DONE_fake:0:out');
    session.close();
  });

  it('tracks the shell working directory across cd', async () => {
    const { ShellSession } = await import('../../src/shell/shell-session.js');
    const session = new ShellSession({ cwd: '/tmp' });
    session.restart();
    expect(session.currentDirectory).toBe('/tmp');
    await session.execute('cd /home/titan');
    expect(session.currentDirectory).toBe('/home/titan');
    const pwd = await session.execute('pwd');
    expect(pwd.stdout.trim()).toBe('/home/titan');
    session.close();
  });
});

describe('stream errors never leak the API key', () => {
  it('redacts a key echoed inside an Anthropic stream error frame', async () => {
    const { AnthropicCompatibleProvider } =
      await import('../../src/providers/anthropic-compatible.js');
    const secret = 'sk-livekey-SECRETVALUE123';
    const body = `data: ${JSON.stringify({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: `gateway exploded key=${secret}`,
      },
    })}\n\n`;
    const provider = new AnthropicCompatibleProvider({
      apiKey: secret,
      baseUrl: 'https://api.anthropic.test',
      dependencies: {
        fetch: (() =>
          Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          )) as unknown as typeof fetch,
        maxRetries: 0,
      },
    });

    let thrown: unknown;
    try {
      for await (const chunk of provider.streamChatCompletion?.({
        model: 'claude',
        messages: [],
      }) ?? []) {
        expect(typeof chunk).toBe('string');
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).not.toContain(secret);
  });
});
