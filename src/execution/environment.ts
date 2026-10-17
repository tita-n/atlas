/**
 * Where a command actually runs.
 *
 * Until this existed, `ShellSession` owned a host bash process and every
 * caller assumed it. That assumption is the structural ceiling the evaluation
 * found: the gate classifies command TEXT, while the catastrophic part of
 * `cd /; rm -rf *` is the shell's working directory - process state the text
 * does not contain - and a base64 pipe turns the payload into DATA the text
 * never spells out. No number of patterns closes that gap, because the gap is
 * not in the patterns.
 *
 * So the boundary moves to the environment. This interface is the seam:
 * `local` is today's host shell, explicitly labelled degraded, and `bwrap` is
 * a kernel-isolated environment where the classification stops being the only
 * thing standing between the model and the filesystem.
 *
 * Deliberately narrow. A Docker, Podman or macOS Seatbelt backend is a new
 * implementation of this interface and nothing else; no other code changes.
 */

import type { CommandResult } from '../shell/command-result.js';

/**
 * How much of the filesystem and network an environment exposes.
 *
 * These names are the user's mental model, so they say what is permitted
 * rather than how it is enforced.
 */
export type ProtectionProfile =
  | 'read-only'
  | 'workspace-write'
  | 'full-access';

/** Profiles that actually confine anything. `full-access` confines nothing. */
export const CONFINING_PROFILES: readonly ProtectionProfile[] = [
  'read-only',
  'workspace-write',
];

/**
 * Parses a profile name from the environment.
 *
 * An `as` cast performs no validation: `ATLAS_SANDBOX_PROFILE=bogus` would flow
 * through as a value that satisfies the type but not the runtime, and only be
 * rejected later when the audit schema refused the append - mid-turn, far from
 * the cause. Refusing it here names the variable and the legal values.
 */
export function parseProfile(
  value: string | undefined,
): ProtectionProfile | undefined {
  if (value === undefined || value === '') return undefined;
  if ((CONFINING_PROFILES as readonly string[]).includes(value) || value === 'full-access') {
    return value as ProtectionProfile;
  }
  throw new Error(
    `ATLAS_SANDBOX_PROFILE must be one of read-only, workspace-write, ` +
      `full-access; got ${JSON.stringify(value)}`,
  );
}

/**
 * What kind of isolation is actually active.
 *
 *   - `bwrap`    a real kernel sandbox.
 *   - `refusing` no sandbox is available, so only provably read-only commands
 *                run and everything else is refused. This is the fail-closed
 *                state: it gives up usefulness, never safety.
 *   - `local`    a host shell with no boundary at all. Reachable ONLY through
 *                the explicit full-access ceremony, never as a silent fallback
 *                from an unavailable sandbox.
 */
export type ExecutionBackend = 'local' | 'bwrap' | 'refusing';

/**
 * A single line describing the protection in force.
 *
 * Shown at startup, in the TUI status bar, and by `atlas status`. It must be
 * true in every part: a status line that says "sandboxed" while the sandbox is
 * unavailable is the exact failure this interface exists to prevent.
 */
export interface ExecutionStatus {
  readonly backend: ExecutionBackend;
  readonly profile: ProtectionProfile;
  /** Directories the command may write to. Empty means nothing is writable. */
  readonly writableRoots: readonly string[];
  readonly networkEnabled: boolean;
  /** False when running unsandboxed, whatever the profile says. */
  readonly sandboxed: boolean;
  /**
   * Whether a seccomp filter is loaded.
   *
   * Reported separately from `sandboxed` because shipping without one is an
   * honest, acceptable choice, while claiming one that is not there is not.
   */
  readonly seccomp: boolean;
  /** Why the backend degraded, or undefined when it did not. */
  readonly degradedReason?: string | undefined;
}

/** One persistent execution context: a place commands run and state persists. */
export interface ExecutionSession {
  /**
   * The directory commands actually run in.
   *
   * Not the Node process cwd: a long-lived shell may have `cd`-ed, and
   * permission grants bind to this value.
   */
  readonly currentDirectory: string;
  /** Whether the underlying process is available right now. */
  readonly running: boolean;
  execute(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CommandResult>;
  /** Tears the process down and starts a fresh one in the same directory. */
  restart(): void;
  close(): void;
}

/** An environment the assistant can ask to run a command in. */
export interface ExecutionEnvironment {
  readonly status: ExecutionStatus;
  /** One honest sentence about the protection in force. */
  describe(): string;
  createSession(options?: ExecutionSessionOptions): ExecutionSession;
}

export interface ExecutionSessionOptions {
  /** Directory the session starts in. Defaults to the process cwd. */
  readonly cwd?: string | undefined;
  /** Default per-command timeout. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Whether an environment confines the filesystem at all.
 *
 * Anything that needs a real answer to "what can this command reach" asks
 * this rather than checking a backend name, so adding a backend cannot
 * silently degrade to "as if it were sandboxed".
 */
export function confinesFilesystem(
  environment: ExecutionEnvironment,
): boolean {
  return environment.status.sandboxed;
}

/**
 * Renders a status as the single line shown to the user.
 *
 * When the sandbox is not actually confining, the degraded reason is part of
 * this line rather than a separate warning. A status line that reports
 * "SANDBOX OFF" without saying what that means leaves the user to guess, and
 * the guess they are most likely to make - "so it is fine" - is the wrong one.
 */
export function describeStatus(status: ExecutionStatus): string {
  const parts: string[] = [];
  if (status.backend === 'refusing') {
    // A distinct word, not "SANDBOX OFF": this state does not run arbitrary
    // commands on the host, it refuses them. Calling it the same thing as
    // full-access would hide the one fact the user needs.
    parts.push('SANDBOX UNAVAILABLE (refusing, degraded)');
  } else if (!status.sandboxed) {
    parts.push(`SANDBOX OFF (${status.backend}, degraded)`);
  } else {
    parts.push(`sandbox: ${status.backend}`);
  }
  parts.push(`profile: ${status.profile}`);
  parts.push(
    status.writableRoots.length === 0
      ? 'writable: none'
      : `writable: ${status.writableRoots.join(', ')}`,
  );
  parts.push(`network: ${status.networkEnabled ? 'on' : 'off'}`);
  parts.push(`seccomp: ${status.seccomp ? 'on' : 'off'}`);
  const line = parts.join(' | ');
  return status.degradedReason === undefined
    ? line
    : `${line} -- ${status.degradedReason}`;
}