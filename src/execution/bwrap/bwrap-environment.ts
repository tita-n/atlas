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
 * **NoNewPrivs is proven on every session start, not assumed.** bubblewrap
 * setup is checked from inside before a shell starts. A restarted shell repeats
 * the check; mismatch refuses to start it.
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
   *
   * Before returning, the sandbox is checked FROM INSIDE (see
   * {@link verifyIsolation}). A sandbox whose isolation could not be confirmed
   * is not handed to a caller at all - it throws, and the resolver turns that
   * into the visible refusing state. "We think it is confined" is not a
   * guarantee; the confirmation is.
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

    const policy: MountPolicy = {
      profile: options.profile,
      cwd: options.cwd,
      writableRoots,
      networkEnabled: options.networkEnabled ?? false,
      atlasHome: options.atlasHome,
      alwaysHidden: options.alwaysHidden ?? [],
    };

    // The production caller for the isolation self-check. This is the step the
    // previous version left as a probe with no caller, so its claim was "this
    // is checkable" rather than "this was checked". Now every sandbox session
    // is checked before it runs a single command, and a mismatch is a hard
    // refusal with the reason.
    const isolation = await verifySandboxIsolation(
      policy,
      resolution.path,
      defaultRunner,
    );
    if (!isolation.ok) {
      throw new BwrapUnavailableError(
        `sandbox isolation could not be confirmed, so Atlas will not use it: ${isolation.detail}`,
      );
    }

    const environment = new BwrapEnvironment(
      policy,
      resolution.path,
      options.cwd,
      options.networkEnabled ?? false,
      writableRoots,
    );
    environment.#noNewPrivsVerified = true;
    return environment;
  }

  public describe(): string {
    return describeStatus(this.status);
  }

  public createSession(
    options: ExecutionSessionOptions = {},
  ): ExecutionSession {
    const cwd = options.cwd ?? this.#cwd;
    return new VerifiedBwrapSession(
      async (startCwd) => {
        const built = buildBwrapCommand(
          { ...this.#policy, cwd: startCwd },
          this.#bwrapPath,
          SANDBOXED_SHELL,
        );
        return new ShellSession({
          command: built.argv,
          cwd: startCwd,
          // The sandbox gets exactly the variables the mount policy allows;
          // the parent's full environment, keys included, must not reach it.
          env: {},
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        });
      },
      () => this.verifyIsolation(),
      cwd,
    );
  }

  /**
   * Verifies from inside the sandbox that the confinement it claims is real.
   *
   * Bubblewrap sets NoNewPrivs when it creates a user namespace, drops caps and
   * mounts the masks, but that is a claim about behaviour, and `setuid` builds
   * or a different kernel may differ. An unverified claim is not a security
   * property. This runs the check and reports each result.
   */
  public async verifyIsolation(): Promise<IsolationReport> {
    const report = await verifySandboxIsolation(
      this.#policy,
      this.#bwrapPath,
      defaultRunner,
    );
    this.#noNewPrivsVerified = report.ok;
    return report;
  }

  /** Whether the isolation self-check has passed in this session. */
  public get isolationVerified(): boolean {
    return this.#noNewPrivsVerified;
  }
}

/** ExecutionSession wrapper that verifies isolation before every shell start. */
export class VerifiedBwrapSession implements ExecutionSession {
  readonly #create: (cwd: string) => Promise<ExecutionSession>;
  readonly #verify: () => Promise<IsolationReport>;
  #cwd: string;
  #session: ExecutionSession | undefined;
  #opening: Promise<ExecutionSession> | undefined;
  #closed = false;

  public constructor(
    create: (cwd: string) => Promise<ExecutionSession>,
    verify: () => Promise<IsolationReport>,
    cwd: string,
  ) {
    this.#create = create;
    this.#verify = verify;
    this.#cwd = cwd;
  }

  public get currentDirectory(): string {
    return this.#session?.currentDirectory ?? this.#cwd;
  }

  public get running(): boolean {
    return this.#session?.running ?? false;
  }

  public async execute(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) {
    if (this.#closed) throw new BwrapUnavailableError('Sandbox session is closed.');
    let opening = this.#opening;
    if (this.#session === undefined && opening === undefined) {
      opening = this.#start(this.#cwd);
      this.#opening = opening;
      void opening.catch(() => undefined);
    }
    const session = this.#session ?? (opening === undefined ? undefined : await opening);
    if (session === undefined) {
      throw new BwrapUnavailableError('Sandbox session did not start.');
    }
    return await session.execute(command, timeoutMs, signal);
  }

  public restart(): void {
    if (this.#closed) return;
    const cwd = this.currentDirectory;
    this.#session?.close();
    this.#session = undefined;
    this.#opening = this.#start(cwd);
    void this.#opening.catch(() => undefined);
  }

  public close(): void {
    this.#closed = true;
    this.#session?.close();
    this.#session = undefined;
  }

  async #start(cwd: string): Promise<ExecutionSession> {
    const report = await this.#verify();
    if (!report.ok) {
      throw new BwrapUnavailableError(
        `sandbox isolation could not be confirmed, so Atlas will not start it: ${report.detail}`,
      );
    }
    if (this.#closed) throw new BwrapUnavailableError('Sandbox session is closed.');
    const session = await this.#create(cwd);
    session.restart();
    this.#cwd = cwd;
    this.#session = session;
    return session;
  }
}

/** One property checked from inside the sandbox. */
export interface IsolationCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface IsolationReport {
  readonly ok: boolean;
  readonly detail: string;
  readonly checks: readonly IsolationCheck[];
}

export type IsolationRunner = (
  argv: readonly string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Runs the isolation self-check from INSIDE a sandbox built by `policy`.
 *
 * One bwrap invocation runs a POSIX `sh` script that reports four facts:
 *
 *   1. `NoNewPrivs: 1` in `/proc/self/status`.
 *   2. `CapEff` is all zero (no effective capabilities).
 *   3. The sandbox root is not writable (`touch /...` fails).
 *   4. Every path the policy masked is unreadable (`ls` on it fails).
 *
 * A missing or truncated report is a FAILURE, not a pass: if the script did not
 * complete we learned nothing, and "we learned nothing" must not be reported as
 * "isolated". The caller turns any failure into a refusal to run.
 */
export async function verifySandboxIsolation(
  policy: MountPolicy,
  bwrapPath: string,
  runner: IsolationRunner,
): Promise<IsolationReport> {
  // The mask list is deterministic given the policy, so a cheap build tells us
  // exactly which paths to check. Any command works for this read.
  const maskedPaths = buildBwrapCommand(policy, bwrapPath, ['/bin/true'])
    .maskedPaths;
  const script = isolationScript(maskedPaths);
  const built = buildBwrapCommand(policy, bwrapPath, [
    '/bin/sh',
    '-c',
    script,
  ]);
  const result = await runner(built.argv);
  return interpretIsolation(result.stdout, maskedPaths);
}

/** The POSIX script the in-sandbox check runs. Kept tiny and dependency-free. */
function isolationScript(maskedPaths: readonly string[]): string {
  const quoted = maskedPaths
    .map((path) => `'${path.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  return [
    'printf "NNP=%s\\n" "$(grep -c \'^NoNewPrivs:[[:space:]]*1\' /proc/self/status)"',
    'printf "CAPEFF=%s\\n" "$(awk \'/^CapEff:/{print $2}\' /proc/self/status)"',
    'if touch /atlas-isolation-probe 2>/dev/null; then echo ROOTRW=1; else echo ROOTRW=0; fi',
    `for p in ${quoted}; do if [ -e "$p" ] && ls "$p" >/dev/null 2>&1; then printf "MASKLEAK=%s\\n" "$p"; fi; done`,
    'echo CHECK_DONE',
  ].join('\n');
}

/** Turns raw probe output into per-property verdicts. Absence of proof fails. */
export function interpretIsolation(
  stdout: string,
  maskedPaths: readonly string[],
): IsolationReport {
  const lines = stdout.split('\n').map((line) => line.trim());
  const value = (key: string): string | undefined =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

  const completed = lines.includes('CHECK_DONE');
  const nnp = value('NNP');
  const capEff = value('CAPEFF');
  const rootRw = value('ROOTRW');
  const leaks = lines.filter((line) => line.startsWith('MASKLEAK='));

  const capsZero = capEff !== undefined && /^0+$/.test(capEff);
  const checks: IsolationCheck[] = [
    {
      name: 'no-new-privs',
      ok: nnp === '1',
      detail:
        nnp === '1'
          ? 'NoNewPrivs: 1'
          : `NoNewPrivs not set (saw ${nnp ?? 'nothing'})`,
    },
    {
      name: 'capabilities-dropped',
      ok: capsZero,
      detail: capsZero
        ? 'CapEff all zero'
        : `CapEff not empty (saw ${capEff ?? 'nothing'})`,
    },
    {
      name: 'root-read-only',
      ok: rootRw === '0',
      detail:
        rootRw === '0'
          ? 'sandbox root is not writable'
          : `sandbox root was writable (saw ROOTRW=${rootRw ?? 'nothing'})`,
    },
    {
      name: 'masks-present',
      ok: completed && leaks.length === 0,
      detail:
        !completed
          ? 'mask check did not complete'
          : leaks.length === 0
            ? `${String(maskedPaths.length)} masked path(s) unreadable`
            : `masked path still readable: ${leaks
                .map((line) => line.slice('MASKLEAK='.length))
                .join(', ')}`,
    },
  ];

  const ok = completed && checks.every((check) => check.ok);
  if (ok) {
    return {
      ok: true,
      detail: 'all isolation checks passed from inside the sandbox',
      checks,
    };
  }
  const failed = checks.filter((check) => !check.ok);
  const detail = completed
    ? failed.map((check) => `${check.name}: ${check.detail}`).join('; ')
    : 'the in-sandbox check did not finish; isolation is unproven';
  return { ok: false, detail, checks };
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
