/**
 * Files Atlas may never modify in its own codebase.
 *
 * An explicit list, not a heuristic. A guess like "does this look like the
 * safety layer" can be defeated by a rename, a re-export, or a file that
 * happens not to match the pattern - and the failure mode is Atlas rewriting
 * the code that judges it. Enumerating the paths makes the boundary reviewable
 * and makes a new safety module fail closed until someone adds it here.
 *
 * This list is unconditional. No autonomy level, no setting, and no approval -
 * including this phase's own - can add to or remove from it.
 */

/** Directories whose contents are entirely off-limits. */
const PROTECTED_DIRECTORIES: readonly string[] = ['src/selfmod/', 'src/audit/'];

/** Individual files that are off-limits. */
const PROTECTED_FILES: readonly string[] = [
  // The permission engine and how danger is judged.
  'src/permissions/rule-engine.ts',
  'src/permissions/risk-classifier.ts',
  'src/permissions/rules.schema.ts',
  'src/permissions/default-rules.ts',
  'src/permissions/safe-bin-profiles.ts',
  'src/permissions/grant-store.ts',
  'src/permissions/sudoers-setup.ts',
  // Confirmation, autonomy, and the hard floor that outranks them.
  'src/permissions/confirmation-flow.ts',
  'src/permissions/autonomy.ts',
  'src/permissions/dry-run.ts',
  // The audit record itself, so history cannot be edited by the thing audited.
  'src/audit/audit-log.ts',
  'src/audit/audit-log.schema.ts',
];

/** Migrations that shape the permission or audit schema are also off-limits. */
const PROTECTED_MIGRATION_PATTERN =
  /^\d+_.*(permission|audit|autonomy).*\.sql$/;

export interface ProtectedPathViolation {
  readonly path: string;
  readonly reason: string;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Whether a path is off-limits, and why. */
export function checkProtectedPath(
  path: string,
): ProtectedPathViolation | undefined {
  const normalized = normalize(path);

  // Reject traversal out of a protected directory, e.g.
  // src/selfmod/../../src/audit/audit-log.ts.
  const segments: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  const resolved = segments.join('/');

  for (const directory of PROTECTED_DIRECTORIES) {
    if (resolved.startsWith(directory)) {
      return {
        path,
        reason: `${directory} is Atlas's own safety and audit layer.`,
      };
    }
  }
  if (PROTECTED_FILES.includes(resolved)) {
    return {
      path,
      reason:
        'This file decides what Atlas considers dangerous or how it records it.',
    };
  }
  if (
    resolved.startsWith('migrations/') &&
    PROTECTED_MIGRATION_PATTERN.test(resolved.slice('migrations/'.length))
  ) {
    return {
      path,
      reason: 'This migration defines the permission or audit schema.',
    };
  }
  return undefined;
}

/** Whether any path in a batch is off-limits. */
export function checkProtectedPaths(
  paths: readonly string[],
): readonly ProtectedPathViolation[] {
  return paths
    .map((path) => checkProtectedPath(path))
    .filter(
      (violation): violation is ProtectedPathViolation =>
        violation !== undefined,
    );
}

/** Whether a batch is entirely permitted. */
export function isProtectedChange(paths: readonly string[]): boolean {
  return checkProtectedPaths(paths).length > 0;
}

/** The list, exposed for review and for the tests that guard it. */
export function protectedPaths(): {
  readonly directories: readonly string[];
  readonly files: readonly string[];
} {
  return {
    directories: [...PROTECTED_DIRECTORIES],
    files: [...PROTECTED_FILES],
  };
}
