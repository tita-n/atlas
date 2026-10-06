/**
 * Real implementations of the workflow's steps.
 *
 * Kept apart from the workflow itself so the ordering logic stays testable
 * without a toolchain, and so the parts that touch disk are in one auditable
 * place.
 *
 * Verification runs against a scratch copy of the repository, never the live
 * tree. A change that fails verification must not have touched the working
 * copy, and building in place would leave `dist/` half-updated for a change
 * nobody approved.
 */

import { execFile } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { ChangeSet } from './change-set.js';
import {
  evaluateHealth,
  healthSteps,
  type HealthReport,
  type StepResult,
} from './health.js';

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (
  argv: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<RunResult>;

/** Runs a command with a timeout, resolving rather than throwing on failure. */
export const exec: Exec = (argv, options) =>
  new Promise<RunResult>((resolvePromise) => {
    execFile(
      argv[0] ?? '',
      argv.slice(1),
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: error === null,
          stdout,
          stderr: error === null ? stderr : (error as Error).message,
        });
      },
    );
  });

/**
 * Copies the repo into a scratch directory so verification cannot touch it.
 *
 * node_modules is symlinked rather than copied. Copying it would take minutes
 * per verification, and excluding it makes the scratch tree unable to typecheck
 * at all - which reads as "the change failed verification" for reasons that
 * have nothing to do with the change.
 */
export async function scratchCopy(repoRoot: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-selfmod-'));
  // Match on a path *segment*, not a substring: the entry for `node_modules`
  // itself has no trailing slash, so a substring filter lets an empty
  // directory through and the symlink below then silently fails.
  const skipped = new Set(['node_modules', '.git', 'dist']);
  await cp(repoRoot, dir, {
    recursive: true,
    filter: (source) => {
      const segments = source.split(/[\\/]/);
      const name = segments[segments.length - 1] ?? '';
      return (
        !skipped.has(name) && !segments.some((segment) => skipped.has(segment))
      );
    },
  });
  // node_modules is a symlink so verification is fast; dist is rebuilt inside
  // the scratch tree rather than copied, so the build is honest.
  await symlink(
    join(repoRoot, 'node_modules'),
    join(dir, 'node_modules'),
    'dir',
  );
  return dir;
}

/** Writes the proposed files into a tree. */
export async function writeChange(
  root: string,
  change: ChangeSet,
): Promise<void> {
  for (const write of change.writes) {
    const target = resolve(root, write.path);
    if (!target.startsWith(resolve(root))) {
      // Belt and braces: a path escaping the tree is never written.
      throw new Error(`refusing to write outside the tree: ${write.path}`);
    }
    await writeFile(target, write.contents, 'utf8');
  }
}

/** Checks a scratch tree compiles, builds, and actually starts. */
export async function verifyIn(
  root: string,
  execFn: Exec = exec,
): Promise<{ ok: boolean; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  for (const step of healthSteps()) {
    const result = await execFn(step.argv, {
      cwd: root,
      timeoutMs: step.timeoutMs,
    });
    steps.push({
      name: step.name,
      ok: result.ok,
      detail: (result.ok ? '' : result.stderr || result.stdout).slice(0, 2000),
    });
    if (!result.ok) break;
  }
  return { ok: steps.every((step) => step.ok), steps };
}

/**
 * Verifies a change without touching the live tree.
 *
 * Returns failed verification rather than throwing, so the workflow can record
 * why it refused to ask the user.
 */
export async function verifyChange(
  change: ChangeSet,
  repoRoot: string,
  execFn: Exec = exec,
): Promise<{ ok: boolean; steps: StepResult[]; failedAt?: string }> {
  let scratch: string;
  try {
    scratch = await scratchCopy(repoRoot);
  } catch (error) {
    return {
      ok: false,
      steps: [
        {
          name: 'scratch',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      failedAt: 'scratch',
    };
  }
  try {
    await writeChange(scratch, change);
    const result = await verifyIn(scratch, execFn);
    const failedAt = result.steps.find((step) => !step.ok)?.name;
    return {
      ok: result.ok,
      steps: result.steps,
      ...(failedAt === undefined ? {} : { failedAt }),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Applies a change to the live tree. Only ever called after approval. */
export async function applyChange(
  repoRoot: string,
  change: ChangeSet,
): Promise<void> {
  await writeChange(repoRoot, change);
}

/**
 * Health-checks the live tree.
 *
 * Deliberately runs the real entry point rather than a proxy: a change that
 * typechecks but breaks the CLI has still bricked Atlas.
 */
export async function healthCheckLive(
  repoRoot: string,
  execFn: Exec = exec,
): Promise<HealthReport> {
  const steps: StepResult[] = [];
  for (const step of healthSteps()) {
    const result = await execFn(step.argv, {
      cwd: repoRoot,
      timeoutMs: step.timeoutMs,
    });
    steps.push({
      name: step.name,
      ok: result.ok,
      detail: (result.ok ? '' : result.stderr || result.stdout).slice(0, 2000),
    });
    if (!result.ok) break;
  }
  return evaluateHealth(steps);
}

/** Reads a change set from a JSON file, for the command-line entry point. */
export async function readChangeSet(path: string): Promise<ChangeSet> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('change set must be an object');
  }
  const candidate = parsed as Partial<ChangeSet>;
  if (
    typeof candidate.summary !== 'string' ||
    !Array.isArray(candidate.writes)
  ) {
    throw new Error('change set needs a summary and a writes array');
  }
  return {
    summary: candidate.summary,
    explanation: candidate.explanation ?? candidate.summary,
    writes: candidate.writes,
  };
}

export { dirname };
