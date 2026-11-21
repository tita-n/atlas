import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeStatus, parseProfile } from '../../src/execution/environment.js';
import type { ExecutionStatus } from '../../src/execution/environment.js';
import {
  FULL_ACCESS_NOTICE,
  LocalEnvironment,
} from '../../src/execution/local-environment.js';
import { enableFullAccess } from '../../src/execution/full-access.js';
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

  it('gives the REFUSING state its own words, not full-access', () => {
    // The bug this guards: a machine with no working sandbox reported
    // `full-access | network: on`, which reads as "you chose this" when the
    // truth is "there is no sandbox and Atlas is refusing to run anyway".
    const line = describeStatus(
      status({
        sandboxed: false,
        backend: 'refusing',
        profile: 'read-only',
        writableRoots: [],
        networkEnabled: false,
        degradedReason: 'sandbox unavailable: bubblewrap was not found',
      }),
    );
    expect(line).toContain('SANDBOX UNAVAILABLE');
    expect(line).toContain('refusing');
    expect(line).not.toContain('full-access');
    expect(line).not.toContain('network: on');
  });

  it('carries the degraded REASON on the line itself', () => {
    const line = describeStatus(
      status({
        sandboxed: false,
        backend: 'refusing',
        degradedReason: 'sandbox unavailable: bubblewrap was not found',
      }),
    );
    expect(line).toContain('bubblewrap was not found');
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

  it('always carries the full-access warning, naming the heuristic', () => {
    expect(new LocalEnvironment().status.degradedReason).toBe(FULL_ACCESS_NOTICE);
    // The warning must name the weakness rather than only the state.
    expect(FULL_ACCESS_NOTICE).toContain('no sandbox');
    expect(FULL_ACCESS_NOTICE).toContain('bypassable');
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
  it('REFUSES full-access when the ceremony has not been performed', async () => {
    // An env var or profile flag alone must not unlock a bare host shell.
    const atlasHome = mkdtempSync(join(tmpdir(), 'atlas-nogrant-'));
    try {
      const env = await resolveExecutionEnvironment({
        cwd: '/work',
        atlasHome,
        profile: 'full-access',
      });
      expect(env.status.backend).toBe('refusing');
      expect(env.status.sandboxed).toBe(false);
      expect(env.status.profile).toBe('read-only');
      expect(env.status.networkEnabled).toBe(false);
      expect(env.status.degradedReason).toContain('full access was requested');
    } finally {
      rmSync(atlasHome, { recursive: true, force: true });
    }
  });

  it('honours full-access once the grant exists, and says why it is weak', async () => {
    const atlasHome = mkdtempSync(join(tmpdir(), 'atlas-grant-'));
    try {
      await enableFullAccess(atlasHome, 'I ACCEPT NO SANDBOX');
      const env = await resolveExecutionEnvironment({
        cwd: '/work',
        atlasHome,
        forceLocal: true,
      });
      expect(env.status.backend).toBe('local');
      expect(env.status.sandboxed).toBe(false);
      expect(env.status.degradedReason).toContain('no sandbox');
      expect(env.status.degradedReason).toContain('bypassable');
    } finally {
      rmSync(atlasHome, { recursive: true, force: true });
    }
  });

  it('REFUSES forceLocal when the grant is absent', async () => {
    const atlasHome = mkdtempSync(join(tmpdir(), 'atlas-nogrant2-'));
    try {
      const env = await resolveExecutionEnvironment({
        cwd: '/work',
        atlasHome,
        forceLocal: true,
      });
      expect(env.status.backend).toBe('refusing');
    } finally {
      rmSync(atlasHome, { recursive: true, force: true });
    }
  });

  it('DEGRADES VISIBLY when a sandbox cannot be built', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atlas-resolve-'));
    const atlasHome = mkdtempSync(join(tmpdir(), 'atlas-resolve-home-'));
    try {
      const env = await resolveExecutionEnvironment({
        cwd,
        atlasHome,
        profile: 'read-only',
        // An injected path that is not executable forces the failure path on a
        // host that DOES have bubblewrap, which is the interesting case.
        bwrapPath: '/nonexistent/bwrap',
      });
      expect(env.status.sandboxed).toBe(false);
      expect(env.status.backend).toBe('refusing');
      expect(env.status.degradedReason).toBeDefined();
      expect(env.describe()).toContain('refusing');
      // Never the fail-open label.
      expect(env.describe()).not.toContain('full-access');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(atlasHome, { recursive: true, force: true });
    }
  });
});
