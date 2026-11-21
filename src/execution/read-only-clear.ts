/**
 * The only thing that may run when there is no sandbox.
 *
 * When bubblewrap is unavailable, Atlas must not silently run arbitrary
 * commands on the host (that was the fail-open this file exists to remove).
 * The single thing it may still do is run commands that are provably
 * read-only: the curated safe-bin tier-0 set, plus the trusted routine
 * executables the classifier already reduces to "routine, no matching rule,
 * no write redirect".
 *
 * This is deliberately a POSITIVE clear, not a deny list. A command runs only
 * when the classifier names one of a small allow list of read-only rules; an
 * unknown executable, a write redirect, a sensitive read, `find -exec`, a
 * durable grant, or a package install all fail the clear and are refused.
 *
 * The decision is made by the SAME classifier that decides every other
 * permission question. Re-deriving "is this read-only" here would create a
 * second opinion that could disagree with the gate, and a disagreement in the
 * permissive direction is exactly the bug this whole stage removes.
 */

import { RiskClassifier } from '../permissions/risk-classifier.js';

/** Rules whose tier-0 verdict means "read-only and harmless". */
const READ_ONLY_RULE_IDS: ReadonlySet<string> = new Set([
  // A curated read-only diagnostic profile (ps, df, journalctl, ...).
  'safe-bin-profile',
  // A trusted routine executable with no rule match and no write redirect
  // (ls, cat, grep, echo, id, ...). The classifier only reaches this rule
  // after it has ruled out write redirects, `find -exec`, unknown binaries
  // and every higher-tier rule.
  'default-tier-0',
]);

export interface ReadOnlyClearResult {
  readonly cleared: boolean;
  /** Why the command was cleared, or why it was not. */
  readonly reason: string;
}

// One classifier, built once. It holds no per-command state and no grant
// matcher, so a durable grant cannot influence the clear (a grant is a way to
// skip a prompt, never a reason to run outside a sandbox).
let classifier: RiskClassifier | undefined;

function sharedClassifier(): RiskClassifier {
  classifier ??= new RiskClassifier();
  return classifier;
}

/**
 * Whether a command may run when no sandbox is available.
 *
 * A command is cleared only when the classifier gives it tier 0, allows it,
 * and names one of the read-only rules above. Everything else is refused with
 * a reason a person can act on.
 */
export function positivelyReadOnly(
  command: string,
  cwd: string,
): ReadOnlyClearResult {
  let assessment;
  try {
    assessment = sharedClassifier().assess(command, cwd);
  } catch (error) {
    return {
      cleared: false,
      reason: `the command could not be classified (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
  if (assessment.tier === 0 && assessment.decision === 'allow' && READ_ONLY_RULE_IDS.has(assessment.matchedRule.id)) {
    return {
      cleared: true,
      reason: `read-only: ${assessment.reason}`,
    };
  }
  return {
    cleared: false,
    reason:
      assessment.tier === 0
        ? `not read-only (${assessment.matchedRule.id})`
        : `risk tier ${assessment.tier} (${assessment.matchedRule.id})`,
  };
}
