/**
 * The fail-closed environment.
 *
 * When no sandbox can be created, Atlas used to fall back to a plain host
 * shell while reporting `profile: full-access | network: on`, and that shell
 * really wrote to the real filesystem (proved by a probe that created a file
 * under the user's home). That is the fail-open this replaces.
 *
 * `RefusingEnvironment` is a distinct state. It runs only commands the
 * read-only clear permits (the safe-bin tier-0 set) and refuses everything else
 * with a message that says what is wrong and how to fix it. It is not
 * `full-access`: the banner says `refusing`, the profile says `read-only`, and
 * the network is off, because that is what is true.
 *
 * The refusal is enforced twice on purpose - once here at the session, so a
 * caller that reaches the session directly still cannot run anything else, and
 * once in the shell tool, so the model and the user get a structured
 * explanation instead of an exit code. Belt and braces, because a boundary
 * enforced in one place is a boundary with one place to forget it.
 */

import type { CommandResult } from '../shell/command-result.js';
import { ShellSession } from '../shell/shell-session.js';
import {
  describeStatus,
  type ExecutionEnvironment,
  type ExecutionSession,
  type ExecutionSessionOptions,
  type ExecutionStatus,
} from './environment.js';
import { positivelyReadOnly } from './read-only-clear.js';

/** Exit code used for a policy refusal. 126 is "found but not executable". */
export const REFUSED_EXIT_CODE = 126;

/**
 * The message shown when a command is refused because there is no sandbox.
 *
 * Names the state, the reason, and the two ways out. A refusal that does not
 * say how to proceed just looks like a broken tool.
 */
export function degradedRefusalMessage(reason: string): string {
  return [
    'Atlas is refusing this command because no sandbox is available, so it will',
    'not run an arbitrary command directly on your computer.',
    `Reason: ${reason}`,
    '',
    'Only read-only diagnostic commands (the safe-bin list: ls, cat, ps, df,',
    'grep, id, ...) run in this state. To run anything else, fix the sandbox:',
    '  - install bubblewrap (e.g. "dnf install bubblewrap" / "apt install bubblewrap"), or',
    '  - enable unprivileged user namespaces, then restart Atlas.',
    '',
    'If you deliberately want Atlas to run commands with no sandbox, opt in',
    'explicitly with "atlas --full-access" (or ATLAS_FULL_ACCESS=1) and accept',
    'the warning. That mode is not recommended and is not a fallback.',
  ].join('\n');
}

export interface RefusingEnvironmentOptions {
  /** Directory sessions start in. */
  readonly cwd: string;
  /** Why the sandbox is unavailable; carried verbatim into refusals. */
  readonly reason: string;
}

export class RefusingEnvironment implements ExecutionEnvironment {
  readonly status: ExecutionStatus;
  readonly #cwd: string;
  readonly #reason: string;

  public constructor(options: RefusingEnvironmentOptions) {
    this.#cwd = options.cwd;
    this.#reason = options.reason;
    this.status = {
      backend: 'refusing',
      // read-only, not full-access: this backend refuses writes rather than
      // performing them. Reporting full-access here was the lie.
      profile: 'read-only',
      writableRoots: [],
      networkEnabled: false,
      sandboxed: false,
      seccomp: false,
      degradedReason: options.reason,
    };
  }

  public describe(): string {
    return describeStatus(this.status);
  }

  public createSession(
    options: ExecutionSessionOptions = {},
  ): ExecutionSession {
    return new RefusingSession(
      options.cwd ?? this.#cwd,
      this.#reason,
      options.timeoutMs,
    );
  }
}

/**
 * A session that runs cleared read-only commands and refuses the rest.
 *
 * Cleared commands go through a real host shell - that is safe precisely
 * because they are read-only - so the session keeps the persistent cwd and
 * marker protocol the rest of Atlas expects.
 */
export class RefusingSession implements ExecutionSession {
  #inner: ShellSession | undefined;
  #currentDirectory: string;
  readonly #reason: string;
  readonly #timeoutMs: number | undefined;
  #closed = false;

  public constructor(
    cwd: string,
    reason: string,
    timeoutMs?: number,
  ) {
    this.#currentDirectory = cwd;
    this.#reason = reason;
    this.#timeoutMs = timeoutMs;
  }

  public get currentDirectory(): string {
    return this.#inner?.currentDirectory ?? this.#currentDirectory;
  }

  public get running(): boolean {
    return !this.#closed;
  }

  public async execute(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const clear = positivelyReadOnly(command, this.currentDirectory);
    if (!clear.cleared) {
      return {
        stdout: '',
        stderr: degradedRefusalMessage(this.#reason),
        exitCode: REFUSED_EXIT_CODE,
        durationMs: 0,
        timedOut: false,
      };
    }
    const inner = this.#ensureInner();
    return await inner.execute(
      command,
      timeoutMs ?? this.#timeoutMs,
      signal,
    );
  }

  public restart(): void {
    // Keep whatever directory the shell had reached, matching ShellSession's
    // own restart semantics, then rebuild lazily on the next command.
    if (this.#inner !== undefined) {
      this.#currentDirectory = this.#inner.currentDirectory;
      this.#inner.close();
      this.#inner = undefined;
    }
  }

  public close(): void {
    this.#closed = true;
    this.#inner?.close();
    this.#inner = undefined;
  }

  #ensureInner(): ShellSession {
    if (this.#inner === undefined) {
      this.#inner = new ShellSession({
        cwd: this.#currentDirectory,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      });
      this.#inner.restart();
    }
    return this.#inner;
  }
}
