/**
 * The harness-start guard.
 *
 * The disaster this exists to prevent already happened once: a
 * `workspace-write` test ran against the REAL repository, the sandbox bound it
 * read-write, and a destructive command in the test deleted `.git` while the
 * work was uncommitted. The outer-container rule was in the design, but the
 * test bypassed it and invoked the sandbox directly against the real path.
 *
 * So the rule is mechanical rather than a convention: every path the harness
 * will bind read-write, or treat as a target, must be inside the disposable run
 * directory, and must NOT be inside the real repository or the real home. If
 * either check fails the harness refuses to start rather than "being careful".
 *
 * `REAL_*` are deliberately hard-coded rather than derived from `$HOME` or the
 * cwd: deriving them means a run launched from the wrong directory silently
 * moves the boundary. Hard-coded constants cannot be fooled by an environment
 * variable, and the guard self-test proves they refuse the real paths.
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';

export const REAL_REPO = '/home/titan/atlas';
export const REAL_HOME = '/home/titan';
export const REAL_BACKUP = '/home/titan/atlas-backup-20261016';

/**
 * Everything the harness may write lives under here. Nothing else may.
 *
 * Deliberately NOT under /tmp: /tmp is a tmpfs on this host and the machine
 * reboots most days (Nov 6 17:42, Nov 9, 10, 11 x2, 12, 13 all cleared it),
 * which destroyed this harness twice. The run root lives on disk under the
 * home directory instead - hard-coded like the REAL_* constants above, so no
 * environment variable can move the boundary.
 */
export const DISPOSABLE_ROOT = '/home/titan/atlas-evidence-20261113/run-integration-final-20261121';

/** The forbidden prefixes, in the order they are reported. */
const FORBIDDEN = [
  ['the real repository', REAL_REPO],
  ['the real home directory', REAL_HOME],
  ['the Step 0 backup', REAL_BACKUP],
];

/** Resolves as far as the path exists, so symlink tricks do not dodge a check. */
function resolveForCheck(target) {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    // Does not exist yet: resolve the longest existing prefix and re-append.
    let prefix = absolute;
    const tail = [];
    for (;;) {
      const parent = path.dirname(prefix);
      if (parent === prefix) return absolute;
      tail.unshift(path.basename(prefix));
      prefix = parent;
      try {
        return path.join(realpathSync(prefix), ...tail);
      } catch {
        if (parent === prefix) return absolute;
      }
    }
  }
}

/**
 * Throws unless `target` is a safe, disposable path.
 *
 * Both halves are required: being under the disposable root is not enough on
 * its own (a symlink could point out of it), and being outside the real repo is
 * not enough on its own (writing to `/etc` is not a test).
 */
export function assertDisposable(target, label = 'target') {
  const resolved = resolveForCheck(target);
  const insideRun =
    resolved === DISPOSABLE_ROOT || resolved.startsWith(`${DISPOSABLE_ROOT}${path.sep}`);
  for (const [name, bad] of FORBIDDEN) {
    // The run root itself now lives under the real home (see DISPOSABLE_ROOT:
    // /tmp is tmpfs and reboots destroyed the harness twice), so the home
    // rule exempts exactly that hard-coded subtree and refuses every other
    // path under $HOME - including all of the real repository.
    if (name === 'the real home directory' && insideRun) continue;
    if (resolved === bad || resolved.startsWith(`${bad}${path.sep}`)) {
      throw new Error(
        `REFUSING: ${label} resolves to ${resolved}, inside ${name} (${bad}). ` +
          'The harness only operates on a disposable copy; point it at ' +
          `${DISPOSABLE_ROOT} instead.`,
      );
    }
  }
  const root = resolveForCheck(DISPOSABLE_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `REFUSING: ${label} resolves to ${resolved}, which is outside the ` +
        `disposable run directory (${root}). The harness must not create, ` +
        'bind, or delete anything outside it.',
    );
  }
  return resolved;
}

/** Convenience for the many paths derived from one work directory. */
export function assertWorkDir(workDir) {
  return assertDisposable(workDir, 'work directory');
}
