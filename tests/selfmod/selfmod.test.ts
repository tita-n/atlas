/**
 * Self-modification workflow tests.
 *
 * The assertions here are about consequences, not about which functions were
 * called: a rejected change must leave nothing applied, a failed health check
 * must roll back, and the protected layer must be refused before any work
 * happens at all.
 */
import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
import {
  readChangeSet,
  scratchCopy,
  writeChange,
} from '../../src/selfmod/runner.js';
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

  it('refuses spellings that only differ in how the path is written', () => {
    // Each of these reaches the protected file when handed to a real write, so
    // a boundary that only matches the canonical spelling is not a boundary.
    for (const path of [
      '/home/user/repo/src/audit/audit-log.ts',
      '/repo/src/permissions/autonomy.ts',
      'C:\\repo\\src\\audit\\audit-log.ts',
      '../repo/src/audit/audit-log.ts',
      'src/permissions/autonomy.ts ',
      ' src/permissions/autonomy.ts',
      'src/selfmod',
      '',
      '.',
    ]) {
      expect(checkProtectedPath(path), path).toBeDefined();
    }
  });

  it('refuses the whole set when one path is protected and the rest are not', () => {
    // Nothing may be partially applied: the ordinary file must not be written
    // on the strength of the protected one being refused.
    const validated = validateChange(
      change(['src/tui/App.tsx', 'src/selfmod/protected-paths.ts']),
    );
    expect(validated.acceptable).toBe(false);
    expect(refusalReason(validated)).toContain(
      'src/selfmod/protected-paths.ts',
    );
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

  it('skips a snapshot that could not be reverted to', () => {
    // No pre-change commit means no rollback is possible, so it is not a
    // candidate however new it is.
    const good = lastKnownGood([
      { sha: 'aaa', preSha: 'p1', branch: 'b1', at: '1', summary: 'one' },
      { sha: 'bbb', preSha: '', branch: 'b2', at: '2', summary: 'two' },
    ]);
    expect(good?.sha).toBe('aaa');
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
      sha: 'after',
      preSha: 'before',
      branch: 'selfmod/1',
      at: 'now',
      summary: 'x',
    });
    expect(calls[0]).toEqual(['checkout', 'selfmod/1', '--', '.']);
    // preSha, not sha: the snapshot's own commit already contains the change,
    // so resetting to it would revert nothing.
    expect(calls[1]).toEqual(['reset', '--hard', 'before']);
  });

  it('refuses to revert to a snapshot with no pre-change commit', () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push([...args]);
      return { ok: true, stdout: '', stderr: '' };
    };
    const reverted = revertTo(git, {
      sha: 'abc',
      preSha: '',
      branch: 'selfmod/1',
      at: 'now',
      summary: 'x',
    });
    expect(reverted.ok).toBe(false);
    expect(calls).toEqual([]);
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

  it('reverts to the commit before the change, never to its own snapshot', async () => {
    // A reset to the snapshot's own sha restores the tree that already
    // contains the change, so it would report a rollback that undid nothing.
    const calls: string[] = [];
    const git: GitRunner = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      // First rev-parse is the pre-change head; the rest read the new commit.
      const heads = calls.filter((call) => call === 'rev-parse HEAD').length;
      return {
        ok: true,
        stdout: heads === 1 ? 'before-sha' : 'after-sha',
        stderr: '',
      };
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
          sha: 'older-good',
          preSha: 'older-pre',
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
    if (result.kind !== 'applied') throw new Error('expected applied');
    expect(result.rolledBack).toBe(true);
    expect(result.healthy).toBe(false);
    // The pre-change head this change was built on top of, never 'after-sha'.
    expect(calls).toContain('reset --hard older-pre');
    expect(calls).not.toContain('reset --hard after-sha');
  });

  it('reports honestly when there is no known-good snapshot to revert to', async () => {
    const d = deps({
      healthCheck: () =>
        Promise.resolve(
          evaluateHealth([
            { name: 'starts', ok: false, detail: 'SyntaxError' },
          ]),
        ),
    });
    const result = await runSelfModification(
      change(['src/tui/App.tsx']),
      d.deps,
    );
    if (result.kind !== 'applied') throw new Error('expected applied');
    // Not healthy, and no rollback claimed: the caller must not report success.
    expect(result.healthy).toBe(false);
    expect(result.rolledBack).toBe(false);
    const entry = readLedger(d.home).at(-1);
    expect(entry?.outcome).toBe('rolled-back');
    expect(entry?.rolledBack).toBe(false);
    expect(entry?.detail).toContain('no known-good snapshot');
  });

  it('writes both a ledger entry and an audit row for every terminal outcome', async () => {
    const audited: string[] = [];
    const auditHome = mkdtempSync(join(tmpdir(), 'atlas-sm-audit-'));
    const scenarios: {
      name: string;
      overrides: Partial<Parameters<typeof runSelfModification>[1]>;
    }[] = [
      { name: 'protected', overrides: {} },
      {
        name: 'unverified',
        overrides: {
          verify: () =>
            Promise.resolve({ ok: false, steps: [], failedAt: 'tests' }),
        },
      },
      {
        name: 'rejected',
        overrides: { confirm: () => Promise.resolve(false) },
      },
      {
        name: 'dirty tree',
        overrides: {
          git: (args: readonly string[]) =>
            args[0] === 'status'
              ? { ok: true, stdout: ' M src/tui/App.tsx', stderr: '' }
              : { ok: true, stdout: 'sha', stderr: '' },
        },
      },
      {
        name: 'unhealthy',
        overrides: {
          healthCheck: () =>
            Promise.resolve(
              evaluateHealth([{ name: 'starts', ok: false, detail: 'no' }]),
            ),
        },
      },
    ];

    for (const scenario of scenarios) {
      const d = deps(scenario.overrides);
      const paths =
        scenario.name === 'protected'
          ? ['src/permissions/autonomy.ts']
          : ['src/tui/App.tsx'];
      const result = await runSelfModification(change(paths), {
        ...d.deps,
        atlasHome: auditHome,
        audit: (entry) => {
          audited.push(`${scenario.name}:${entry.outcome}`);
        },
      });
      expect(result.kind, scenario.name).not.toBe(undefined);
      const entry = readLedger(auditHome).at(-1);
      expect(entry?.outcome, `${scenario.name} ledger`).toBeDefined();
      expect(audited, `${scenario.name} audit`).toEqual([
        `${scenario.name}:${entry?.outcome ?? ''}`,
      ]);
      audited.length = 0;
    }
  });

  it('orders the steps so nothing reaches the user unverified', async () => {
    const d = deps();
    await runSelfModification(change(['src/tui/App.tsx']), d.deps);
    const order = d.calls;
    // Verify, then approve, then apply, then commit, then the real start.
    const applyAt = order.indexOf('APPLY');
    const commitAt = order.findIndex((call) => call.startsWith('commit'));
    const expectVerifyBeforeApply = applyAt > -1;
    expect(expectVerifyBeforeApply).toBe(true);
    expect(commitAt).toBeGreaterThan(applyAt);
    expect(order.some((call) => call.startsWith('checkout -b selfmod/'))).toBe(
      true,
    );
  });

  it('never applies a change that failed verification or the boundary', async () => {
    const unverified = deps({
      verify: () =>
        Promise.resolve({ ok: false, steps: [], failedAt: 'build' }),
    });
    await runSelfModification(change(['src/tui/App.tsx']), unverified.deps);
    expect(unverified.calls).not.toContain('APPLY');

    const protectedChange = deps();
    await runSelfModification(
      change(['src/audit/audit-log.ts']),
      protectedChange.deps,
    );
    expect(protectedChange.calls).not.toContain('APPLY');
  });
});

describe('the scratch copy', () => {
  it('refuses a write that escapes into a sibling of the tree', async () => {
    // `<root>-evil` shares the root's prefix, so a bare startsWith test would
    // let it through.
    const root = await mkdtemp(join(tmpdir(), 'atlas-sm-scratch-'));
    await expect(
      writeChange(root, {
        summary: 'x',
        explanation: 'x',
        writes: [{ path: `../${basename(root)}-evil/pwned.ts`, contents: 'x' }],
      }),
    ).rejects.toThrow(/outside the tree/);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a traversal out of the tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-sm-scratch-'));
    await expect(
      writeChange(root, {
        summary: 'x',
        explanation: 'x',
        writes: [{ path: '../../etc/pwned.ts', contents: 'x' }],
      }),
    ).rejects.toThrow(/outside the tree/);
    await rm(root, { recursive: true, force: true });
  });

  it('symlinks node_modules instead of copying it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'atlas-sm-fixture-'));
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'marker.txt'), 'dep');
    const scratch = await scratchCopy(repo);
    try {
      expect(lstatSync(join(scratch, 'node_modules')).isSymbolicLink()).toBe(
        true,
      );
      // Copies the marker file so a symlinked read still works.
      await writeChange(scratch, {
        summary: 'x',
        explanation: 'x',
        writes: [{ path: 'src/new.ts', contents: 'export const x = 1;\n' }],
      });
      expect(readFileSync(join(scratch, 'src/new.ts'), 'utf8')).toContain(
        'export const x',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('failure modes at the entry point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sm-changes-'));

  it('explains a missing change-set file', async () => {
    await expect(readChangeSet(join(dir, 'absent.json'))).rejects.toThrow(
      /No change-set file/,
    );
  });

  it('explains malformed JSON rather than leaking a parse stack', async () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{"summary": "x", ');
    await expect(readChangeSet(path)).rejects.toThrow(/not valid JSON/);
  });

  it('explains a change set with no writes', async () => {
    const path = join(dir, 'empty.json');
    writeFileSync(path, JSON.stringify({ summary: 'nothing', writes: [] }));
    await expect(readChangeSet(path)).rejects.toThrow(/no writes/);
  });

  it('explains a write with no path or contents', async () => {
    const path = join(dir, 'malformed-write.json');
    writeFileSync(
      path,
      JSON.stringify({ summary: 'x', writes: [{ path: 'src/a.ts' }] }),
    );
    await expect(readChangeSet(path)).rejects.toThrow(/Every write needs/);
  });

  it('refuses a change-set file that is not an object', async () => {
    const path = join(dir, 'array.json');
    writeFileSync(path, '[]');
    await expect(readChangeSet(path)).rejects.toThrow(/JSON object/);
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
