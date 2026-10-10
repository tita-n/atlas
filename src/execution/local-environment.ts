/**
 * The local backend: a host bash process, and nothing between it and the disk.
 *
 * Kept because it is what Atlas always did and because `full-access` needs
 * something to be. Every `ExecutionStatus` it produces says `sandboxed: false`,
 * and the caller is expected to say so out loud: an unsandboxed environment
 * that does not announce itself is the failure mode that matters.
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
  /** Why this backend was chosen, shown when it is degraded. */
  readonly degradedReason?: string | undefined;
  readonly profile?: ProtectionProfile | undefined;
  readonly networkEnabled?: boolean | undefined;
  readonly writableRoots?: readonly string[] | undefined;
}

/**
 * The sentence the user sees when Atlas is running unsandboxed.
 *
 * Says what is true and what follows from it. "degraded" on its own would be a
 * word; the consequence is the information.
 */
export const DEGRADED_MODE_NOTICE =
  'sandbox unavailable: dangerous commands will be refused, not sandboxed.';

export class LocalEnvironment implements ExecutionEnvironment {
  readonly status: ExecutionStatus;
  readonly #notice: string | undefined;

  public constructor(options: LocalEnvironmentOptions = {}) {
    const reason =
      options.degradedReason ?? DEGRADED_MODE_NOTICE;
    this.#notice = reason;
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
    return `${describeStatus(this.status)}. ${this.#notice ?? ''}`.trim();
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