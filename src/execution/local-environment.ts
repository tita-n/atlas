/**
 * The local backend: a host bash process, and nothing between it and the disk.
 *
 * This is `full-access` and only `full-access`. It used to be the silent
 * fallback when a sandbox could not be built, which meant a machine with no
 * working bubblewrap ran every command on the host while the status bar said
 * "full-access" as if the user had chosen it. It is now reachable only through
 * the deliberate-friction ceremony (`full-access.ts`); an unavailable sandbox
 * degrades to the refusing state instead.
 *
 * Every `ExecutionStatus` it produces says `sandboxed: false`, and the caller is
 * expected to say so out loud: an unsandboxed environment that does not announce
 * itself is the failure mode that matters.
 */

import { ShellSession } from '../shell/shell-session.js';
import {
  describeStatus,
  type ExecutionEnvironment,
  type ExecutionSession,
  type ExecutionSessionOptions,
  type ExecutionStatus,
  type ProtectionProfile,
} from './environment.js';

export interface LocalEnvironmentOptions {
  /** Why this backend was chosen, shown whenever it is reported. */
  readonly degradedReason?: string | undefined;
  readonly profile?: ProtectionProfile | undefined;
  readonly networkEnabled?: boolean | undefined;
  readonly writableRoots?: readonly string[] | undefined;
}

/**
 * The sentence the user sees when Atlas is running unsandboxed.
 *
 * Says what is true AND what follows from it: not just "no sandbox", but that
 * the remaining protection is a heuristic. "degraded" on its own would be a
 * word; the consequence is the information.
 */
export const FULL_ACCESS_NOTICE =
  'full access: no sandbox. Commands run directly on this computer, and the ' +
  'text-based safety checks are a best-effort heuristic that is known to be ' +
  'bypassable.';

export class LocalEnvironment implements ExecutionEnvironment {
  readonly status: ExecutionStatus;

  public constructor(options: LocalEnvironmentOptions = {}) {
    const reason =
      options.degradedReason ?? FULL_ACCESS_NOTICE;
    this.status = {
      backend: 'local',
      // full-access, not workspace-write: this backend has no boundary, so
      // claiming a narrower profile would be a lie the status bar repeats.
      profile: options.profile ?? 'full-access',
      writableRoots: options.writableRoots ?? [],
      networkEnabled: options.networkEnabled ?? true,
      sandboxed: false,
      seccomp: false,
      degradedReason: reason,
    };
  }

  public describe(): string {
    // `describeStatus` already appends `-- ${degradedReason}` for an
    // unsandboxed status, and `#notice` is that same string. Appending it here
    // as well printed the reason twice.
    return describeStatus(this.status);
  }

  public createSession(
    options: ExecutionSessionOptions = {},
  ): ExecutionSession {
    return new ShellSession({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
}