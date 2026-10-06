/**
 * Per-change version snapshots.
 *
 * Every applied self-modification gets its own commit so it can be reverted
 * alone. That isolation is the point: a revert that also dragged back unrelated
 * work would be indistinguishable from a manual recovery and would make the
 * automatic rollback below unsafe to run unattended.
 *
 * Git is the store because it is already required to build and run the
 * project, and because a commit is a snapshot anyone can inspect afterwards.
 */

export interface Snapshot {
  /** Commit sha of the applied change. */
  readonly sha: string;
  /** Branch the change is committed on. */
  readonly branch: string;
  /** When the snapshot was taken. */
  readonly at: string;
  readonly summary: string;
}

export type GitRunner = (args: readonly string[]) => {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/** A clean working tree is a precondition, not a warning. */
export interface TreeState {
  readonly clean: boolean;
  readonly head: string;
}

export function treeState(git: GitRunner): TreeState {
  const status = git(['status', '--porcelain']);
  const head = git(['rev-parse', 'HEAD']);
  return {
    clean: status.ok && status.stdout.trim() === '',
    head: head.ok ? head.stdout.trim() : '',
  };
}

/**
 * Commits the applied change on its own branch.
 *
 * Assumes the working tree was clean before the change was applied - that is
 * checked up front by {@link requireCleanTree} as a precondition. Re-checking
 * here would fail on the change itself, since applying it is what makes the
 * tree dirty.
 */
export function snapshotApplied(
  git: GitRunner,
  input: { summary: string; at: string },
): { ok: true; snapshot: Snapshot } | { ok: false; reason: string } {
  const branch = `selfmod/${Date.now()}`;
  const checkout = git(['checkout', '-b', branch]);
  if (!checkout.ok) return { ok: false, reason: checkout.stderr.trim() };
  const add = git(['add', '-A']);
  if (!add.ok) return { ok: false, reason: add.stderr.trim() };
  const commit = git(['commit', '-m', `selfmod: ${input.summary}`]);
  if (!commit.ok) return { ok: false, reason: commit.stderr.trim() };
  const sha = git(['rev-parse', 'HEAD']);
  return {
    ok: true,
    snapshot: {
      sha: sha.ok ? sha.stdout.trim() : '',
      branch,
      at: input.at,
      summary: input.summary,
    },
  };
}

/**
 * Reverts to a known-good snapshot.
 *
 * Restores the recorded tree first, then moves the branch pointer, so a
 * failure part-way leaves the previous good commit reachable rather than a
 * half-reverted one.
 */
export function revertTo(
  git: GitRunner,
  snapshot: Snapshot,
): { ok: true } | { ok: false; reason: string } {
  const restore = git(['checkout', snapshot.branch, '--', '.']);
  if (!restore.ok) {
    return {
      ok: false,
      reason: `could not restore files: ${restore.stderr.trim()}`,
    };
  }
  const reset = git(['reset', '--hard', snapshot.sha]);
  if (!reset.ok) {
    return {
      ok: false,
      reason: `could not reset to ${snapshot.sha}: ${reset.stderr.trim()}`,
    };
  }
  return { ok: true };
}

/**
 * Precondition: the tree must be clean before a change is applied.
 *
 * Enforced here rather than at snapshot time, because applying the change is
 * itself what dirties the tree, and because bundling unrelated work into a
 * safety snapshot would make reverting it destructive.
 */
export function requireCleanTree(
  git: GitRunner,
): { ok: true } | { ok: false; reason: string } {
  if (treeState(git).clean) return { ok: true };
  return {
    ok: false,
    reason:
      'The working tree has uncommitted changes. Atlas will not apply a ' +
      'self-modification on top of unrelated work, because the snapshot could ' +
      'not then be reverted on its own. Commit or discard them first.',
  };
}

/** The last snapshot recorded as healthy, which rollback should target. */
export function lastKnownGood(
  snapshots: readonly Snapshot[],
): Snapshot | undefined {
  const healthy = snapshots.filter((snapshot) => snapshot.sha !== '');
  return healthy[healthy.length - 1];
}
