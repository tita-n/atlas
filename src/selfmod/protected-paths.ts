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

/**
 * Canonicalises a repo-relative path for comparison.
 *
 * Lowercased as well as normalised: the same file can be spelled
 * `SRC/AUDIT/audit-log.ts` and still resolve to the protected file on a
 * case-insensitive filesystem, so a boundary that only matched one casing would
 * hold on Linux and fail on a colleague's Mac.
 */
function normalize(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.toLowerCase();
}

const WINDOWS_DRIVE = /^[A-Za-z]:\//;

/**
 * Resolves a repo-relative spelling to one canonical form, or explains why it
 * cannot be checked.
 *
 * The list below is spelled repo-relative. A path that is absolute, Windows-
 * rooted, or climbs out of the repository cannot be compared against it without
 * knowing where the repo is, so it is refused outright rather than guessed at:
 * an uncheckable path must fail closed, or the boundary is a spelling exercise.
 */
function resolvePath(
  path: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (path.trim() === '')
    return { ok: false, reason: 'The write has no path.' };
  const normalized = normalize(path);
  // Count the real segments before `..` is collapsed, so an over-traversal is
  // detectable afterwards.
  const rawDepth = normalized
    .split('/')
    .filter((part) => part !== '.' && part !== '' && part !== '..').length;
  if (normalized.startsWith('/') || WINDOWS_DRIVE.test(normalized)) {
    return {
      ok: false,
      reason:
        'A change must name repo-relative paths. An absolute path cannot be ' +
        'checked against the protected list.',
    };
  }
  // Collapse traversal, so `src/selfmod/../audit/audit-log.ts` is compared as
  // the file it actually is. Climbing above the repository root is refused:
  // `../repo/src/audit/audit-log.ts` names a real protected file while looking
  // like it points nowhere.
  const segments: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (segments.pop() === undefined) {
        return { ok: false, reason: 'The path climbs out of the repository.' };
      }
    } else segments.push(part);
  }
  // Still escaping after collapsing means the `..` outnumbered the real
  // segments: `src/selfmod/../../audit/x` must not quietly resolve to
  // `audit/x` and slip past a repo-relative list.
  if (rawDepth > segments.length) {
    return { ok: false, reason: 'The path climbs out of the repository.' };
  }
  if (segments.length === 0) {
    return { ok: false, reason: 'The write has no path.' };
  }
  return { ok: true, resolved: segments.join('/') };
}

/** Whether a path is off-limits, and why. */
export function checkProtectedPath(
  path: string,
): ProtectedPathViolation | undefined {
  const resolution = resolvePath(path);
  if (!resolution.ok) return { path, reason: resolution.reason };
  const resolved = resolution.resolved;

  for (const directory of PROTECTED_DIRECTORIES) {
    if (resolved.startsWith(directory) || resolved === directory.slice(0, -1)) {
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
