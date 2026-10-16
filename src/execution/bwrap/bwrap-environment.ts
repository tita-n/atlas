/**
 * The bwrap backend: a long-lived sandboxed bash per session.
 *
 * **Why one long-lived shell rather than bwrap per command.** Atlas promises
 * that `cd` and `export` persist between turns, and permission grants bind to
 * the shell's real working directory. Spawning bwrap per command would have to
 * reimplement both, and reimplementing shell state correctly is how you end up
 * with a sandbox whose cwd quietly differs from the one the grant was issued
 * for. Reusing `ShellSession`'s marker protocol with a different argv means one
 * implementation of the command protocol, sandboxed or not.
 *
 * **The cost, stated plainly.** Widening the mount set means a new bwrap, so
 * `restart()` brings up a fresh sandbox in the same directory. Shell-local
 * `export`s do not survive that. The escalation flow says so before it does it.
 *
 * **NoNewPrivs is proven on demand, not assumed.** bubblewrap sets it as part
 * of user namespace setup, but "the man page implies it" is not evidence, so
 * {@link BwrapEnvironment.verifyIsolation} runs the check from INSIDE the
 * sandbox and can report `NoNewPrivs: 1` as observed rather than inferred. It
 * is a probe with no production caller yet: startup resolves the backend on a
 * cheap `--version`-style probe, and calling a second bwrap on every session
 * start was not worth the latency. The claim it supports is therefore "this is
 * checkable and here is the check", not "this ran".
 */

import { spawn } from 'node:child_process';

import { ShellSessionError } from '../../errors.js';
import { ShellSession } from '../../shell/shell-session.js';
import {
  describeStatus,
  type ExecutionEnvironment,
  type ExecutionSession,
  type ExecutionSessionOptions,
  type ExecutionStatus,
  type ProtectionProfile,
} from '../environment.js';
import {
  buildBwrapCommand,
  SANDBOXED_SHELL,
  type MountPolicy,
} from './mount-policy.js';
import { probeBwrap, resolveBwrapPath } from './resolve-bwrap.js';

export interface BwrapEnvironmentOptions {
  readonly profile: ProtectionProfile;
  readonly cwd: string;
  readonly writableRoots?: readonly string[] | undefined;
  readonly networkEnabled?: boolean | undefined;
  readonly atlasHome: string;
  readonly alwaysHidden?: readonly string[] | undefined;
  /** Injection point for tests; defaults to the real binary and kernel. */
  readonly bwrapPath?: string | undefined;
}

export class BwrapUnavailableError extends ShellSessionError {
  public constructor(message: string) {
    super(message);
    this.name = 'BwrapUnavailableError';
  }
}

export class BwrapEnvironment implements ExecutionEnvironment {
  readonly status: ExecutionStatus;
  readonly #policy: MountPolicy;
  readonly #bwrapPath: string;
  readonly #cwd: string;
  #noNewPrivsVerified = false;

  private constructor(
    policy: MountPolicy,
    bwrapPath: string,
    cwd: string,
    networkEnabled: boolean,
    writableRoots: readonly string[],
  ) {
    this.#policy = policy;
    this.#bwrapPath = bwrapPath;
    this.#cwd = cwd;
    this.status = {
      backend: 'bwrap',
      profile: policy.profile,
      writableRoots,
      networkEnabled,
      sandboxed: true,
      // Reported false until a validated cBPF filter is actually loaded. See
      // the note in mount-policy.ts for why there is not one yet.
      seccomp: false,
    };
  }

  /**
   * Builds a sandbox, or refuses.
   *
   * There is no degraded fallback inside this function on purpose: choosing to
   * run unsandboxed is a decision for `resolveExecutionEnvironment`, which can
   * see the whole picture and say so out loud. A backend that quietly ran on
   * the host would be the exact failure this whole design is meant to remove.
   */
  public static async create(
    options: BwrapEnvironmentOptions,
  ): Promise<BwrapEnvironment> {
    const resolution =
      options.bwrapPath === undefined
        ? resolveBwrapPath()
        : { ok: true as const, path: options.bwrapPath };
    if (!resolution.ok || resolution.path === undefined) {
      throw new BwrapUnavailableError(
        resolution.reason ?? 'bubblewrap is unavailable.',
      );
    }
    const probe = await probeBwrap(resolution.path, defaultRunner);
    if (!probe.ok) {
      throw new BwrapUnavailableError(
        probe.reason ?? 'bubblewrap is unavailable.',
      );
    }

    const writableRoots =
      options.profile === 'workspace-write'
        ? (options.writableRoots ?? [options.cwd])
        : [];

    return new BwrapEnvironment(
      {
        profile: options.profile,
        cwd: options.cwd,
        writableRoots,
        networkEnabled: options.networkEnabled ?? false,
        atlasHome: options.atlasHome,
        alwaysHidden: options.alwaysHidden ?? [],
      },
      resolution.path,
      options.cwd,
      options.networkEnabled ?? false,
      writableRoots,
    );
  }

  public describe(): string {
    return describeStatus(this.status);
  }

  public createSession(
    options: ExecutionSessionOptions = {},
  ): ExecutionSession {
    const cwd = options.cwd ?? this.#cwd;
    const built = buildBwrapCommand(
      { ...this.#policy, cwd },
      this.#bwrapPath,
      SANDBOXED_SHELL,
    );
    return new ShellSession({
      command: built.argv,
      cwd,
      // The sandbox gets exactly the variables the mount policy allows; the
      // parent's full environment, keys included, must not reach it.
      env: {},
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  /**
   * Verifies from inside the sandbox that no_new_privs is really set.
   *
   * Bubblewrap sets it when it creates a user namespace, but that is a claim
   * about behaviour, and `setuid` builds may differ. An unverified claim is not
   * a security property, so the check runs once and its result is reported.
   */
  public async verifyIsolation(): Promise<{
    ok: boolean;
    detail: string;
  }> {
    const probeCommand = [
      '/bin/sh',
      '-c',
      'grep -q "^NoNewPrivs:\\s*1" /proc/self/status && echo NNP_OK || echo NNP_MISSING',
    ];
    const built = buildBwrapCommand(
      this.#policy,
      this.#bwrapPath,
      probeCommand,
    );
    const result = await defaultRunner(built.argv);
    const ok = result.stdout.includes('NNP_OK');
    this.#noNewPrivsVerified = ok;
    return {
      ok,
      detail: ok
        ? 'NoNewPrivs: 1 confirmed from inside the sandbox'
        : 'sandbox did not report NoNewPrivs=1; isolation is NOT as assumed',
    };
  }

  /** Whether the isolation self-check has passed in this session. */
  public get isolationVerified(): boolean {
    return this.#noNewPrivsVerified;
  }
}

async function defaultRunner(
  argv: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0] ?? 'bwrap', [...argv.slice(1)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        // The launcher's own environment is irrelevant: bwrap clears it and
        // sets an allow list for the sandbox, so nothing here leaks through.
        env: { PATH: '/usr/bin:/bin' },
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => { resolve({ code, stdout, stderr }); });
  });
}