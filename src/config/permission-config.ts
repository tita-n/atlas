import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigFileError, ConfigValidationError } from '../errors.js';
import {
  permissionConfigSchema,
  type PermissionConfigFile,
  type PermissionGrant,
  type PermissionRule,
} from '../permissions/rules.schema.js';

/** Loaded user permission additions. */
export interface PermissionConfig {
  /** User rules layered over built-in defaults. */
  rules: PermissionRule[];
  /**
   * Path loaded, or null/absent when no user file exists.
   *
   * Optional so that a config built in code can omit it and fall back to the
   * default per-user path rather than being forced to invent one.
   */
  sourcePath?: string | null;
  /** Optional typed confirmation phrase override. */
  confirmationPhrase?: string | undefined;
  /** Durable exact-argv grants loaded from the user file. */
  grants: PermissionGrant[];
}

/** Options for loading user permission overrides. */
export interface LoadPermissionConfigOptions {
  /** Explicit permissions file path. */
  configPath?: string | undefined;
  /** Environment used for `ATLAS_PERMISSIONS_PATH`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Home directory used for the default path. */
  homeDirectory?: string | undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function validationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? 'permissions' : issue.path.join('.');
    return `${path}: invalid permission rule`;
  });
}

/** Returns the standard user permissions file path. */
export function getDefaultPermissionsPath(homeDirectory = homedir()): string {
  return resolve(homeDirectory, '.atlas', 'permissions.json');
}

/** Resolves explicit, environment, and default permissions paths. */
export function resolvePermissionsPath(
  options: LoadPermissionConfigOptions = {},
): string {
  if (options.configPath !== undefined) return resolve(options.configPath);
  const env = options.env ?? process.env;
  if (
    env.ATLAS_PERMISSIONS_PATH !== undefined &&
    env.ATLAS_PERMISSIONS_PATH !== ''
  ) {
    return resolve(env.ATLAS_PERMISSIONS_PATH);
  }
  return getDefaultPermissionsPath(options.homeDirectory);
}

/** Loads user rules without allowing them to remove built-in defaults. */
export async function loadPermissionConfig(
  options: LoadPermissionConfigOptions = {},
): Promise<PermissionConfig> {
  const path = resolvePermissionsPath(options);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error))
      return { rules: [], grants: [], sourcePath: null };
    throw new ConfigFileError(`Could not read permissions at ${path}.`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ConfigValidationError([
      'permissions file: contains malformed JSON',
    ]);
  }
  const result = permissionConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigValidationError(validationIssues(result.error));
  }
  return {
    rules: result.data.rules,
    grants: result.data.grants,
    sourcePath: path,
    ...(result.data.confirmationPhrase === undefined
      ? {}
      : { confirmationPhrase: result.data.confirmationPhrase }),
  };
}

export type { PermissionConfigFile };
