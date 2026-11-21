import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertHomeAllowlist,
  auditHomeExposure,
  buildBwrapCommand,
  sandboxEnv,
  SANDBOXED_SHELL,
} from '../../src/execution/bwrap/mount-policy.js';
import { contains } from '../../src/safety/protected-targets.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * The running Atlas package root - the developer case, not a fixture.
 *
 * `resolve` because fileURLToPath leaves a trailing slash, and '/a/b/' never
 * equals '/a/b' in an argv array.
 */
const ATLAS_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
import type { MountPolicy } from '../../src/execution/bwrap/mount-policy.js';
import { resolveBwrapPath, probeBwrap } from '../../src/execution/bwrap/resolve-bwrap.js';

function policy(over: Partial<MountPolicy> = {}): MountPolicy {
  return {
    profile: 'workspace-write',
    cwd: '/work',
    writableRoots: ['/work'],
    networkEnabled: false,
    atlasHome: '/fakehome/.atlas',
    alwaysHidden: [],
    ...over,
  };
}

/** Builds an argv array and returns the flag/value sequence for assertions. */
function args(p: MountPolicy, cmd: readonly string[] = ['/bin/true']): string[] {
  return buildBwrapCommand(p, '/usr/bin/bwrap', cmd).argv.slice(1);
}

/** True when `flag` appears in argv. */
function has(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

describe('buildBwrapCommand', () => {
  it('starts from an empty root rather than masking the host root', () => {
    const argv = args(policy());
    // `--tmpfs /` means nothing exists unless bound. Codex's shape, and the
    // reason deny lists are not needed for the host's /tmp, /run/user and
    // container sockets.
    expect(argv[argv.indexOf('--tmpfs') + 1]).toBe('/');
    // System roots are bound read-only, but the host's ROOT is never bound in
    // wholesale - that is what makes an allow list possible at all. ('/' here
    // is the tmpfs DESTINATION, so the assertion is about bind pairs.)
    for (const flag of ['--ro-bind', '--bind', '--symlink']) {
      expect(
        argv.some((a, i) => a === flag && argv[i + 1] === '/'),
        `${flag} must never bind the host root`,
      ).toBe(false);
    }
  });

  it('refuses a cwd of / instead of binding the host root back in', () => {
    // `--tmpfs /` followed by `--bind / /` is not a sandbox. It also made the
    // protected-subpath pass a no-op, because `${'/'}/` is `//`. Fail closed.
    expect(() => args(policy({ cwd: '/', writableRoots: [] }))).toThrow(
      /cwd=\//,
    );
  });

  it('refuses a writable root of / rather than the host root read-write', () => {
    expect(() => args(policy({ cwd: '/work', writableRoots: ['/'] }))).toThrow(
      /writable root of \//,
    );
  });

  it('masks Atlas state so the API key is not readable inside the sandbox', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-mask-'));
    const atlasHome = join(home, '.atlas');
    mkdirSync(atlasHome);
    writeFileSync(join(atlasHome, 'config.json'), '{"apiKey":"secret"}');
    try {
      const argv = args(policy({ cwd: home, writableRoots: [], atlasHome }));
      const at = argv.indexOf(atlasHome);
      expect(at).toBeGreaterThan(0);
      // A real tmpfs mask - `--perms 000` before it, `--remount-ro` after -
      // not the read-only bind a protected subpath emits, which is
      // tamper-proof but still readable.
      expect(argv[at - 1]).toBe('--tmpfs');
      expect(argv[at - 2]).toBe('000');
      expect(argv[at + 1]).toBe('--remount-ro');
      expect(
        argv.some((a, i) => a === '--ro-bind' && argv[i + 1] === atlasHome),
      ).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('drops every namespace and isolation flag on the host', () => {
    const argv = args(policy());
    for (const flag of [
      '--new-session',
      '--die-with-parent',
      '--unshare-user',
      '--disable-userns',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
    ]) {
      expect(has(argv, flag)).toBe(true);
    }
  });

  it('unshares the network by default and shares it only when asked', () => {
    expect(has(args(policy()), '--unshare-net')).toBe(true);
    expect(has(args(policy({ networkEnabled: true })), '--unshare-net')).toBe(false);
  });

  it('gives /home as a read-only tmpfs, not a writable directory', () => {
    const argv = args(policy());
    // A writable /home lets `echo x > ~/f` "succeed" into an ephemeral tmpfs:
    // the host is untouched but the command reports success and the file
    // vanishes. Read-only /home means only a bound root can be written.
    expect(argv).toContain('--tmpfs');
    // Appears twice: created as a tmpfs, then remounted read-only.
    expect(argv.filter((a) => a === '/home')).toHaveLength(2);
    expect(argv).toContain('--remount-ro');
  });

  it('makes the workspace writable only under workspace-write', () => {
    // A real temp dir, so the bind is emitted rather than skipped as absent.
    const root = mkdtempSync(join(tmpdir(), 'atlas-ws-'));
    try {
      expect(args(policy({ cwd: root, writableRoots: [root] }))).toContain(
        '--bind',
      );
      // read-only must not smuggle a writable root in through the back door.
      const readOnly = args(
        policy({ profile: 'read-only', cwd: root, writableRoots: [] }),
      );
      expect(readOnly).not.toContain('--bind');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops all capabilities last, immediately before the command', () => {
    const argv = args(policy());
    const capDrop = argv.indexOf('--cap-drop');
    expect(capDrop).toBeGreaterThan(-1);
    expect(argv[capDrop + 1]).toBe('ALL');
    expect(argv[capDrop + 2]).toBe('--');
  });

  it('passes the command as argv, never through a host shell', () => {
    const argv = args(policy(), ['/bin/bash', '-c', 'echo "hi"']);
    expect(argv.slice(-3)).toEqual(['/bin/bash', '-c', 'echo "hi"']);
    // The payload is one argv element; no quoting or splitting happened.
    expect(argv.filter((a) => a === 'echo "hi"')).toHaveLength(1);
  });

  it('re-applies protected paths read-only INSIDE a writable root', () => {
    // The developer case the policy exists for: the workspace IS Atlas's own
    // repo, so workspace-write would otherwise make the compiled safety rules
    // and the git hooks writable.
    const root = ATLAS_ROOT;
    const argv = args(
      policy({ cwd: root, writableRoots: [root], atlasHome: join(root, '.atlas-fixture') }),
    );
    const writableAt = argv.indexOf(root, argv.indexOf('--bind'));
    expect(writableAt).toBeGreaterThan(-1);
    expect(argv[writableAt - 1]).toBe('--bind');

    for (const rel of ['dist', 'src/permissions', join('.git', 'hooks')]) {
      const target = join(root, rel);
      const at = argv.indexOf(target, writableAt);
      expect(at, `${rel} must be re-bound`).toBeGreaterThan(writableAt);
      // Re-bound READ-ONLY, after the writable bind: a later writable mount
      // would undo the protection it is restoring.
      expect(argv[at - 1]).toBe('--ro-bind');
    }
  });

  it('does not re-bind the workspace root itself read-only', () => {
    // Binding the install root read-only would make the WHOLE workspace
    // unwritable, including the parts the user trusted. The individual
    // src/permissions and dist entries are what must be pinned.
    const root = ATLAS_ROOT;
    const argv = args(
      policy({ cwd: root, writableRoots: [root], atlasHome: join(root, '.atlas-fixture') }),
    );
    // The final `--chdir` also names the root, so scan for the writable bind
    // specifically rather than the last occurrence of the path.
    const at = argv.indexOf(root, argv.indexOf('--bind'));
    expect(argv[at - 1]).toBe('--bind');
  });

  it('clears the environment and sets back only allow-listed names', () => {
    const argv = args(policy());
    expect(argv).toContain('--clearenv');
    const set = argv.filter((_, i) => argv[i - 1] === '--setenv');
    for (const name of set) {
      expect([
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER',
        'LOGNAME', 'SHELL', 'COLORTERM', 'NO_COLOR', 'CI', 'NVM_BIN',
        'NODE_VERSION', 'npm_config_cache', 'npm_config_registry',
        'SSL_CERT_FILE', 'SSL_CERT_DIR',
      ]).toContain(name);
    }
  });

  it('sets a PATH that cannot be influenced from the workspace', () => {
    const argv = args(policy());
    const i = argv.indexOf('--setenv');
    const pathIndex = argv.indexOf('PATH', i);
    expect(argv[pathIndex + 1]).toBe(
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
  });
});

describe('sandboxEnv', () => {
  it('drops anything that looks like a credential', () => {
    const env = sandboxEnv({
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'x',
      OPENAI_API_KEY: 'x',
      GITHUB_TOKEN: 'x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      MY_SECRET: 'x',
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    // PATH is replaced outright, not passed through: a PATH the caller chose
    // is a PATH the workspace chose.
    expect(env.PATH).toBe(
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
  });

  it('never returns a PATH the caller supplied', () => {
    expect(sandboxEnv({ PATH: '/work/evil' }).PATH).not.toContain('/work');
  });
});

describe('resolveBwrapPath', () => {
  it('never consults PATH and only accepts fixed absolute locations', () => {
    // `exists` is the only seam; nothing about it can express a PATH search.
    const seen: string[] = [];
    const r = resolveBwrapPath((p) => {
      seen.push(p);
      return false;
    });
    expect(r.ok).toBe(false);
    for (const p of seen) expect(p.startsWith('/')).toBe(true);
    expect(r.reason).toContain('bubblewrap');
  });

  it('returns the first candidate that exists', () => {
    const r = resolveBwrapPath((p) => p === '/bin/bwrap');
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/bin/bwrap');
  });
});

describe('probeBwrap', () => {
  it('accepts a working bubblewrap', async () => {
    const r = await probeBwrap('/usr/bin/bwrap', () =>
      Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when namespaces are unavailable and surfaces WHY', async () => {
    const r = await probeBwrap('/usr/bin/bwrap', () =>
      Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'bwrap: No permissions to creating new namespace.',
      }),
    );
    expect(r.ok).toBe(false);
    // The user has to be able to act on this, so the kernel's words survive.
    expect(r.reason).toContain('No permissions to creating new namespace');
  });

  it('probes namespaces rather than merely checking the file exists', async () => {
    let argv: readonly string[] = [];
    await probeBwrap('/usr/bin/bwrap', (a) => {
      argv = a;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    expect(argv).toContain('--unshare-user');
    expect(argv).toContain('--unshare-pid');
    expect(argv).toContain('--cap-drop');
  });
});

describe('SANDBOXED_SHELL', () => {
  it('does not load the user profile, which could reintroduce a writable path', () => {
    expect(SANDBOXED_SHELL).toContain('--noprofile');
    expect(SANDBOXED_SHELL).toContain('--norc');
  });
});

describe('hidden paths', () => {
  it('records what it masked so the status line can report it', () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-hp-'));
    try {
      writeFileSync(join(root, 'f'), 'x');
      symlinkSync('/etc', join(root, 'link'));
      const built = buildBwrapCommand(policy({ cwd: root }), '/usr/bin/bwrap', [
        '/bin/true',
      ]);
      expect(Array.isArray(built.hiddenPaths)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('home exposure allow list', () => {
  /** Point the policy's home at a disposable fixture and restore afterwards. */
  function withHome<T>(home: string, run: () => T): T {
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  }

  it('exposes nothing under $HOME except the trusted workspace and its pins', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-hex-'));
    const cwd = join(home, 'proj');
    const atlasHome = join(home, '.atlas');
    mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true });
    mkdirSync(atlasHome, { recursive: true });
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(cwd, '.git', 'config'), '[core]\n');
    writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), 'x');
    writeFileSync(join(atlasHome, 'config.json'), '{"apiKey":"secret"}');
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret');
    try {
      withHome(home, () => {
        const built = buildBwrapCommand(
          policy({ cwd, writableRoots: [cwd], atlasHome }),
          '/usr/bin/bwrap',
          ['/bin/true'],
        );
        const audit = auditHomeExposure(cwd, [cwd], built.argv);
        expect(audit.home).toBe(home);
        // The invisible side: the secret dot-dirs the mask pass replaces with
        // an unreadable tmpfs, plus the empty /home tmpfs backing store.
        const maskedPaths = audit.invisible.map((m) => m.path);
        expect(maskedPaths).toContain(join(home, '.ssh'));
        expect(maskedPaths).toContain(atlasHome);
        // The visible side: only the workspace (and pins INSIDE it) may show
        // host content under $HOME.
        expect(audit.exposed.length).toBeGreaterThan(0);
        for (const { mount, trusted } of audit.exposed) {
          expect(
            trusted,
            `untrusted under-home mount in argv: ${JSON.stringify(mount)}`,
          ).toBe(true);
        }
        for (const { mount } of audit.exposed) {
          expect(
            contains(cwd, mount.path) || contains(cwd, mount.source ?? ''),
            `under-home mount outside the workspace: ${JSON.stringify(mount)}`,
          ).toBe(true);
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an unapproved bind under $HOME at argv-build time', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-hex2-'));
    mkdirSync(join(home, '.aws'), { recursive: true });
    try {
      // The home the policy masks against is the runner's HOME, which inside
      // the test is the disposable fixture, so the fixture's .aws really is
      // "under the home directory" for this call.
      withHome(home, () => {
        expect(() => {
          assertHomeAllowlist(
            '/work',
            ['/work'],
            ['--ro-bind', join(home, '.aws'), join(home, '.aws')],
          );
        }).toThrow(/unapproved (mount|source) under the home directory/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a mount FROM an under-home secret out to a trusted path is refused', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-hex3-'));
    mkdirSync(join(home, '.gnupg'), { recursive: true });
    try {
      withHome(home, () => {
        expect(() => {
          assertHomeAllowlist('/work', ['/work'], [
            '--ro-bind',
            join(home, '.gnupg'),
            '/work/gnupg-mirror',
          ]);
        }).toThrow(/unapproved source under the home directory/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('masks the standard secret directories relative to the sandbox HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-hex4-'));
    for (const dir of ['.ssh', '.aws', '.mozilla']) mkdirSync(join(home, dir));
    try {
      withHome(home, () => {
        const argv = args(policy());
        for (const dir of ['.ssh', '.aws', '.mozilla']) {
          const index = argv.indexOf(join(home, dir));
          expect(index, `mask expected for ${dir}`).toBeGreaterThan(-1);
          // argv shape: --perms 000 --tmpfs PATH --remount-ro PATH
          expect(argv[index - 3]).toBe('--perms');
          expect(argv[index - 2]).toBe('000');
          expect(argv[index - 1]).toBe('--tmpfs');
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
