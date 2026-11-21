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
 *   - No working sandbox     -> a REFUSING environment: read-only commands
 *     run, everything else is refused. It never runs arbitrary commands on
 *     the host while reporting a profile that implies they are confined.
 *   - `full-access` (explicit ceremony only) -> the local backend, loudly.
 *
 * The middle case is the fix for the fail-open: degrading used to hand back a
 * host shell labelled `full-access`, and that shell really wrote to the real
 * filesystem. "Less protection, visibly" is acceptable; "less protection,
 * invisibly, while claiming confinement" is the bug this ordering removes.
 */

import { platform } from 'node:os';

import type {
  ExecutionEnvironment,
  ProtectionProfile,
} from './environment.js';
import { loadFullAccessGrant } from './full-access.js';
import { LocalEnvironment } from './local-environment.js';
import { RefusingEnvironment } from './refusing-environment.js';
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
   * This is a REQUEST, not a grant: the resolver honours it only when the
   * tamper-evident full-access record exists (`atlas full-access enable`).
   * Otherwise it refuses, so exporting a variable cannot silently unlock a bare
   * host shell.
   */
  readonly forceLocal?: boolean | undefined;
  /**
   * Override the bubblewrap binary path. Test seam: a non-executable path
   * exercises the unavailable-sandbox path on a host that has one.
   */
  readonly bwrapPath?: string | undefined;
}

/** Resolves the environment, or explains why it degraded. */
export async function resolveExecutionEnvironment(
  options: ExecutionEnvironmentOptions,
): Promise<ExecutionEnvironment> {
  const profile: ProtectionProfile = options.profile ?? 'read-only';

  if (options.forceLocal === true || profile === 'full-access') {
    // The ceremony, not the environment variable, is what enables this. The
    // env var / profile because it is easy to export once and forget; the
    // tamper-evident record because consent must survive exactly as long as it
    // was meant to and no longer.
    const grant = await loadFullAccessGrant(options.atlasHome);
    if (grant === null) {
      // Requested but not enabled: fail closed into the refusing state with an
      // instruction, rather than honouring the request. Honouring it silently is
      // how "I set a variable" becomes "I ran unsandboxed for a week".
      return new RefusingEnvironment({
        cwd: options.cwd,
        reason:
          'full access was requested but has not been enabled. Run ' +
          '"atlas full-access enable" and type the confirmation phrase first.',
      });
    }
    return new LocalEnvironment({
      degradedReason:
        'full-access enabled: Atlas is running with no sandbox. The ' +
        'text-based safety checks are a best-effort heuristic and are known ' +
        'to be bypassable in this mode.',
      profile: 'full-access',
      writableRoots: [],
      networkEnabled: true,
    });
  }

  if (platform() !== 'linux') {
    // No sandbox backend here at all, so fail closed rather than run on the
    // host. The explicit full-access ceremony above is the only way to a
    // bare host shell.
    return new RefusingEnvironment({
      cwd: options.cwd,
      reason:
        `no sandbox backend is available on ${platform()}. ` +
        'Only read-only commands will run.',
    });
  }

  try {
    return await BwrapEnvironment.create({
      profile,
      cwd: options.cwd,
      atlasHome: options.atlasHome,
      ...(options.bwrapPath === undefined ? {} : { bwrapPath: options.bwrapPath }),
      ...(options.writableRoots === undefined
        ? {}
        : { writableRoots: options.writableRoots }),
      ...(options.networkEnabled === undefined
        ? {}
        : { networkEnabled: options.networkEnabled }),
    });
  } catch (error) {
    // Degraded, but into a REFUSING state, never into a bare host shell. The
    // reason travels into the status line, the status bar, `atlas status`, and
    // every refusal the user hits.
    return new RefusingEnvironment({
      cwd: options.cwd,
      reason: `sandbox unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}