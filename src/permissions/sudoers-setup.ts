import { randomUUID } from 'node:crypto';
import { readFile, chmod, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PermissionError } from '../errors.js';

/** Options for the explicit sudoers setup flow. */
export interface SudoersSetupOptions {
  /** Path to the sudo executable. */
  sudoPath?: string | undefined;
  /** Path to the visudo executable. */
  visudoPath?: string | undefined;
  /** Managed rule destination. */
  destinationPath?: string | undefined;
}

function runCommand(
  command: string,
  args: readonly string[],
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code);
    });
  });
}

function currentUsername(): string {
  try {
    return userInfo().username;
  } catch (error) {
    throw new PermissionError('Could not determine the current username.', {
      cause: error,
    });
  }
}

/** Validates and installs the narrow Atlas package-management sudoers rule. */
export async function setupSudoers(
  options: SudoersSetupOptions = {},
): Promise<void> {
  const sudoPath = options.sudoPath ?? 'sudo';
  const visudoPath = options.visudoPath ?? 'visudo';
  const destinationPath = options.destinationPath ?? '/etc/sudoers.d/atlas';
  const username = currentUsername();
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new PermissionError(
      'The current username is not safe for a sudoers rule.',
    );
  }

  const temporaryPath = join(
    '/tmp',
    `.atlas-sudoers-${process.pid}-${randomUUID()}.tmp`,
  );
  const rule = [
    '# Atlas-managed package-management allowlist. Managed by: atlas permissions setup',
    `${username} ALL=(root) NOPASSWD: /usr/bin/dnf install *, /usr/bin/dnf update *, /usr/bin/dnf check-update`,
    '',
  ].join('\n');

  try {
    await writeFile(temporaryPath, rule, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    const validationCode = await runCommand(visudoPath, ['-cf', temporaryPath]);
    if (validationCode !== 0) {
      throw new PermissionError(
        'The generated sudoers rule failed visudo validation.',
      );
    }

    const installCode = await runCommand(sudoPath, [
      '-k',
      'install',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0440',
      temporaryPath,
      destinationPath,
    ]);
    if (installCode !== 0) {
      throw new PermissionError(
        'sudo did not install the Atlas permission rule.',
      );
    }

    const finalValidationCode = await runCommand(sudoPath, [
      'visudo',
      '-cf',
      destinationPath,
    ]);
    if (finalValidationCode !== 0) {
      throw new PermissionError(
        'The installed sudoers rule failed final visudo validation.',
      );
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Checks whether the explicit Atlas sudoers file exists. */
export async function sudoersRuleExists(
  destinationPath = '/etc/sudoers.d/atlas',
): Promise<boolean> {
  try {
    const source = await readFile(destinationPath, 'utf8');
    return (
      source.includes('# Atlas-managed package-management allowlist.') &&
      source.includes('/usr/bin/dnf install *') &&
      source.includes('/usr/bin/dnf update *') &&
      source.includes('/usr/bin/dnf check-update')
    );
  } catch {
    return false;
  }
}
