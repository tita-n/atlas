import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { protectedTargets } from '../../src/safety/protected-targets.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalize,
  forgetTrust,
  initialProfile,
  isTrusted,
  loadTrust,
  rememberTrust,
  trustEvidencePath,
  trustPath,
} from '../../src/execution/trust.js';
import {
  FULL_ACCESS_PHRASE,
  disableFullAccess,
  enableFullAccess,
  fullAccessEvidencePath,
  fullAccessPath,
  loadFullAccessGrant,
} from '../../src/execution/full-access.js';

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

describe('full-access ceremony', () => {
  it('is OFF by default', async () => {
    const h = home();
    try {
      expect(await loadFullAccessGrant(h)).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('refuses to enable without the exact phrase', async () => {
    const h = home();
    try {
      await expect(enableFullAccess(h, 'yes')).rejects.toThrow(
        /confirmation phrase/,
      );
      // A rejected attempt must not leave a usable record behind.
      expect(await loadFullAccessGrant(h)).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('enables on the exact phrase and records it', async () => {
    const h = home();
    try {
      const rec = await enableFullAccess(h, FULL_ACCESS_PHRASE);
      expect(rec.enabled).toBe(true);
      const loaded = await loadFullAccessGrant(h);
      expect(loaded?.enabledAt).toBe(rec.enabledAt);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('withdraws the grant', async () => {
    const h = home();
    try {
      await enableFullAccess(h, FULL_ACCESS_PHRASE);
      await disableFullAccess(h);
      expect(await loadFullAccessGrant(h)).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('treats a HAND-EDITED record as NOT enabled', async () => {
    const h = home();
    try {
      await enableFullAccess(h, FULL_ACCESS_PHRASE);
      // Forge the JSON without updating the digest: the same accident the
      // ceremony exists to catch.
      writeFileSync(
        fullAccessPath(h),
        JSON.stringify({
          version: 1,
          enabled: true,
          enabledAt: new Date().toISOString(),
        }),
      );
      expect(await loadFullAccessGrant(h)).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('treats a MISSING digest as NOT enabled, even with valid JSON', async () => {
    const h = home();
    try {
      await enableFullAccess(h, FULL_ACCESS_PHRASE);
      rmSync(fullAccessEvidencePath(h));
      expect(await loadFullAccessGrant(h)).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
