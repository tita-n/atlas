/**
 * The self-modification workflow.
 *
 * Ordered so nothing reaches the user unverified and nothing is applied
 * unrecoverably:
 *
 *   clean tree -> protected boundary -> verify -> approve -> apply ->
 *   snapshot -> health -> roll back if unhealthy
 *
 * A failure at any step discards the change completely. There is no partial
 * application and no path that quietly re-proposes the same change, because a
 * rejected change that reappears later is indistinguishable from one the user
 * never saw.
 *
 * Approval is not optional and not configurable. `ConfirmationRequired` is
 * raised structurally, the same way the hard floor is, so no autonomy level can
 * make a self-modification apply without a human answering.
 */

import { validateChange, refusalReason, type ChangeSet } from './change-set.js';
import { SELF_MODIFICATION_REASON } from '../permissions/autonomy.js';

export { SELF_MODIFICATION_REASON };
import {
  evaluateHealth,
  recoveryFor,
  type HealthReport,
  type StepResult,
} from './health.js';
import { appendLedger, type LedgerEntry } from './ledger.js';
import {
  lastKnownGood,
  requireCleanTree,
  revertTo,
  snapshotApplied,
  type GitRunner,
  type Snapshot,
} from './snapshots.js';

/** Why self-modification always needs a person. Shared with the gate. */

export interface VerificationResult {
  readonly ok: boolean;
  readonly steps: readonly StepResult[];
  readonly failedAt?: string | undefined;
}

export type ApplyOutcome =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unverified'; readonly verification: VerificationResult }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'snapshot-failed'; readonly reason: string }
  | {
      readonly kind: 'applied';
      readonly snapshot: Snapshot;
      readonly health: HealthReport;
      /** Whether the health check passed without needing a rollback. */
      readonly healthy: boolean;
      /** True only when health failed and the revert actually succeeded. */
      readonly rolledBack: boolean;
    };

/**
 * Audit sink for one self-modification attempt.
 *
 * The ledger records the detail; this is what makes attempts visible in the
 * same reviewable history as every other action, rather than only in a file
 * Atlas-specific reader has to know to open.
 */
export type SelfmodAudit = (entry: {
  outcome: string;
  summary: string;
  paths: readonly string[];
  explanation: string;
  detail?: string | undefined;
  sha?: string | undefined;
  rolledBack?: boolean | undefined;
}) => void;

export interface WorkflowDeps {
  /** Writes an audit_log row tagged event_kind='self-modification'. */
  readonly audit?: SelfmodAudit | undefined;
  readonly atlasHome: string;
  readonly git: GitRunner;
  /** Runs the verification suite against a scratch copy of the change. */
  readonly verify: (change: ChangeSet) => Promise<VerificationResult>;
  /** Writes the change to disk. Never called before approval. */
  readonly apply: (change: ChangeSet) => Promise<void>;
  /** Discards any scratch work. */
  readonly discard: () => Promise<void>;
  /** Runs the health check on the applied tree. */
  readonly healthCheck: () => Promise<HealthReport>;
  /** Asks the user. Must return true only on an explicit yes. */
  readonly confirm: (change: ChangeSet) => Promise<boolean>;
  /** Snapshots already known to be healthy, oldest first. */
  readonly knownGood?: readonly Snapshot[] | undefined;
  readonly now?: () => string | undefined;
}

function report(health: HealthReport): HealthReport {
  return health;
}

/**
 * Runs one self-modification end to end.
 *
 * The order is the safety property. Verification precedes the user being asked,
 * and the snapshot plus health check precede the change being called done.
 */
export async function runSelfModification(
  change: ChangeSet,
  deps: WorkflowDeps,
): Promise<ApplyOutcome> {
  const at = deps.now?.() ?? new Date().toISOString();
  const paths = change.writes.map((write) => write.path);

  /**
   * Ends an attempt.
   *
   * Every terminal outcome goes through here, so the ledger and the audit sink
   * cannot drift apart. An outcome that records one and not the other is
   * exactly the attempt that leaves no trace in the history anyone reviews.
   */
  const finish = (
    entry: Omit<LedgerEntry, 'at'>,
    outcome: ApplyOutcome,
  ): ApplyOutcome => {
    appendLedger(deps.atlasHome, { at, ...entry });
    deps.audit?.(entry);
    return outcome;
  };

  // 0. The tree must be clean before anything is applied, so the snapshot can
  //    isolate this change from any unrelated work.
  const clean = requireCleanTree(deps.git);
  if (!clean.ok) {
    return finish(
      {
        outcome: 'snapshot-failed',
        summary: change.summary,
        paths,
        explanation: change.explanation,
        detail: clean.reason,
      },
      { kind: 'snapshot-failed', reason: clean.reason },
    );
  }

  // 1. Boundary first: a protected path is refused before any work happens, so
  // there is nothing to discard and nothing that could have run.
  const validation = validateChange(change);
  if (!validation.acceptable) {
    const reason = refusalReason(validation);
    return finish(
      {
        outcome: 'refused-protected',
        summary: change.summary,
        paths,
        explanation: change.explanation,
        detail: reason,
      },
      { kind: 'refused', reason },
    );
  }

  // 2. Verify before the user is ever asked. Approving a change that has not
  //    been shown to work wastes their attention on something broken.
  const verification = await deps.verify(change);
  if (!verification.ok) {
    await deps.discard();
    return finish(
      {
        outcome: 'failed-verification',
        summary: change.summary,
        paths,
        explanation: change.explanation,
        ...(verification.failedAt === undefined
          ? {}
          : { detail: `failed at ${verification.failedAt}` }),
      },
      { kind: 'unverified', verification },
    );
  }

  appendLedger(deps.atlasHome, {
    at,
    outcome: 'proposed',
    summary: change.summary,
    paths,
    explanation: change.explanation,
  });

  // 3. Approval. Never taken from a setting; the caller is expected to have
  //    routed this through the confirmation gate.
  const approved = await deps.confirm(change);
  if (!approved) {
    await deps.discard();
    return finish(
      {
        outcome: 'rejected',
        summary: change.summary,
        paths,
        explanation: change.explanation,
      },
      { kind: 'rejected' },
    );
  }
  appendLedger(deps.atlasHome, {
    at,
    outcome: 'approved',
    summary: change.summary,
    paths,
    explanation: change.explanation,
  });

  // 4. Apply, then snapshot so it can be reverted on its own.
  await deps.apply(change);
  const snap = snapshotApplied(deps.git, { summary: change.summary, at });
  if (!snap.ok) {
    await deps.discard();
    return finish(
      {
        outcome: 'snapshot-failed',
        summary: change.summary,
        paths,
        explanation: change.explanation,
        detail: snap.reason,
      },
      { kind: 'snapshot-failed', reason: snap.reason },
    );
  }

  // 5. Health. A change that cannot start is rolled back without asking,
  //    because leaving it in place is the one state that is worse than never
  //    having had the feature.
  const health = report(await deps.healthCheck());
  if (recoveryFor(health) === 'accept') {
    return finish(
      {
        outcome: 'applied',
        summary: change.summary,
        paths,
        explanation: change.explanation,
        sha: snap.snapshot.sha,
      },
      {
        kind: 'applied',
        snapshot: snap.snapshot,
        health,
        healthy: true,
        rolledBack: false,
      },
    );
  }

  // Roll back to the state before the change, not to the snapshot that
  // contains it. The snapshot just taken is not a candidate: its own health
  // check is the one that failed.
  const good = lastKnownGood(deps.knownGood ?? []);
  let detail = `health check failed at ${health.failedAt ?? 'unknown'}`;
  let rolledBack = false;
  if (good !== undefined) {
    const reverted = revertTo(deps.git, good);
    rolledBack = reverted.ok;
    detail = reverted.ok
      ? `${detail}; rolled back to ${good.preSha}`
      : `${detail}; ROLLBACK ALSO FAILED: ${reverted.reason}`;
  } else {
    // Never claim a rollback that did not happen: the broken change is still
    // in the tree, and the caller has to be told so.
    detail = `${detail}; no known-good snapshot to roll back to`;
  }

  return finish(
    {
      outcome: 'rolled-back',
      summary: change.summary,
      paths,
      explanation: change.explanation,
      sha: snap.snapshot.sha,
      rolledBack,
      detail,
    },
    {
      kind: 'applied',
      snapshot: snap.snapshot,
      health,
      healthy: false,
      rolledBack,
    },
  );
}

export { evaluateHealth };
