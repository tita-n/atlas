/**
 * `atlas selfmod` — the command-line entry point for self-modification.
 *
 * Approval is a typed phrase, the same ceremony autonomy uses when lowering a
 * level, because this is the change most capable of breaking every later
 * judgement. It is not a flag: there is no way to make this quieter.
 *
 * Nothing reaches the user until it has been built and started in a scratch
 * copy, because being asked to approve a change that does not work is asking
 * for a decision that cannot be made.
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { loadAssistantConfig } from '../config/assistant-config.js';
import {
  readChangeSet,
  applyChange,
  healthCheckLive,
  verifyChange,
} from './runner.js';
import { runSelfModification, SELF_MODIFICATION_REASON } from './workflow.js';
import type { GitRunner } from './snapshots.js';
import { validateChange, refusalReason } from './change-set.js';
import { requireCleanTree } from './snapshots.js';
import { readAutonomySync } from '../permissions/autonomy.js';
import { appendLedger } from './ledger.js';
import { AuditLog } from '../audit/audit-log.js';
import { openDatabase } from '../memory/database.js';

const PHRASE = 'I APPROVE SELF-MODIFICATION';

/** Runs git and returns a runner over it. */
export const gitRunner: GitRunner = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export interface SelfmodOptions {
  /** JSON file describing the proposed change. */
  readonly file: string;
  /** Repo root; defaults to the current directory. */
  readonly root?: string;
  readonly now?: () => string;
  /** Injected in tests so nothing shells out. */
  readonly verify?: typeof verifyChange;
  readonly health?: typeof healthCheckLive;
  readonly git?: GitRunner;
}

export async function runSelfmodCommand(
  options: SelfmodOptions,
): Promise<number> {
  const root = options.root ?? process.cwd();
  const change = await readChangeSet(options.file);

  // Refuse the protected layer before reading further or touching anything.
  const validation = validateChange(change);
  if (!validation.acceptable) {
    console.error(refusalReason(validation));
    return 1;
  }

  // Check the tree is clean before any work, so the snapshot can isolate this
  // change from unrelated work and stay revertible on its own.
  const runner = options.git ?? gitRunner;
  const clean = requireCleanTree(runner);
  if (!clean.ok) {
    console.error(clean.reason);
    return 1;
  }

  const git = runner;
  const verify = options.verify ?? verifyChange;
  const health = options.health ?? healthCheckLive;
  const now = options.now ?? (() => new Date().toISOString());
  const atlasHome = loadAssistantConfig().homeDirectory;

  console.log(`Proposed: ${change.summary}`);
  console.log('');
  console.log(change.explanation);
  console.log('');
  for (const write of change.writes) console.log(`  ${write.path}`);
  console.log('');

  // Verify before asking. The scratch copy means a failing change leaves the
  // working tree untouched.
  console.log(
    'Verifying the change (typecheck, build, start) before asking...',
  );
  const verification = await verify(change, root);
  if (!verification.ok) {
    console.error(`The change does not verify; not asking you to approve it.`);
    for (const step of verification.steps) {
      if (!step.ok)
        console.error(`  ${step.name}: ${step.detail.split('\n')[0] ?? ''}`);
    }
    return 1;
  }
  console.log('Verified.');

  console.log('');
  console.log(SELF_MODIFICATION_REASON);
  console.log('');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `Type "${PHRASE}" to apply, anything else to discard: `,
  );
  rl.close();
  if (answer.trim() !== PHRASE) {
    appendLedger(atlasHome, {
      at: now(),
      outcome: 'rejected',
      summary: change.summary,
      paths: change.writes.map((write) => write.path),
      explanation: change.explanation,
    });
    console.log('Discarded. Nothing was applied.');
    return 0;
  }

  // Every attempt lands in the ordinary audit history too, tagged so an
  // unattended run can still be reviewed in one place.
  const database = openDatabase(join(atlasHome, 'atlas.db'));
  const audit = new AuditLog(database);

  const outcome = await runSelfModification(change, {
    atlasHome,
    audit: (entry) => {
      try {
        audit.append({
          timestamp: now(),
          eventKind: 'self-modification',
          command: entry.paths.join(', ') || '(no files)',
          summary: entry.summary,
          // Self-modification is gated unconditionally, so it is recorded as
          // approved through the text gate path and never as an auto-allow.
          gatePath: 'text-safe-word',
          autonomy: readAutonomySync(atlasHome).level,
          riskTier: 2,
          matchedRule: 'selfmod',
          decision:
            entry.outcome === 'rejected' ? 'asked-denied' : 'asked-approved',
          outcome:
            entry.outcome === 'rolled-back'
              ? 'failed'
              : entry.outcome === 'rejected'
                ? 'denied'
                : 'succeeded',
          exitCode: null,
          durationMs: null,
        });
      } catch {
        // An audit write must not abort the rollback path.
      }
    },
    git,
    verify: () => Promise.resolve(verification),
    apply: async (applied) => {
      await applyChange(root, applied);
    },
    discard: async () => {
      // Nothing to undo: the change only ever existed in a scratch copy until
      // this point, and a rejection never reached apply.
    },
    healthCheck: async () => health(root),
    confirm: () => Promise.resolve(true), // already approved above, with the phrase
    now,
  });

  switch (outcome.kind) {
    case 'applied':
      if (outcome.rolledBack) {
        console.error(
          'Health check failed; the change was rolled back automatically.',
        );
        return 1;
      }
      console.log(
        `Applied and healthy. Snapshot ${outcome.snapshot.sha} on ${outcome.snapshot.branch}.`,
      );
      console.log('Revert it on its own with:');
      console.log(`  git reset --hard ${outcome.snapshot.sha}`);
      return 0;
    case 'refused':
      console.error(outcome.reason);
      return 1;
    case 'rejected':
      console.log('Discarded. Nothing was applied.');
      return 0;
    case 'unverified':
      console.error('The change did not verify; nothing was applied.');
      return 1;
    case 'snapshot-failed':
      console.error(`Applied but could not be snapshotted: ${outcome.reason}`);
      return 1;
    default:
      return 1;
  }
}
