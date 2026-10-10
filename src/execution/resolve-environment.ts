/**
 * Choosing where a command runs, and refusing when the answer is not good.
 *
 * This is the only function that decides between a real sandbox and none. It
 * exists as one function because "which backend am I on" was previously spread
 * across two front-ends that could disagree, and a disagreement here is a
 * silent loss of protection rather than a visible failure.
 *
 * The policy, in full:
 *
 *   - Linux + a working bubblewrap -> sandbox, read-only by default.
 *   - Anything else -> the local backend, explicitly degraded, with the
 *     degraded-mode notice printed at startup and reported in every status.
 *   - Never: silently running on the host while reporting a profile that
 *     implies confinement.
 */

import { platform } from 'node:os';

import type {
  ExecutionEnvironment,
  ProtectionProfile,
} from './environment.js';
import { LocalEnvironment } from './local-environment.js';
import { BwrapEnvironment } from './bwrap/bwrap-environment.js';

export interface ExecutionEnvironmentOptions {
  /** Directory the session works in. */
  readonly cwd: string;
  /** Atlas state directory; never visible inside a sandbox. */
  readonly atlasHome: string;
  /** Requested profile. `read-only` is the default for an untrusted directory. */
  readonly profile?: ProtectionProfile | undefined;
  readonly writableRoots?: readonly string[] | undefined;
  readonly networkEnabled?: boolean | undefined;
  /**
   * Force the local backend even where a sandbox is available.
   *
   * The `full-access` profile. It is not a way to skip the degraded-mode notice
   * for an unavailable sandbox: that path always degrades and always says so.
   */
  readonly forceLocal?: boolean | undefined;
}

/** Resolves the environment, or explains why it degraded. */
export async function resolveExecutionEnvironment(
  options: ExecutionEnvironmentOptions,
): Promise<ExecutionEnvironment> {
  const profile: ProtectionProfile = options.profile ?? 'read-only';

  if (options.forceLocal === true || profile === 'full-access') {
    return new LocalEnvironment({
      degradedReason:
        'full-access selected: Atlas is running with no sandbox. The ' +
        'text-based safety checks are a best-effort heuristic and are known ' +
        'to be bypassable in this mode.',
      profile: 'full-access',
      writableRoots: [],
      networkEnabled: true,
    });
  }

  if (platform() !== 'linux') {
    return new LocalEnvironment({
      degradedReason:
        `sandbox unavailable on ${platform()}: dangerous commands will be ` +
        'refused, not sandboxed.',
    });
  }

  try {
    return await BwrapEnvironment.create({
      profile,
      cwd: options.cwd,
      atlasHome: options.atlasHome,
      ...(options.writableRoots === undefined
        ? {}
        : { writableRoots: options.writableRoots }),
      ...(options.networkEnabled === undefined
        ? {}
        : { networkEnabled: options.networkEnabled }),
    });
  } catch (error) {
    // Degraded, but never silently: the reason travels into the status line,
    // the status bar, and `atlas status`.
    return new LocalEnvironment({
      degradedReason: `sandbox unavailable: ${
        error instanceof Error ? error.message : String(error)
      } Dangerous commands will be refused, not sandboxed.`,
    });
  }
}