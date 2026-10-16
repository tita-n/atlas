import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeStatus, parseProfile } from '../../src/execution/environment.js';
import type { ExecutionStatus } from '../../src/execution/environment.js';
import { LocalEnvironment, DEGRADED_MODE_NOTICE } from '../../src/execution/local-environment.js';
import { resolveExecutionEnvironment } from '../../src/execution/resolve-environment.js';

const status = (over: Partial<ExecutionStatus> = {}): ExecutionStatus => ({
  backend: 'bwrap',
  profile: 'workspace-write',
  writableRoots: ['/work'],
  networkEnabled: false,
  sandboxed: true,
  seccomp: false,
  ...over,
});

describe('describeStatus', () => {
  it('states backend, profile, writable roots, network and seccomp', () => {
    const line = describeStatus(status());
    expect(line).toContain('sandbox: bwrap');
    expect(line).toContain('profile: workspace-write');
    expect(line).toContain('writable: /work');
    expect(line).toContain('network: off');
    // seccomp is reported even when off: an unmentioned filter reads as an
    // absent one, which is the same thing here but a lie later.
    expect(line).toContain('seccomp: off');
  });

  it('says SANDBOX OFF rather than implying confinement', () => {
    const line = describeStatus(status({ sandboxed: false, backend: 'local' }));
    expect(line).toContain('SANDBOX OFF');
    expect(line).not.toContain('sandbox: local');
  });

  it('carries the degraded REASON on the line itself', () => {
    // The gap the fail-closed matrix found: "SANDBOX OFF" alone leaves the
    // user to guess, and the guess they make is "so it is fine".
    const line = describeStatus(
      status({
        sandboxed: false,
        backend: 'local',
        degradedReason: 'sandbox unavailable: dangerous commands will be refused, not sandboxed.',
      }),
    );
    expect(line).toContain('dangerous commands will be refused, not sandboxed');
  });

  it('says "writable: none" rather than an empty fragment', () => {
    expect(describeStatus(status({ writableRoots: [] }))).toContain('writable: none');
  });
});

describe('LocalEnvironment', () => {
  it('never claims to confine', () => {
    expect(new LocalEnvironment().status.sandboxed).toBe(false);
  });

  it('reports full-access rather than a narrower profile it cannot honour', () => {
    // Claiming workspace-write with no boundary would be a lie the status bar
    // repeats on every turn.
    expect(new LocalEnvironment().status.profile).toBe('full-access');
  });

  it('always carries a degraded reason', () => {
    expect(new LocalEnvironment().status.degradedReason).toBe(
      DEGRADED_MODE_NOTICE,
    );
  });
});

describe('parseProfile', () => {
  it('accepts each legal profile and treats empty as unset', () => {
    expect(parseProfile('read-only')).toBe('read-only');
    expect(parseProfile('workspace-write')).toBe('workspace-write');
    expect(parseProfile('full-access')).toBe('full-access');
    expect(parseProfile('')).toBeUndefined();
    expect(parseProfile(undefined)).toBeUndefined();
  });

  it('refuses a bogus value instead of casting it through', () => {
    // An `as` cast let `ATLAS_SANDBOX_PROFILE=src` reach the audit schema,
    // where it failed mid-turn on the first append - far from the cause.
    expect(() => parseProfile('src')).toThrow(/ATLAS_SANDBOX_PROFILE/);
    expect(() => parseProfile('READ-ONLY')).toThrow(/ATLAS_SANDBOX_PROFILE/);
  });
});

describe('resolveExecutionEnvironment', () => {
  it('full-access is never sandboxed and says why', async () => {
    const env = await resolveExecutionEnvironment({
      cwd: '/work',
      atlasHome: '/fakehome/.atlas',
      profile: 'full-access',
    });
    expect(env.status.sandboxed).toBe(false);
    expect(env.status.degradedReason).toContain('no sandbox');
    // The warning must name the weakness rather than only the state.
    expect(env.status.degradedReason).toContain('bypassable');
  });

  it('forceLocal never pretends to be sandboxed', async () => {
    const env = await resolveExecutionEnvironment({
      cwd: '/work',
      atlasHome: '/fakehome/.atlas',
      forceLocal: true,
    });
    expect(env.status.sandboxed).toBe(false);
    expect(env.status.backend).toBe('local');
  });

  it('DEGRADES VISIBLY when a sandbox cannot be built', async () => {
    // No working bubblewrap is reachable from a temp cwd on this host, so this
    // exercises the catch path: the whole point is that it degrades AND says
    // so, never that it quietly runs on the host.
    const env = await resolveExecutionEnvironment({
      cwd: mkdtempSync(join(tmpdir(), 'atlas-resolve-')),
      atlasHome: '/fakehome/.atlas',
      profile: 'read-only',
    });
    try {
      if (!env.status.sandboxed) {
        expect(env.status.degradedReason).toBeDefined();
        expect(env.describe()).toContain('dangerous commands will be refused');
      }
      // Whether or not this host can sandbox, the status must never claim
      // confinement without a working backend.
      if (env.status.sandboxed) expect(env.status.backend).toBe('bwrap');
    } finally {
      rmSync(join(tmpdir(), 'atlas-resolve-'), { recursive: true, force: true });
    }
  });
});
