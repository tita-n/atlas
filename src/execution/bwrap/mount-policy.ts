/**
 * Turning a profile into a bubblewrap command line.
 *
 * Shape and ordering follow `codex-rs/linux-sandbox/src/bwrap.rs`, read rather
 * than guessed. Two things in it corrected assumptions worth recording:
 *
 *   1. The root is `--tmpfs /`, NOT `--ro-bind / /`. Starting empty and
 *      layering only approved read roots means the host's `/tmp`,
 *      `/run/user`, `/var/run/docker.sock` and everything else are simply not
 *      there, rather than present-and-then-masked. Deny lists are much easier
 *      to get wrong than allow lists.
 *   2. Deny masking is `--perms 000 --tmpfs PATH --remount-ro PATH`, not a
 *      bare `--tmpfs`: without the perms and the remount the mount point is
 *      writable enough to remove or unmount itself.
 *
 * `--cap-drop ALL` goes last, immediately before `--`, matching Codex: it
 * applies to the process about to be exec'd.
 *
 * seccomp is deliberately absent. `bwrap --seccomp FD` wants a compiled cBPF
 * program, Node cannot generate one, and Codex applies seccomp in-process
 * rather than through bwrap. Shipping an unvalidated filter against git, npm
 * and compilers would be worse than shipping none, so `seccomp: false` is
 * reported truthfully in the status line.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  protectedTargets,
  protectedGitTargets,
} from '../../safety/protected-targets.js';
import type { ProtectionProfile } from '../environment.js';

/**
 * System directories a sandboxed command may read.
 *
 * Codex calls these its "platform defaults" and the caution is worth keeping:
 * system paths only, never user data, so including them cannot quietly widen
 * access to `~/.ssh` or `~/.aws`.
 */
const SYSTEM_READ_ROOTS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc',
  '/run/alternatives',
  '/nix/store',
];

/**
 * Environment variables a sandboxed command may see.
 *
 * An allow list, not a deny list: `--clearenv` empties the environment and
 * only these are set back. Anything carrying a credential (`*_KEY`,
 * `*_TOKEN`, `*_SECRET`, `AWS_*`, `SSH_AUTH_SOCK`) is therefore absent by
 * construction rather than by remembering to exclude it.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'COLORTERM',
  'NO_COLOR',
  'CI',
  // Build tooling that fails without them and carries nothing secret.
  'NVM_BIN',
  'NODE_VERSION',
  'npm_config_cache',
  'npm_config_registry',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

export interface MountPolicy {
  readonly profile: ProtectionProfile;
  /** Directory the command starts in. */
  readonly cwd: string;
  /** Directories that may be written. */
  readonly writableRoots: readonly string[];
  readonly networkEnabled: boolean;
  /** Atlas state directory; never visible. */
  readonly atlasHome: string;
  /** Extra paths to hide, in addition to the ones Atlas always hides. */
  readonly alwaysHidden: readonly string[];
}

export interface BwrapCommand {
  readonly argv: readonly string[];
  /** Paths masked from view, recorded for the status line and the report. */
  readonly hiddenPaths: readonly string[];
}

/**
 * Host paths that must never be visible inside a sandbox.
 *
 * Split into "invisible because we start from an empty root" (true for all of
 * them here) and "invisible even if something binds its parent back in", which
 * is what the explicit masks below are for. The second list is defence in depth
 * against a future change that re-binds a broad root.
 */
function hostPathsToMask(userHome: string): readonly string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return [
    `${userHome}/.ssh`,
    `${userHome}/.aws`,
    `${userHome}/.gnupg`,
    `${userHome}/.config`,
    `${userHome}/.local/share/keyrings`,
    // Browser profiles hold live session cookies.
    `${userHome}/.mozilla`,
    `${userHome}/.config/google-chrome`,
    `${userHome}/.config/chromium`,
    // Session buses, systemd --user, and the display/agent sockets. All of
    // these are escape routes, not conveniences: D-Bus in particular can ask a
    // host service to do things the filesystem policy forbids.
    `/run/user/${uid}`,
    `/var/run/user/${uid}`,
    // Container runtimes reachable from inside are a sandbox in one command.
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/run/podman',
    '/run/user',
  ];
}

/** Environment variables the sandbox gets, filtered by the allow list. */
export function sandboxEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  // A PATH the model could influence would hand it a binary we did not vet.
  env['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env['HOME'] = env['HOME'] ?? '/tmp/atlas-home';
  return env;
}

/**
 * Binds a path that may be a symlink into the empty root.
 *
 * On Fedora `/bin`, `/sbin`, `/lib` and `/lib64` are symlinks into `/usr`. With
 * `--tmpfs /` the destination does not exist, so a plain `--ro-bind /bin /bin`
 * fails outright with "execvp /bin: No such file or directory". Bind the
 * resolved target and recreate the link, which is what `codex-rs` does when it
 * canonicalises symlinked paths. Skipping this would have meant every sandbox
 * command failing to start on a perfectly normal system.
 */
function bindReadable(args: string[], flag: string, rawPath: string): void {
  // Trailing separators matter here: realpath strips them, so `/a/b/` and
  // `/a/b` compare unequal and the code would try to replace a real directory
  // with a symlink, which bwrap refuses.
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  if (!existsSync(path)) return;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    args.push(flag, path, path);
    return;
  }
  if (real !== path) {
    args.push(flag, real, real);
    args.push('--symlink', real, path);
  } else {
    args.push(flag, path, path);
  }
}

/**
 * Builds the full bwrap argv for one command.
 *
 * The command is passed as an argv array and bwrap is spawned with
 * `shell: false`, so nothing on the way in is word-split or glob-expanded by a
 * host shell.
 */
export function buildBwrapCommand(
  policy: MountPolicy,
  bwrapPath: string,
  command: readonly string[],
): BwrapCommand {
  const cwd = resolve(policy.cwd);
  const args: string[] = [bwrapPath];

  // Order matters and is not arbitrary: session isolation first, then the
  // namespace isolation, then the filesystem, then the environment, then caps.
  args.push('--new-session');
  args.push('--die-with-parent');
  args.push('--unshare-user');
  // Blocks the sandbox from creating further user namespaces, which is what
  // `unshare -Ur`, nested bwrap and most mount tricks need.
  args.push('--disable-userns');
  args.push('--unshare-pid');
  args.push('--unshare-ipc');
  args.push('--unshare-uts');
  if (!policy.networkEnabled) args.push('--unshare-net');

  // An empty root. Nothing exists unless it is bound below.
  args.push('--tmpfs', '/');
  // Minimal devices only: null, zero, full, random, urandom, tty.
  args.push('--dev', '/dev');
  args.push('--proc', '/proc');
  // Private tmp, so the sandbox cannot see or interfere with the host's.
  args.push('--tmpfs', '/tmp');
  args.push('--tmpfs', '/var/tmp');
  // /home is an empty, LATER read-only tmpfs rather than a plain directory.
  //
  // `--dir /home` would be writable, and a writable /home lets a command
  // "succeed" at `echo x > ~/newfile` by creating a file in the sandbox's own
  // ephemeral tmpfs. The host is untouched, but the command reports success and
  // the file vanishes when the sandbox exits - a lie the model then builds on.
  // Read-only /home means only an explicitly bound path can be written.
  args.push('--tmpfs', '/home');

  for (const root of SYSTEM_READ_ROOTS) bindReadable(args, '--ro-bind', root);

  // The workspace is readable in every profile; writing is what differs.
  bindReadable(args, '--ro-bind', cwd);

  const writableRoots =
    policy.profile === 'workspace-write' ? policy.writableRoots : [];
  for (const root of writableRoots) {
    bindReadable(args, '--bind', resolve(root));
  }

  // Re-apply read-only protections INSIDE anything now writable. This is the
  // step that stops a workspace containing Atlas's own repo from making
  // src/permissions/**, dist/**, or the git hook directory writable.
  const hiddenPaths: string[] = [];
  for (const root of writableRoots) {
    for (const target of protectedSubpathsIn(resolve(root), policy)) {
      bindReadable(args, '--ro-bind', target);
      hiddenPaths.push(target);
    }
  }

  // Explicit masks for host paths that must never appear. With an empty root
  // these are already absent; the masks make that true even if a future change
  // binds a broad parent back in.
  //
  // Nested masks are dropped: once `~/.config` has been replaced by an empty
  // tmpfs, creating a mount point inside it fails with EROFS, and the child
  // mask adds nothing the parent does not already provide.
  const userHome = process.env['HOME'] ?? '/root';
  const masked: string[] = [];
  for (const path of [...hostPathsToMask(userHome), ...policy.alwaysHidden]) {
    if (!existsSync(path)) continue;
    if (masked.some((parent) => path === parent || path.startsWith(`${parent}/`))) {
      continue;
    }
    args.push('--perms', '000', '--tmpfs', path, '--remount-ro', path);
    masked.push(path);
    hiddenPaths.push(path);
  }

  args.push('--chdir', cwd);
  // Clear the environment, then set back only what the allow list permits.
  args.push('--clearenv');
  // Nothing outside a writable root may be written, and /home is not one.
  args.push('--remount-ro', '/home');
  for (const [name, value] of Object.entries(sandboxEnv())) {
    args.push('--setenv', name, value);
  }
  // Must be immediately before `--`: it applies to the process being exec'd.
  args.push('--cap-drop', 'ALL');
  args.push('--');
  args.push(...command);

  return { argv: args, hiddenPaths };
}

/**
 * Protected paths that live inside a writable root.
 *
 * Derived from the same list the file tools consult, so the mount policy and
 * the tool-level refusal can never disagree about what is off-limits.
 */
function protectedSubpathsIn(
  root: string,
  policy: MountPolicy,
): readonly string[] {
  const targets = [
    ...protectedTargets(policy.atlasHome),
    ...protectedGitTargets(root),
  ];
  const inside = targets
    .filter((target) => target.path.startsWith(`${root}/`))
    // The install root as a whole is only protected when it is NOT the
    // workspace. When the workspace *is* Atlas's own repo, re-binding the root
    // read-only here would make the entire workspace unwritable - including
    // the parts the user explicitly trusted - and the individual
    // src/permissions and dist entries below are what actually need pinning.
    .filter((target) => target.path !== root)
    .map((target) => target.path);
  // Longest first: binding a parent read-only and then a child writable would
  // undo the protection, so the deepest paths have to land first.
  return [...new Set(inside)].sort((a, b) => b.length - a.length);
}

/** The bash argv a sandboxed session runs, matching ShellSession's defaults. */
export const SANDBOXED_SHELL: readonly string[] = [
  '/bin/bash',
  '--noprofile',
  '--norc',
];