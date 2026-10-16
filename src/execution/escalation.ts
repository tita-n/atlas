/**
 * Asking for more than the current profile allows.
 *
 * Four escalations exist, and they are not variations on one another:
 *
 *   - `extra-writable-root`  a directory outside the workspace
 *   - `network`              reaching the network from inside the sandbox
 *   - `unsandboxed`          running with no sandbox at all
 *   - `root`                 running as root, which cannot work inside
 *                            `no_new_privs` and is a separate mechanism
 *
 * The policy, in full, and the reasoning:
 *
 *   **Escalating out of the sandbox always asks, even under Unattended.**
 *   Autonomy means "work without interrupting me". It does not mean "decide on
 *   my behalf to remove the boundary". A model that can talk itself past the
 *   sandbox during an unattended run has turned a convenience setting into a
 *   remote-control.
 *
 *   **A durable grant widens mounts; it never removes the sandbox.** "Allow
 *   this directory forever" and "allow everything forever" are different
 *   requests, and only the first is a grant.
 *
 *   **Escalations queue under Unattended rather than stalling the task.** A
 *   run that stops dead on every network call is not unattended work, it is a
 *   hung process. So the work continues inside the sandbox and the
 *   out-of-sandbox requests accumulate into one summary the user answers once.
 *
 * This is deliberately a policy module with no I/O of its own: it decides, and
 * the caller asks. Keeping the decision separate is what lets it be tested
 * without a terminal.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { contains } from '../safety/protected-targets.js';

import type { ProtectionProfile } from './environment.js';

/** What is being asked for. */
export type EscalationKind =
  | 'extra-writable-root'
  | 'network'
  | 'unsandboxed'
  | 'root';

export interface EscalationRequest {
  readonly kind: EscalationKind;
  /** The command that needs it, for the prompt and the audit row. */
  readonly command: string;
  /** Paths involved, for `extra-writable-root`. */
  readonly paths?: readonly string[] | undefined;
  /** Human-readable summary of what is being asked. */
  readonly detail: string;
}

/** What the user chose when asked. */
export type EscalationDecision =
  | 'allow-once'
  | 'allow-always'
  | 'deny';

/** The result of applying a decision to the environment. */
export interface EscalationOutcome {
  readonly allowed: boolean;
  /** True when the command must run OUTSIDE the sandbox to do what was asked. */
  readonly escalated: boolean;
  /**
   * Roots for a DURABLE grant. The caller persists these.
   *
   * Always a superset of what was already writable: a grant adds to the mount
   * set and never replaces it, so approving `/data` cannot quietly revoke the
   * workspace.
   */
  readonly widenedRoots: readonly string[];
  /**
   * Roots for THIS command only. Never persisted.
   *
   * Separate from `widenedRoots` because collapsing the two is how an
   * "allow once" silently becomes "allow forever" - or how an "allow once" is
   * approved, discarded, and the command then fails for a reason the user was
   * never shown.
   */
  readonly onceRoots: readonly string[];
  readonly networkEnabled: boolean;
  /**
   * Whether the network grant is durable.
   *
   * Separate from `networkEnabled` because "allow once" and "allow always"
   * both turn the network on for the command in hand, and only the caller can
   * act on the difference. Without this a durable network grant was silently
   * indistinguishable from a one-off, so `allow-always` was a no-op for the one
   * kind where it could not be folded into `widenedRoots`.
   */
  readonly durableNetwork: boolean;
  readonly gatePath:
    | 'escalated-out-of-sandbox'
    | 'auto-allow-sandboxed'
    | 'denied-hard-floor'
    | 'denied-by-user';
}

/**
 * Whether this escalation may be satisfied by a durable grant.
 *
 * Only the two that genuinely WIDEN a sandbox qualify. `unsandboxed` is not a
 * grant: "allow no sandbox from now on" is not a narrower request than the one
 * the user was just asked about - it is the absence of the boundary, and a
 * durable one of those is how a single careless click becomes permanent.
 *
 * `root` is not a grant either. It is not a mount question, and re-running the
 * ceremony per command would be theatre.
 */
export function isGrantable(kind: EscalationKind): boolean {
  return kind === 'extra-writable-root' || kind === 'network';
}

/**
 * Whether the request takes the command out of the sandbox entirely.
 *
 * Network and an extra root do NOT: both are still confined, just less
 * tightly. Only `unsandboxed` (and `root`, which runs through sudo outside)
 * actually leaves the boundary, which is why the audit row distinguishes them.
 */
export function leavesSandbox(kind: EscalationKind): boolean {
  return kind === 'unsandboxed' || kind === 'root';
}

/** The phrase shown when the escalated command actually runs. */
export function describeEscalation(
  request: EscalationRequest,
): string {
  switch (request.kind) {
    case 'extra-writable-root':
      return `Allow writing outside the workspace to: ${(request.paths ?? []).join(', ')}`;
    case 'network':
      return 'Allow this command to use the network';
    case 'unsandboxed':
      return 'Run this command with NO sandbox';
    case 'root':
      return 'Run this command as root, outside the sandbox';
  }
}

/**
 * Escalations collected during an unattended stretch.
 *
 * Kept as a plain list with a deduplicating add, because the failure mode to
 * avoid is a queue that grows one entry per loop iteration and then prints
 * forty identical lines.
 */
export class EscalationQueue {
  readonly #requests: EscalationRequest[] = [];
  readonly #seen = new Set<string>();

  /** Records a request. Repeat requests of the same kind are collapsed. */
  public add(request: EscalationRequest): void {
    const key = `${request.kind}|${(request.paths ?? []).join(',')}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#requests.push(request);
  }

  /** Everything queued, oldest first. */
  public get requests(): readonly EscalationRequest[] {
    return this.#requests;
  }

  /** Whether anything is waiting on the user. */
  public get pending(): boolean {
    return this.#requests.length > 0;
  }

  /**
   * The single consolidated summary shown to the user.
   *
   * One line per DISTINCT kind, not one per command: the user is answering
   * "do I want network access here", not "did I approve this 340th curl".
   */
  public summary(): string {
    if (this.#requests.length === 0) {
      return 'No escalations are waiting.';
    }
    const byKind = new Map<EscalationKind, EscalationRequest[]>();
    for (const r of this.#requests) {
      const list = byKind.get(r.kind) ?? [];
      list.push(r);
      byKind.set(r.kind, list);
    }
    const lines = [...byKind.entries()].flatMap(([, items]) => {
      // Each group is built by pushing into it, so the first element is
      // present by construction; the guard keeps that from being an assertion.
      const first = items[0];
      // "requests", not "commands": `add()` de-duplicates by kind+paths, so a
      // 340th identical `curl` collapses into this group rather than adding to
      // its count. Calling the count a number of commands would overstate what
      // the user is being asked to approve.
      return first === undefined
        ? []
        : [
            `  - ${describeEscalation(first)} ` +
              `(${items.length} request${items.length === 1 ? '' : 's'})`,
          ];
    });
    return [
      `${this.#requests.length} escalation(s) need your decision:`,
      ...lines,
    ].join('\n');
  }

  /** Empties the queue after the user has answered. */
  public clear(): void {
    this.#requests.length = 0;
    this.#seen.clear();
  }
}

/**
 * Applies a decision to the environment's limits.
 *
 * Returns the outcome rather than mutating anything, so the caller decides how
 * to rebuild the sandbox.
 *
 * Requested paths are canonicalised and filtered by {@link safeEscalationRoots}
 * BEFORE they reach the mount set. This is the boundary where a path that came
 * from a human-facing prompt about model-proposed text stops being a string and
 * becomes a mount.
 */
export function applyEscalation(
  request: EscalationRequest,
  decision: EscalationDecision,
  current: {
    readonly writableRoots: readonly string[];
    readonly networkEnabled: boolean;
  },
): EscalationOutcome {
  if (decision === 'deny') {
    return {
      allowed: false,
      escalated: false,
      widenedRoots: current.writableRoots,
      onceRoots: [],
      networkEnabled: current.networkEnabled,
      durableNetwork: false,
      // `denied-hard-floor` means the unconditional floor refused it. A user
      // clicking "no" is a different event, and `shell-tool.ts` goes out of its
      // way to record the two separately - conflating them one layer up is how a
      // filter for floor violations fills up with ordinary declines.
      // `root` is the exception: refusing it IS a floor decision, since it
      // cannot work inside no_new_privs at all.
      gatePath:
        request.kind === 'root' ? 'denied-hard-floor' : 'denied-by-user',
    };
  }
  const durable = decision === 'allow-always' && isGrantable(request.kind);
  const escalated = leavesSandbox(request.kind);

  const requested =
    request.kind === 'extra-writable-root'
      ? safeEscalationRoots(request.paths ?? [])
      : [];

  // A writable-root request whose every path was filtered out grants nothing.
  // Returning `allowed: true` here would have the caller mount nothing, run the
  // command confined, fail for a reason the user never saw, and write an
  // `auto-allow-sandboxed` row claiming a clean allow - the same class of lie
  // the one-off path was fixed for.
  if (request.kind === 'extra-writable-root' && requested.length === 0) {
    return {
      allowed: false,
      escalated: false,
      widenedRoots: current.writableRoots,
      onceRoots: [],
      networkEnabled: current.networkEnabled,
      durableNetwork: false,
      gatePath: 'denied-by-user',
    };
  }

  const widenedRoots =
    requested.length === 0
      ? current.writableRoots
      : [...new Set([...current.writableRoots, ...requested])];

  return {
    allowed: true,
    escalated,
    widenedRoots: durable ? widenedRoots : current.writableRoots,
    // "Allow once" still has to actually allow it, for this one command. The
    // caller mounts these and does not persist them.
    onceRoots: !durable ? requested : [],
    networkEnabled: request.kind === 'network' ? true : current.networkEnabled,
    durableNetwork: request.kind === 'network' && durable,
    // An escalation that leaves the sandbox is recorded as such; one that
    // stays inside it is an ordinary sandboxed allow. Collapsing the two would
    // make the audit log lie about the most interesting rows.
    gatePath: escalated
      ? 'escalated-out-of-sandbox'
      : 'auto-allow-sandboxed',
  };
}

/** Directories that must never become writable, whatever was requested. */
const NEVER_WRITABLE: readonly string[] = [
  '/',
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/run',
  '/var/run',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
];

/**
 * Whether a resolved path may never become a writable root.
 *
 * The denylist is checked by containment, not equality, because the paths are
 * realpathed first: on a merged-`/usr` host `/bin` IS `/usr/bin`, so an
 * equality check against the literal `'/bin'` entry would miss it entirely and
 * let the sandbox's `/usr/bin` be bound read-write over the host's. `/` is the
 * one entry that is matched exactly, since every absolute path is under it.
 */
function isNeverWritable(resolved: string): boolean {
  if (resolved === '/') return true;
  return NEVER_WRITABLE.some(
    // `/` is skipped in the scan: every absolute path is under it, so leaving
    // it in would make this predicate reject every grant.
    (dir) => dir !== '/' && contains(dir, resolved),
  );
}

/**
 * Canonicalises and filters paths on their way into a writable mount set.
 *
 * The strings in `EscalationRequest.paths` originate from a prompt about a
 * model-proposed path, which means they are untrusted input arriving at the
 * exact place that decides what a sandbox can write to. Three defences:
 *
 *   1. **`..` is rejected before resolution**, not normalised away. Resolving
 *      `/work/../elsewhere` produces a perfectly valid path to a directory the
 *      user never agreed to, so normalising would launder it rather than
 *      refuse it.
 *   2. **Never-grantable roots are refused outright.** `mount-policy.ts` binds
 *      with `resolve(root)`, so a `/` in this list would rebind the entire host
 *      filesystem read-write inside the sandbox.
 *   3. **Symlinks are resolved before the denylist is consulted.** Checking the
 *      spelling would let `link -> /etc` through, and `mount-policy.ts` calls
 *      `realpathSync` before binding - so the denylist would be checked against
 *      a name that no longer describes the target. Resolve, then check.
 *   4. **The result is de-duplicated** so two spellings of one directory cannot
 *      both enter the set.
 */
export function safeEscalationRoots(
  paths: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const trimmed = raw.trim();
    // Refused, not normalised: see point 1 above.
    if (trimmed.split(/[\\/]/).includes('..')) continue;
    if (!isAbsolute(trimmed)) continue;
    // Resolve symlinks where the path exists; fall back to lexical resolution
    // for a directory that does not yet exist, because the grant may be for a
    // path about to be created.
    let real: string;
    try {
      real = realpathSync(trimmed);
    } catch {
      real = resolve(trimmed);
    }
    const resolved = real.replace(/\/+$/, '');
    if (resolved === '') continue;
    if (isNeverWritable(resolved)) continue;
    out.push(resolved);
  }
  return [...new Set(out)];
}

/**
 * The profile a directory should start in.
 *
 * An untrusted directory starts `read-only`. This is the default that makes
 * `workspace-write` a decision rather than an accident.
 */
export function initialProfile(trusted: boolean): ProtectionProfile {
  return trusted ? 'workspace-write' : 'read-only';
}
