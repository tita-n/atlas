/**
 * Self-modification workflow tests.
 *
 * The assertions here are about consequences, not about which functions were
 * called: a rejected change must leave nothing applied, a failed health check
 * must roll back, and the protected layer must be refused before any work
 * happens at all.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkProtectedPath,
  checkProtectedPaths,
  isProtectedChange,
  protectedPaths,
} from '../../src/selfmod/protected-paths.js';
import {
  refusalReason,
  validateChange,
  type ChangeSet,
} from '../../src/selfmod/change-set.js';
import {
  evaluateHealth,
  healthSteps,
  recoveryFor,
} from '../../src/selfmod/health.js';
import {
  appliedSnapshots,
  appendLedger,
  readLedger,
} from '../../src/selfmod/ledger.js';
import {
  lastKnownGood,
  requireCleanTree,
  snapshotApplied,
  revertTo,
  treeState,
  type GitRunner,
} from '../../src/selfmod/snapshots.js';
import { runSelfModification } from '../../src/selfmod/workflow.js';
import { selfModificationAlwaysAsks } from '../../src/permissions/autonomy.js';

const change = (paths: readonly string[]): ChangeSet => ({
  summary: 'add a helper',
  explanation: 'Adds a small pure helper and its tests.',
  writes: paths.map((path) => ({ path, contents: 'export const x = 1;\n' })),
});

describe('the protected layer', () => {
  const guarded = [
    'src/permissions/rule-engine.ts',
    'src/permissions/risk-classifier.ts',
    'src/permissions/autonomy.ts',
    'src/permissions/confirmation-flow.ts',
    'src/permissions/default-rules.ts',
    'src/permissions/safe-bin-profiles.ts',
    'src/permissions/sudoers-setup.ts',
    'src/permissions/dry-run.ts',
    'src/audit/audit-log.ts',
    'src/audit/audit-log.schema.ts',
  ];

  it.each(guarded)('refuses %s', (path) => {
    expect(checkProtectedPath(path)).toBeDefined();
  });

  it('refuses the whole selfmod and audit directories', () => {
    expect(checkProtectedPath('src/selfmod/workflow.ts')).toBeDefined();
    expect(checkProtectedPath('src/audit/anything.ts')).toBeDefined();
  });

  it('refuses a traversal that escapes into the protected layer', () => {
    // Spelling the same file differently must not get past the boundary.
    expect(
      checkProtectedPath('src/selfmod/../audit/audit-log.ts'),
    ).toBeDefined();
    expect(checkProtectedPath('./src/permissions/autonomy.ts')).toBeDefined();
    expect(
      checkProtectedPath('src/permissions/../permissions/autonomy.ts'),
    ).toBeDefined();
  });

  it('allows ordinary source and test files', () => {
    for (const path of [
      'src/tui/App.tsx',
      'src/voice/cli.ts',
      'tests/tui/fuzzy.test.ts',
      'README.md',
    ]) {
      expect(checkProtectedPath(path)).toBeUndefined();
    }
  });

  it('refuses a migration that defines the permission or audit schema', () => {
    expect(
      checkProtectedPath('migrations/009_permission_change.sql'),
    ).toBeDefined();
    expect(checkProtectedPath('migrations/007_notes.sql')).toBeUndefined();
  });

  it('refuses the entire change set rather than dropping one file', () => {
    const validated = validateChange(
      change(['src/tui/App.tsx', 'src/permissions/autonomy.ts']),
    );
    expect(validated.acceptable).toBe(false);
    expect(validated.violations).toHaveLength(1);
    expect(refusalReason(validated)).toContain('will not modify');
  });

  it('exposes the list so it can be reviewed', () => {
    const listed = protectedPaths();
    expect(listed.files.length).toBeGreaterThanOrEqual(guarded.length);
    expect(listed.directories).toContain('src/selfmod/');
  });
});

describe('health and rollback', () => {
  it('asks for typecheck, build, and a real start', () => {
    const steps = healthSteps();
    expect(steps.map((step) => step.name)).toEqual([
      'typecheck',
      'build',
      'starts',
    ]);
  });

  it('accepts only when every step passes', () => {
    expect(
      recoveryFor(evaluateHealth([{ name: 'a', ok: true, detail: '' }])),
    ).toBe('accept');
    expect(
      recoveryFor(
        evaluateHealth([
          { name: 'typecheck', ok: true, detail: '' },
          { name: 'starts', ok: false, detail: 'SyntaxError' },
        ]),
      ),
    ).toBe('rollback');
  });

  it('picks the newest known-good snapshot', () => {
    const good = lastKnownGood([
      { sha: 'aaa', preSha: 'p1', branch: 'b1', at: '1', summary: 'one' },
      { sha: 'bbb', preSha: 'p2', branch: 'b2', at: '2', summary: 'two' },
    ]);
    expect(good?.sha).toBe('bbb');
  });

  it('records the pre-change commit, which is what actually undoes it', () => {
    // Resetting to the snapshot restores the tree that already contains the
    // change, so it reverts nothing.
    let revParses = 0;
    const git: GitRunner = (args) => {
      if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') {
        revParses += 1;
        // First rev-parse records the pre-change head; later ones read the new
        // commit the snapshot just created.
        return {
          ok: true,
          stdout: `${revParses === 1 ? 'before-sha' : 'after-sha'}\n`,
          stderr: '',
        };
      }
      return { ok: true, stdout: '', stderr: '' };
    };
    const result = snapshotApplied(git, { summary: 'x', at: 'now' });
    if (!result.ok) throw new Error('expected a snapshot');
    expect(result.snapshot.preSha).toBe('before-sha');
    expect(result.snapshot.sha).toBe('after-sha');
  });

  it('restores files before moving the branch pointer', () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push([...args]);
      return { ok: true, stdout: '', stderr: '' };
    };
    revertTo(git, {
      sha: 'abc',
      preSha: 'before',
      branch: 'selfmod/1',
      at: 'now',
      summary: 'x',
    });
    expect(calls[0]).toEqual(['checkout', 'selfmod/1', '--', '.']);
    expect(calls[1]).toEqual(['reset', '--hard', 'abc']);
  });

  it('reports failure rather than claiming a rollback that did not happen', () => {
    const git: GitRunner = () => ({
      ok: false,
      stdout: '',
      stderr: 'dirty tree',
    });
    expect(
      revertTo(git, { sha: 'a', preSha: 'z', branch: 'b', at: '', summary: '' })
        .ok,
    ).toBe(false);
  });

  it('refuses to proceed when the tree is already dirty', () => {
    // Checked before applying, since applying is itself what dirties the tree.
    const dirty: GitRunner = (args) =>
      args[0] === 'status'
        ? { ok: true, stdout: ' M src/tui/App.tsx\n', stderr: '' }
        : { ok: true, stdout: 'abc', stderr: '' };
    const refusal = requireCleanTree(dirty);
    expect(refusal.ok).toBe(false);
    expect(refusal).toHaveProperty('reason');
    expect(JSON.stringify(refusal)).toContain('uncommitted');
  });

  it('allows the precondition on a clean tree', () => {
    const clean: GitRunner = (args) =>
      args[0] === 'status'
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: 'abc', stderr: '' };
    expect(requireCleanTree(clean)).toEqual({ ok: true });
  });

  it('reads a clean tree', () => {
    const git: GitRunner = (args) =>
      args[0] === 'status'
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: 'abc123\n', stderr: '' };
    expect(treeState(git)).toEqual({ clean: true, head: 'abc123' });
  });
});

describe('ledger', () => {
  it('records attempts and survives a torn line', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-sm-ledger-'));
    appendLedger(home, {
      at: '1',
      outcome: 'applied',
      summary: 'a',
      paths: [],
      explanation: 'x',
      sha: 'aaa',
    });
    writeFileSync(join(home, 'selfmod-ledger.jsonl'), '{"torn\n', {
      flag: 'a',
    });
    const entries = readLedger(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sha).toBe('aaa');
  });

  it('excludes snapshots that were rolled back', () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-sm-ledger-'));
    appendLedger(home, {
      at: '1',
      outcome: 'applied',
      summary: 'a',
      paths: [],
      explanation: 'x',
      sha: 'aaa',
    });
    appendLedger(home, {
      at: '2',
      outcome: 'rolled-back',
      summary: 'a',
      paths: [],
      explanation: 'x',
      sha: 'aaa',
      rolledBack: true,
    });
    expect(appliedSnapshots(readLedger(home))).toHaveLength(0);
  });
});

describe('approval is unconditional', () => {
  it('has no input through which the exemption could be skipped', () => {
    // Takes no arguments, so there is nothing for a caller to pass.
    expect(selfModificationAlwaysAsks.length).toBe(0);
    expect(selfModificationAlwaysAsks()).toBe(true);
  });
});

describe('the workflow', () => {
  function deps(
    overrides: Partial<Parameters<typeof runSelfModification>[1]> = {},
  ) {
    const home = mkdtempSync(join(tmpdir(), 'atlas-sm-wf-'));
    const calls: string[] = [];
    const base = {
      atlasHome: home,
      git: ((args: readonly string[]) => {
        calls.push(args.join(' '));
        if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
        return { ok: true, stdout: 'sha123', stderr: '' };
      }) as GitRunner,
      verify: () => Promise.resolve({ ok: true, steps: [] }),
      apply: () => {
        calls.push('APPLY');
        return Promise.resolve();
      },
      discard: () => {
        calls.push('DISCARD');
        return Promise.resolve();
      },
      healthCheck: () =>
        Promise.resolve(
          evaluateHealth([{ name: 'starts', ok: true, detail: '' }]),
        ),
      confirm: () => Promise.resolve(true),
      now: () => '2026-01-01T00:00:00.000Z',
    };
    return { home, calls, deps: { ...base, ...overrides } };
  }

  it('refuses a protected change before doing any work', async () => {
    const d = deps();
    const result = await runSelfModification(
      change(['src/permissions/autonomy.ts']),
      d.deps,
    );
    expect(result.kind).toBe('refused');
    // No verification, no approval, no apply. The only call is the clean-tree
    // precondition, which reads git and changes nothing.
    expect(d.calls).toEqual(['status --porcelain', 'rev-parse HEAD']);
    expect(readLedger(d.home).at(-1)?.outcome).toBe('refused-protected');
  });

  it('never asks the user about an unverified change', async () => {
    let asked = false;
    const d = deps({
      verify: () =>
        Promise.resolve({ ok: false, steps: [], failedAt: 'tests' }),
      confirm: () => {
        asked = true;
        return Promise.resolve(true);
      },
    });
    const result = await runSelfModification(
      change(['src/tui/App.tsx']),
      d.deps,
    );
    expect(result.kind).toBe('unverified');
    expect(asked).toBe(false);
    expect(d.calls).toContain('DISCARD');
  });

  it('discards completely on rejection, leaving nothing applied', async () => {
    const d = deps({ confirm: () => Promise.resolve(false) });
    const result = await runSelfModification(
      change(['src/tui/App.tsx']),
      d.deps,
    );
    expect(result.kind).toBe('rejected');
    expect(d.calls).toContain('DISCARD');
    expect(d.calls).not.toContain('APPLY');
    expect(readLedger(d.home).at(-1)?.outcome).toBe('rejected');
  });

  it('applies and snapshots when approved and healthy', async () => {
    const d = deps();
    const result = await runSelfModification(
      change(['src/tui/App.tsx']),
      d.deps,
    );
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.rolledBack).toBe(false);
    expect(result.snapshot.sha).toBe('sha123');
  });

  it('rolls back automatically when the change cannot start', async () => {
    let reverted = false;
    const git: GitRunner = (args) => {
      if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'checkout') {
        reverted = true;
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: true, stdout: 'good-sha', stderr: '' };
    };
    const d = deps({
      git,
      healthCheck: () =>
        Promise.resolve(
          evaluateHealth([
            { name: 'starts', ok: false, detail: 'SyntaxError' },
          ]),
        ),
      knownGood: [
        {
          sha: 'good-sha',
          preSha: 'older',
          branch: 'selfmod/prev',
          at: 'earlier',
          summary: 'known good',
        },
      ],
    });
    const result = await runSelfModification(
      change(['src/tui/App.tsx']),
      d.deps,
    );
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.rolledBack).toBe(true);
    expect(reverted).toBe(true);
    expect(readLedger(d.home).at(-1)?.outcome).toBe('rolled-back');
  });

  it('records the refusal reason in the audit-visible ledger', async () => {
    const d = deps();
    await runSelfModification(change(['src/audit/audit-log.ts']), d.deps);
    const entry = readLedger(d.home).at(-1);
    expect(entry?.outcome).toBe('refused-protected');
    expect(entry?.paths).toContain('src/audit/audit-log.ts');
    expect(entry?.detail).toContain('safety layer');
  });

  it('does not silently retry after rejection', async () => {
    let attempts = 0;
    const d = deps({
      confirm: () => {
        attempts += 1;
        return Promise.resolve(false);
      },
    });
    await runSelfModification(change(['src/tui/App.tsx']), d.deps);
    expect(attempts).toBe(1);
  });
});

describe('boundary is not merely advisory', () => {
  it('reports a protected batch rather than only the first offender', () => {
    expect(
      checkProtectedPaths([
        'src/permissions/autonomy.ts',
        'src/audit/audit-log.ts',
      ]),
    ).toHaveLength(2);
    expect(isProtectedChange(['src/tui/App.tsx'])).toBe(false);
  });

  it('does not depend on the working tree being present', () => {
    // Purely path-based: it must decide before anything touches disk.
    expect(checkProtectedPath('src/permissions/autonomy.ts')).toBeDefined();
    expect(existsSync(join(process.cwd(), 'src/permissions/autonomy.ts'))).toBe(
      true,
    );
    const contents = readFileSync(
      join(process.cwd(), 'src/permissions/autonomy.ts'),
      'utf8',
    );
    expect(contents).toContain('SELF_MODIFICATION_REASON');
  });
});
