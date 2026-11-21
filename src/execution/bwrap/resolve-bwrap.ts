/**
 * Finding and sanity-checking bubblewrap.
 *
 * Every path here is absolute and hard-coded. Resolving `bwrap` through `$PATH`
 * would mean running whichever file an attacker - or an accidental `npm
 * install` - put first, from inside the directory we are trying to confine.
 * There is no `$PATH` search, and there is no fallback to a relative name.
 */

import { existsSync as fsExistsSync } from 'node:fs';

/** Locations checked, in order. Fixed, not derived from the environment. */
const CANDIDATE_PATHS: readonly string[] = [
  '/usr/bin/bwrap',
  '/bin/bwrap',
  '/usr/local/bin/bwrap',
  '/run/current-system/sw/bin/bwrap',
];

export interface BwrapResolution {
  readonly ok: boolean;
  readonly path?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * Locates bwrap at a fixed absolute path.
 *
 * Separated from the usability probe on purpose: "the file is there" and "the
 * kernel lets us use it" are different questions, and a backend that conflates
 * them reports a sandbox it does not have.
 */
export function resolveBwrapPath(
  exists: (path: string) => boolean = defaultExists,
): BwrapResolution {
  for (const path of CANDIDATE_PATHS) {
    if (exists(path)) return { ok: true, path };
  }
  return {
    ok: false,
    reason:
      'bubblewrap was not found at any of: ' +
      CANDIDATE_PATHS.join(', ') +
      '. Install bubblewrap, or run Atlas where it is available.',
  };
}

function defaultExists(path: string): boolean {
  // Not `require`: this is an ES module and `require` is not defined in it, so
  // the first version of this function silently answered "bwrap is not
  // installed" on a host where it plainly was.
  return fsExistsSync(path);
}

/**
 * Checks that bwrap exists AND that unprivileged user namespaces work here.
 *
 * The second half is not optional. On hosts with `user.max_user_namespaces=0`,
 * or a restrictive seccomp/AppArmor profile, the binary is present and every
 * invocation fails at startup. Probing up front is what lets Atlas degrade
 * loudly at launch instead of failing on the first command the user runs.
 */
export async function probeBwrap(
  path: string,
  run: (argv: readonly string[]) => Promise<{ code: number | null; stderr: string }>,
): Promise<BwrapResolution> {
  // The smallest invocation that still exercises the namespace machinery:
  // unshare everything, give the sandbox a root to exist in, run `true`.
  //
  // Only /usr is bound first, and the command is an absolute path under it.
  // Binding /bin as well fails on distros where /bin is a symlink into /usr,
  // and probing must not depend on the host's directory layout to succeed.
  //
  // /lib64 is recreated as a symlink because the dynamic loader is reached by
  // that absolute path on Fedora. Without it execvp fails with ENOENT even
  // though the binary is plainly there, which looks exactly like a broken
  // kernel and would have produced a false "sandbox unavailable" verdict.
  //
  // Two attempts, because the FIRST failure mode seen in the field was not a
  // broken kernel: the probe binary itself was missing from the layout
  // (`execvp /usr/bin/true: No such file or directory`) while bwrap worked
  // perfectly. That must not be reported as "bwrap cannot create a sandbox", so
  // a missing probe binary falls through to the next candidate rather than
  // condemning the backend.
  const base = [
    path,
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-net',
    '--disable-userns',
    '--new-session',
    '--tmpfs',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    '/usr/lib64',
    '/lib64',
  ];
  const attempts: readonly { extra: readonly string[]; binary: string }[] = [
    { extra: [], binary: '/usr/bin/true' },
    // Last resort on a host whose `true` lives under /bin rather than /usr/bin.
    { extra: ['--ro-bind', '/bin', '/bin'], binary: '/bin/true' },
  ];
  let lastStderr = '';
  for (const attempt of attempts) {
    const result = await run([
      ...base,
      ...attempt.extra,
      '--cap-drop',
      'ALL',
      '--',
      attempt.binary,
    ]);
    if (result.code === 0) return { ok: true, path };
    lastStderr = result.stderr.trim();
    // A missing probe binary is not a verdict about bwrap. Try the next one.
    if (isMissingProbeBinary(lastStderr)) continue;
    // A real namespace/seccomp/security failure will not be fixed by a
    // different binary, so stop and report it.
    break;
  }
  if (isMissingProbeBinary(lastStderr)) {
    return {
      ok: false,
      reason:
        'bubblewrap is installed but no probe binary could be executed ' +
        'inside it (' +
        lastStderr +
        '). The sandbox could not be verified, so Atlas will not use it.',
    };
  }
  return {
    ok: false,
    reason:
      'bubblewrap is installed but cannot create a sandbox on this host' +
      (lastStderr === '' ? '.' : `: ${lastStderr}`),
  };
}

/**
 * Whether bwrap started but could not exec the probe binary.
 *
 * Distinct from a namespace failure on purpose: one means "bwrap is broken",
 * the other means "this host puts `true` somewhere else". Reporting the second
 * as the first marks a working sandbox unavailable.
 */
function isMissingProbeBinary(stderr: string): boolean {
  return (
    /execvp\b.*: No such file or directory/.test(stderr) ||
    /Can't bind mount .* on .*: No such file or directory/.test(stderr)
  );
}