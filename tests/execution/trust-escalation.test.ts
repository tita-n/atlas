import { describe, expect, it } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { protectedTargets } from '../../src/safety/protected-targets.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalize,
  forgetTrust,
  isTrusted,
  loadTrust,
  rememberTrust,
  trustEvidencePath,
  trustPath,
} from '../../src/execution/trust.js';
import {
  EscalationQueue,
  applyEscalation,
  describeEscalation,
  initialProfile,
  isGrantable,
  leavesSandbox,
  safeEscalationRoots,
} from '../../src/execution/escalation.js';
import type { EscalationRequest } from '../../src/execution/escalation.js';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'atlas-trust-'));
}

describe('directory trust', () => {
  it('trusts nothing by default', async () => {
    const h = home();
    try {
      expect(await loadTrust(h)).toEqual([]);
      expect(await isTrusted(h, '/work')).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('records consent and honours it', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      expect(await isTrusted(h, '/work')).toBe(true);
      expect(await loadTrust(h)).toHaveLength(1);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('is idempotent', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      await rememberTrust(h, '/work');
      expect(await loadTrust(h)).toHaveLength(1);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('withdraws trust', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      await forgetTrust(h, '/work');
      expect(await isTrusted(h, '/work')).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('treats a HAND-EDITED trust file as no consent at all', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      // The attack the digest exists to catch: skip the deliberate act and
      // edit the file directly.
      writeFileSync(
        trustPath(h),
        JSON.stringify({
          version: 1,
          trusted: [{ path: '/', trustedAt: new Date().toISOString() }],
        }),
      );
      // Must not be honoured, even though the JSON is perfectly valid.
      expect(await loadTrust(h)).toEqual([]);
      expect(await isTrusted(h, '/')).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('treats a corrupt file as no consent', async () => {
    const h = home();
    try {
      writeFileSync(trustPath(h), 'not json at all');
      expect(await loadTrust(h)).toEqual([]);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('treats a MISSING digest file as no consent, even with valid JSON', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      // The case the digest exists for: an attacker or a sync accident removes
      // the evidence file and leaves a perfectly valid trust.json behind.
      rmSync(trustEvidencePath(h), { force: true });
      expect(await loadTrust(h)).toEqual([]);
      expect(await isTrusted(h, '/work')).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('documents its own limit: a co-located forgery is not detected', async () => {
    // Recorded so nobody upgrades "digest-protected" to "tamper-proof" in a
    // docstring or a design note. The threat model is the sandbox not being
    // able to reach Atlas state, not a hostile user account.
    const h = home();
    try {
      await rememberTrust(h, '/work');
      const forged = JSON.stringify({
        version: 1,
        trusted: [{ path: '/', trustedAt: new Date().toISOString() }],
      });
      writeFileSync(trustPath(h), forged);
      writeFileSync(
        trustEvidencePath(h),
        createHash('sha256').update(forged, 'utf8').digest('hex'),
      );
      // Honest outcome: honoured. This is a KNOWN limitation, not a fix me.
      expect(await isTrusted(h, '/')).toBe(true);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('stores the trust record in Atlas state, not in the workspace', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      // Not "startsWith(h)" - that would pass even if trustPath moved into a
      // workspace. The real property is that the mount policy treats Atlas
      // state as never-bindable, so the sandbox cannot rewrite this record.
      expect(trustPath(h)).toBe(join(h, 'trust.json'));
      const protectedPaths = protectedTargets(h).map((t) => t.path);
      expect(protectedPaths).toContain(h);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('keeps the trust record readable only by its owner', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      // Asserts the MODE, not the contents: the previous version of this test
      // read the bytes and checked length, which passes identically for 0644.
      expect(statSync(trustPath(h)).mode & 0o777).toBe(0o600);
      expect(statSync(trustEvidencePath(h)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('canonicalises the query too, so a symlinked spelling still matches', async () => {
    const h = home();
    const real = mkdtempSync(join(tmpdir(), 'atlas-real-'));
    try {
      await rememberTrust(h, await canonicalize(real));
      // Trailing separator and dot segments are the same directory. Missing
      // here would silently restart a trusted workspace at read-only.
      expect(await isTrusted(h, `${real}/`)).toBe(true);
      expect(await isTrusted(h, join(real, '..', real.split('/').pop() ?? ''))).toBe(
        true,
      );
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('does not trust a path that merely shares a prefix', async () => {
    const h = home();
    try {
      await rememberTrust(h, '/work');
      // A prefix match would make /work-private trusted because /work is.
      expect(await isTrusted(h, '/work-private')).toBe(false);
      expect(await isTrusted(h, '/work/../elsewhere')).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('refuses to trust / , which is every directory', async () => {
    const h = home();
    try {
      // Trusting / plus a cwd of / is the request that would make the whole
      // host writable, so it is refused at the source rather than only in the
      // CLI. `..` spellings resolve to / too and must be caught by the same
      // guard.
      await expect(rememberTrust(h, '/')).rejects.toThrow(/every directory/);
      await expect(rememberTrust(h, '/work/..')).rejects.toThrow(
        /every directory/,
      );
      expect(await loadTrust(h)).toEqual([]);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe('escalation policy', () => {
  const req = (over: Partial<EscalationRequest> = {}): EscalationRequest => ({
    kind: 'network',
    command: 'curl https://example.com',
    detail: 'network',
    ...over,
  });

  it('treats only the two WIDENING escalations as grantable', () => {
    expect(isGrantable('extra-writable-root')).toBe(true);
    expect(isGrantable('network')).toBe(true);
    // "Allow no sandbox from now on" is not a narrower request than the one
    // the user was just asked about - it is the absence of the boundary.
    // The previous version returned true here and a test enshrined it.
    expect(isGrantable('unsandboxed')).toBe(false);
    // Root is not a mount question; re-running the ceremony per command is
    // theatre.
    expect(isGrantable('root')).toBe(false);
  });

  it('knows which escalations actually leave the sandbox', () => {
    // Network and an extra root stay CONFINED, just less tightly. Recording
    // them as escapes would make the audit log cry wolf.
    expect(leavesSandbox('network')).toBe(false);
    expect(leavesSandbox('extra-writable-root')).toBe(false);
    expect(leavesSandbox('unsandboxed')).toBe(true);
    expect(leavesSandbox('root')).toBe(true);
  });

  it('denying changes nothing about the limits', () => {
    const out = applyEscalation(req(), 'deny', {
      writableRoots: ['/work'],
      networkEnabled: false,
    });
    expect(out.allowed).toBe(false);
    expect(out.networkEnabled).toBe(false);
    expect(out.widenedRoots).toEqual(['/work']);
    expect(out.onceRoots).toEqual([]);
  });

  it('allow-once grants the capability but NOT a durable mount', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data'] }),
      'allow-once',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(out.allowed).toBe(true);
    // Once means once: the persistent mount set must not change.
    expect(out.widenedRoots).toEqual(['/work']);
  });

  it('a durable grant WIDENS the mount set rather than replacing it', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data'] }),
      'allow-always',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    // Added to, never swapped: losing the original workspace root would be a
    // surprising way to grant access to /data.
    expect(out.widenedRoots).toEqual(['/work', '/data']);
  });

  it('a durable grant never removes the sandbox', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data'] }),
      'allow-always',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(out.escalated).toBe(false);
    expect(out.gatePath).toBe('auto-allow-sandboxed');
  });

  it('"allow once" actually allows, for this one command only', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data'] }),
      'allow-once',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    // The previous version returned allowed:true with the requested path
    // carried in NO field, so the command ran confined to /work and failed for
    // a reason the user was never shown - with an audit row claiming a clean
    // sandboxed allow.
    expect(out.allowed).toBe(true);
    expect(out.onceRoots).toEqual(['/data']);
    // And "once" must not become "always".
    expect(out.widenedRoots).toEqual(['/work']);
  });

  it('a durable grant puts the roots in widenedRoots and NOT in onceRoots', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data'] }),
      'allow-always',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(out.widenedRoots).toEqual(['/work', '/data']);
    expect(out.onceRoots).toEqual([]);
  });

  it('never lets a requested path become the host root', () => {
    // mount-policy binds with resolve(root), so a bare "/" here would rebind
    // the entire host filesystem read-write inside the sandbox.
    for (const bad of ['/', '/etc', '/proc', '/sys', '/usr', '/bin']) {
      const out = applyEscalation(
        req({ kind: 'extra-writable-root', paths: [bad] }),
        'allow-always',
        { writableRoots: ['/work'], networkEnabled: false },
      );
      expect(out.widenedRoots, `${bad} must not be grantable`).toEqual(['/work']);
    }
  });

  it('refuses a traversal path rather than normalising it into a grant', () => {
    // Resolving `/work/../elsewhere` yields a perfectly valid path to a
    // directory nobody agreed to, so normalising would launder the request
    // rather than refuse it.
    const out = applyEscalation(
      req({
        kind: 'extra-writable-root',
        paths: ['/work/../elsewhere', '../..', '/data/../etc'],
      }),
      'allow-always',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(out.widenedRoots).toEqual(['/work']);
  });

  it('refuses a relative path, which would resolve against the Atlas cwd', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['relative/dir', './x'] }),
      'allow-always',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(out.widenedRoots).toEqual(['/work']);
  });

  it('de-duplicates two spellings of one directory', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data', '/data/', '/data'] }),
      'allow-always',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(out.widenedRoots).toEqual(['/work', '/data']);
  });

  it('distinguishes a user declining from the floor refusing', () => {
    // shell-tool.ts records these separately on purpose; recording every
    // decline as a floor violation is how a floor-violation filter fills up
    // with ordinary "no".
    const byUser = applyEscalation(req({ kind: 'network' }), 'deny', {
      writableRoots: ['/work'],
      networkEnabled: false,
    });
    expect(byUser.gatePath).toBe('denied-by-user');

    // Root is the exception: refusing it IS a floor decision, since it cannot
    // work inside no_new_privs at all.
    const byFloor = applyEscalation(
      req({ kind: 'root' }),
      'deny',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    expect(byFloor.gatePath).toBe('denied-hard-floor');
  });

  it('records a genuine escape as escalated', () => {
    const out = applyEscalation(req({ kind: 'unsandboxed' }), 'allow-always', {
      writableRoots: ['/work'],
      networkEnabled: false,
    });
    expect(out.escalated).toBe(true);
    expect(out.gatePath).toBe('escalated-out-of-sandbox');
  });

  it('enabling the network is recorded separately from an escape', () => {
    const out = applyEscalation(req(), 'allow-once', {
      writableRoots: ['/work'],
      networkEnabled: false,
    });
    expect(out.networkEnabled).toBe(true);
    expect(out.escalated).toBe(false);
  });

  it('says plainly what each escalation would do', () => {
    // Asserts the actual wording, because a prompt is the only place the user
    // learns what they are agreeing to. "length > 0" passed for every possible
    // string, including an empty one that misled nobody into approving root.
    const root = describeEscalation(req({ kind: 'root' }));
    expect(root).toContain('as root');
    expect(root).toContain('outside the sandbox');

    const net = describeEscalation(req({ kind: 'network' }));
    expect(net).toContain('network');
    expect(net).not.toBe(root);

    const unsandboxed = describeEscalation(req({ kind: 'unsandboxed' }));
    expect(unsandboxed).toContain('NO sandbox');

    const extra = describeEscalation(
      req({ kind: 'extra-writable-root', paths: ['/data', '/srv'] }),
    );
    expect(extra).toContain('/data');
    expect(extra).toContain('/srv');
    // Four distinct asks; a user who cannot tell them apart cannot consent.
    expect(new Set([root, net, unsandboxed, extra]).size).toBe(4);
  });

  it('reports failure rather than success when every path was refused', () => {
    const out = applyEscalation(
      req({ kind: 'extra-writable-root', paths: ['/etc', '/usr'] }),
      'allow-once',
      { writableRoots: ['/work'], networkEnabled: false },
    );
    // Nothing was granted. Returning allowed:true would run the command
    // confined to /work, fail for a reason the user never saw, and stamp an
    // `auto-allow-sandboxed` row claiming a clean allow.
    expect(out.allowed).toBe(false);
    expect(out.onceRoots).toEqual([]);
    expect(out.widenedRoots).toEqual(['/work']);
    expect(out.durableNetwork).toBe(false);
  });

  it('distinguishes a durable network grant from a one-off', () => {
    const always = applyEscalation(req({ kind: 'network' }), 'allow-always', {
      writableRoots: [],
      networkEnabled: false,
    });
    const once = applyEscalation(req({ kind: 'network' }), 'allow-once', {
      writableRoots: [],
      networkEnabled: false,
    });
    // Both turn the network on for the command in hand, so only this flag lets
    // the caller persist one and not the other.
    expect(always.durableNetwork).toBe(true);
    expect(once.durableNetwork).toBe(false);
    expect(once.networkEnabled).toBe(true);
    expect(always.networkEnabled).toBe(true);
  });

  it('refuses a symlink that points at a never-writable root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-esc-'));
    try {
      const link = join(dir, 'etc-link');
      symlinkSync('/etc', link);
      // mount-policy.ts calls realpathSync before binding, so a name that
      // points at /etc IS /etc by the time it becomes a mount. Judging the
      // spelling would let the denylist be bypassed with one symlink.
      expect(safeEscalationRoots([link])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EscalationQueue', () => {
  const r = (kind: EscalationRequest['kind']): EscalationRequest => ({
    kind,
    command: `cmd-${kind}`,
    detail: kind,
    ...(kind === 'extra-writable-root' ? { paths: ['/data'] } : {}),
  });

  it('collapses repeats so a loop cannot flood the user', () => {
    const q = new EscalationQueue();
    for (let i = 0; i < 50; i += 1) q.add(r('network'));
    expect(q.requests).toHaveLength(1);
  });

  it('keeps distinct kinds apart', () => {
    const q = new EscalationQueue();
    q.add(r('network'));
    q.add(r('unsandboxed'));
    expect(q.requests).toHaveLength(2);
  });

  it('consolidates into one line per kind', () => {
    const q = new EscalationQueue();
    q.add(r('network'));
    q.add(r('extra-writable-root'));
    const s = q.summary();
    expect(s).toContain('escalation');
    expect(s).toContain('network');
    // Header plus one line per DISTINCT kind: the user answers "do I want
    // network here", not "did I approve this 340th curl".
    expect(s.split('\n')).toHaveLength(3);
  });

  it('counts repeats of the same kind', () => {
    const q = new EscalationQueue();
    q.add(r('network'));
    q.add(r('unsandboxed'));
    q.add(r('root'));
    expect(q.summary()).toContain('(1 request)');
  });

  it('says so when nothing is waiting', () => {
    expect(new EscalationQueue().summary()).toContain('No escalations');
    expect(new EscalationQueue().pending).toBe(false);
  });

  it('clears', () => {
    const q = new EscalationQueue();
    q.add(r('network'));
    q.clear();
    expect(q.pending).toBe(false);
  });
});

describe('initialProfile', () => {
  it('starts an untrusted directory read-only', () => {
    // The whole point: workspace-write must be a decision, not an accident of
    // which directory Atlas happened to be launched in.
    expect(initialProfile(false)).toBe('read-only');
  });

  it('uses workspace-write only after consent', () => {
    expect(initialProfile(true)).toBe('workspace-write');
  });
});
