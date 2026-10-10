/**
 * A proposed self-modification: the files it would write and why.
 *
 * Kept as data rather than an action so the same object can be validated,
 * verified, shown, approved, applied, or discarded. Rejection discards the whole
 * set; there is no partial application and no retry path that would quietly
 * re-propose the same change.
 */

import {
  checkProtectedPaths,
  type ProtectedPathViolation,
} from './protected-paths.js';

export interface FileWrite {
  /** Repo-relative path. */
  readonly path: string;
  readonly contents: string;
  /** Short note on what this file does now. */
  readonly rationale?: string | undefined;
}

export interface ChangeSet {
  /** One-line summary shown before any diff. */
  readonly summary: string;
  /** Plain-language explanation of what the change does and why. */
  readonly explanation: string;
  readonly writes: readonly FileWrite[];
}

export interface ValidatedChangeSet {
  readonly change: ChangeSet;
  /** Empty when the change may proceed. */
  readonly violations: readonly ProtectedPathViolation[];
  readonly acceptable: boolean;
}

/**
 * Checks a change against the protected list.
 *
 * Refuses the whole set rather than filtering the offending file: a proposal
 * that quietly drops one of its own writes would present as a smaller, safer
 * change than the one actually proposed.
 */
export function validateChange(change: ChangeSet): ValidatedChangeSet {
  const violations = checkProtectedPaths(
    change.writes.map((write) => write.path),
  );
  return { change, violations, acceptable: violations.length === 0 };
}

/** Why a change was refused, in one sentence. */
export function refusalReason(validation: ValidatedChangeSet): string {
  if (validation.acceptable) return '';
  const paths = validation.violations.map((violation) => violation.path);
  return (
    `Atlas will not modify its own safety layer. Refused: ${paths.join(', ')}.\n` +
    'This boundary is unconditional and cannot be approved, overridden, or ' +
    'relaxed by any setting.'
  );
}
