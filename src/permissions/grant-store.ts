import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PermissionConfig } from '../config/permission-config.js';
import { resolvePermissionsPath } from '../config/permission-config.js';
import { resolveExecutablePath } from './executable-path.js';
import type { ShellCommandSegment, ShellStructure } from './shell-structure.js';
import { extractShellStructure } from './shell-structure.js';
import type { PermissionGrant } from './rules.schema.js';

/** Lookup surface consumed by the risk classifier. */
export interface GrantMatcher {
  /** Finds a session or durable grant for a simple command segment. */
  match(segment: ShellCommandSegment, cwd: string): PermissionGrant | undefined;
}

/** Result of an explicit remember request. */
export interface RememberResult {
  /** Whether grants were written durably. */
  persisted: boolean;
  /** IDs of grants created or reused. */
  grantIds: string[];
  /** Reason persistence was refused. */
  reason?: string;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function segmentIsRefused(
  segment: ShellCommandSegment,
  segments: readonly ShellCommandSegment[],
): boolean {
  const name = segment.executable?.toLowerCase();
  const argv = segment.argv ?? [];
  if (name === 'sudo' || name === 'xargs' || name === 'dd') return true;
  if (
    (name === 'python' || name === 'python3' || name === 'python2') &&
    argv.includes('-c')
  )
    return true;
  if (
    name === 'node' &&
    argv.some((value) => value === '-e' || value === '--eval' || value === '-p')
  )
    return true;
  if (
    (name === 'bash' || name === 'sh') &&
    argv.some((value) => value === '-c' || value === '--command')
  )
    return true;
  if (name === 'curl' || name === 'wget') {
    return segments.some(
      (other) => other.executable === 'sh' || other.executable === 'bash',
    );
  }
  return false;
}

function refusalForStructure(structure: ShellStructure): string | undefined {
  if (structure.unknown) {
    return 'This command contains shell syntax Atlas could not fully resolve.';
  }
  if (structure.nestedScripts.length > 0) {
    return 'Commands with substitutions or nested shells are never remembered. Re-run it with a literal path instead, for example /home/you/project/file.';
  }
  return undefined;
}

/** Stores session and durable exact-argv permission grants. */
export class PermissionGrantStore implements GrantMatcher {
  readonly #config: PermissionConfig;
  readonly #configPath: string;
  readonly #sessionGrants: PermissionGrant[];
  readonly #durableGrants: PermissionGrant[];

  public constructor(config: PermissionConfig) {
    this.#config = config;
    this.#configPath = config.sourcePath ?? resolvePermissionsPath();
    this.#durableGrants = config.grants.map((grant) => ({
      ...grant,
      argv: [...grant.argv],
    }));
    this.#sessionGrants = [];
  }

  /** Creates a store from loaded user configuration. */
  public static fromConfig(config: PermissionConfig): PermissionGrantStore {
    return new PermissionGrantStore(config);
  }

  /** Returns durable grants only. */
  public listDurable(): PermissionGrant[] {
    return this.#durableGrants.map((grant) => ({
      ...grant,
      argv: [...grant.argv],
    }));
  }

  /** Returns session and durable grants for diagnostics. */
  public listAll(): PermissionGrant[] {
    return [...this.#sessionGrants, ...this.#durableGrants].map((grant) => ({
      ...grant,
      argv: [...grant.argv],
    }));
  }

  /** Finds an exact executable, argv, and working-directory grant. */
  public match(
    segment: ShellCommandSegment,
    cwd: string,
  ): PermissionGrant | undefined {
    if (segment.argv === null || segment.executable === null) return undefined;
    // A grant is keyed on the executable and argv, which do not include
    // redirect targets. Honouring one for a command that writes to a file
    // would let `rm -rf build > ~/.bashrc` match a grant approved for
    // `rm -rf build`, so redirected segments never match a grant.
    if (segment.hasFileWriteRedirect) return undefined;
    // A grant records the executable and argv, which do not capture an
    // env-assignment prefix, so a prefixed command must never match one.
    if (segment.envPrefixes.length > 0) return undefined;
    const argv = segment.argv;
    const executablePath = resolveExecutablePath(
      segment.executablePath ?? segment.executable,
    );
    if (executablePath === undefined) return undefined;
    const normalizedCwd = resolve(cwd);
    return [...this.#sessionGrants, ...this.#durableGrants].find(
      (grant) =>
        grant.executablePath === executablePath &&
        grant.cwd === normalizedCwd &&
        sameArgv(grant.argv, argv),
    );
  }

  /** Persists exact grants for every simple segment in an approved command. */
  public async remember(
    command: string,
    cwd = process.cwd(),
  ): Promise<RememberResult> {
    let structure: ShellStructure;
    try {
      structure = extractShellStructure(command);
    } catch {
      return {
        persisted: false,
        grantIds: [],
        reason:
          'Atlas could not fully parse this command for durable approval.',
      };
    }
    const refusal = refusalForStructure(structure);
    if (refusal !== undefined)
      return { persisted: false, grantIds: [], reason: refusal };
    if (structure.commands.length === 0) {
      return {
        persisted: false,
        grantIds: [],
        reason: 'No executable command was found.',
      };
    }

    const normalizedCwd = resolve(cwd);
    const created: PermissionGrant[] = [];
    for (const segment of structure.commands) {
      if (segmentIsRefused(segment, structure.commands)) {
        return {
          persisted: false,
          grantIds: [],
          reason:
            'This command type is never remembered for safety (sudo, dd, xargs, and inline interpreters such as bash -c or node -e). Approve it once instead.',
        };
      }
      if (segment.envPrefixes.length > 0) {
        return {
          persisted: false,
          grantIds: [],
          reason:
            'Commands that set environment variables are never remembered, because the prefix can change which program runs.',
        };
      }
      if (segment.hasFileWriteRedirect) {
        return {
          persisted: false,
          grantIds: [],
          reason:
            'Commands that redirect output into a file are never remembered, because the destination file is not part of what gets approved.',
        };
      }
      if (
        segment.argv === null ||
        segment.executable === null ||
        !segment.executableKnown
      ) {
        return {
          persisted: false,
          grantIds: [],
          reason:
            'The exact arguments could not be resolved, so a remembered command could not be matched safely. Replace variables such as $HOME with a literal path and try again.',
        };
      }
      const argv = segment.argv;
      const executablePath = resolveExecutablePath(
        segment.executablePath ?? segment.executable,
      );
      if (executablePath === undefined) {
        return {
          persisted: false,
          grantIds: [],
          reason:
            'That executable could not be found on this system, so Atlas cannot remember it. Check the command and program name.',
        };
      }
      const existing = [...this.#sessionGrants, ...this.#durableGrants].find(
        (grant) =>
          grant.executablePath === executablePath &&
          grant.cwd === normalizedCwd &&
          sameArgv(grant.argv, argv),
      );
      created.push(
        existing ?? {
          id: randomUUID(),
          executablePath,
          argv: [...argv],
          cwd: normalizedCwd,
          createdAt: new Date().toISOString(),
        },
      );
    }

    const nextDurable = [...this.#durableGrants];
    for (const grant of created) {
      if (!nextDurable.some((existing) => existing.id === grant.id)) {
        nextDurable.push(grant);
      }
    }
    try {
      await mkdir(dirname(this.#configPath), { recursive: true, mode: 0o700 });
      await writeFile(
        this.#configPath,
        `${JSON.stringify(
          {
            rules: this.#config.rules,
            grants: nextDurable,
            ...(this.#config.confirmationPhrase === undefined
              ? {}
              : { confirmationPhrase: this.#config.confirmationPhrase }),
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      return {
        persisted: false,
        grantIds: created.map((grant) => grant.id),
        reason: 'Atlas could not write the durable permissions file.',
      };
    }

    this.#durableGrants.splice(0, this.#durableGrants.length, ...nextDurable);
    this.#sessionGrants.push(...created);
    return { persisted: true, grantIds: created.map((grant) => grant.id) };
  }

  /** Removes one durable grant by ID. */
  public async revoke(id: string): Promise<boolean> {
    const next = this.#durableGrants.filter((grant) => grant.id !== id);
    if (next.length === this.#durableGrants.length) return false;
    await writeFile(
      this.#configPath,
      `${JSON.stringify(
        {
          rules: this.#config.rules,
          grants: next,
          ...(this.#config.confirmationPhrase === undefined
            ? {}
            : { confirmationPhrase: this.#config.confirmationPhrase }),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    this.#durableGrants.splice(0, this.#durableGrants.length, ...next);
    return true;
  }
}
