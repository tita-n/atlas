import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ZodError } from 'zod';
import {
  ConfigFileError,
  ConfigNotFoundError,
  ConfigValidationError,
} from '../errors.js';
import {
  atlasConfigSchema,
  DEFAULT_BASE_URLS,
  type AtlasConfig,
  type ConfigOverrides,
  type ProviderName,
} from './config.schema.js';

/** Options controlling where and how configuration is loaded. */
export interface LoadConfigOptions {
  /** Explicit config path supplied by a programmatic caller or CLI. */
  configPath?: string | undefined;
  /** Environment used for overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Values supplied by the CLI, which have the highest precedence. */
  overrides?: ConfigOverrides | undefined;
  /** Home directory used to derive the default config path. */
  homeDirectory?: string | undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function safeValidationIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const field =
      issue.path.length === 0 ? 'configuration' : issue.path.join('.');

    switch (field) {
      case 'provider':
        return 'provider: must be "openai-compatible" or "anthropic-compatible"';
      case 'apiKey':
        return 'apiKey: API key is required and must be a non-empty string';
      case 'baseUrl':
        return 'baseUrl: must be a valid HTTP(S) URL';
      case 'model':
        return 'model: is required and must be a non-empty string';
      case 'maxTokens':
        return 'maxTokens: must be a positive integer';
      case 'temperature':
        return 'temperature: must be a number between 0 and 2';
      default:
        if (issue.code === 'unrecognized_keys') {
          return 'configuration: contains unsupported fields';
        }
        return `${field}: is invalid`;
    }
  });
}

function assertValidConfig(value: unknown): AtlasConfig {
  const result = atlasConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigValidationError(safeValidationIssues(result.error));
  }

  return result.data;
}

function hasConfigValues(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

/** Returns the standard Atlas configuration path. */
export function getDefaultConfigPath(homeDirectory = homedir()): string {
  return resolve(homeDirectory, '.atlas', 'config.json');
}

/** Resolves explicit, environment, and home-directory config path precedence. */
export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  if (options.configPath !== undefined) {
    return resolve(options.configPath);
  }

  const env = options.env ?? process.env;
  if (env.ATLAS_CONFIG_PATH !== undefined && env.ATLAS_CONFIG_PATH !== '') {
    return resolve(env.ATLAS_CONFIG_PATH);
  }

  return getDefaultConfigPath(options.homeDirectory);
}

function environmentOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  if (env.ATLAS_PROVIDER !== undefined) values.provider = env.ATLAS_PROVIDER;
  if (env.ATLAS_API_KEY !== undefined) values.apiKey = env.ATLAS_API_KEY;
  if (env.ATLAS_BASE_URL !== undefined) values.baseUrl = env.ATLAS_BASE_URL;
  if (env.ATLAS_MODEL !== undefined) values.model = env.ATLAS_MODEL;
  if (env.ATLAS_MAX_TOKENS !== undefined) {
    values.maxTokens = Number(env.ATLAS_MAX_TOKENS);
  }
  if (env.ATLAS_TEMPERATURE !== undefined) {
    values.temperature = Number(env.ATLAS_TEMPERATURE);
  }

  return values;
}

async function readConfigFile(
  configPath: string,
): Promise<Record<string, unknown>> {
  let source: string;

  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return {};
    }
    throw new ConfigFileError(
      `Could not read Atlas configuration at ${configPath}.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    const position =
      error instanceof SyntaxError && typeof error.message === 'string'
        ? /position\s+(\d+)/.exec(error.message)?.[1]
        : undefined;
    throw new ConfigValidationError([
      `configuration file: contains malformed JSON${
        position === undefined ? '' : ` near position ${position}`
      }`,
    ]);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigValidationError([
      'configuration file: root value must be a JSON object',
    ]);
  }

  return parsed as Record<string, unknown>;
}

/**
 * Loads and validates configuration using file, environment, then CLI precedence.
 * Provider-specific base URL defaults are applied after the layers are merged.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<AtlasConfig> {
  const configPath = resolveConfigPath(options);
  const env = options.env ?? process.env;
  const fileValues = await readConfigFile(configPath);
  const merged: Record<string, unknown> = {
    ...fileValues,
    ...environmentOverrides(env),
    ...(options.overrides ?? {}),
  };

  if (
    !hasConfigValues(fileValues) &&
    !hasConfigValues(environmentOverrides(env)) &&
    Object.keys(options.overrides ?? {}).length === 0
  ) {
    throw new ConfigNotFoundError(configPath);
  }

  if (merged.provider === undefined) {
    throw new ConfigValidationError([
      'provider: is required; set it to "openai-compatible" or "anthropic-compatible"',
    ]);
  }

  const providerResult = atlasConfigSchema.shape.provider.safeParse(
    merged.provider,
  );
  if (!providerResult.success) {
    throw new ConfigValidationError(safeValidationIssues(providerResult.error));
  }

  const provider: ProviderName = providerResult.data;
  const hasEnvironmentBaseUrl = env.ATLAS_BASE_URL !== undefined;
  const hasCliBaseUrl = options.overrides?.baseUrl !== undefined;
  const fileProvider = fileValues.provider;
  const fileBaseUrl = fileValues.baseUrl;
  const providerChanged =
    typeof fileProvider === 'string' &&
    fileProvider !== provider &&
    fileBaseUrl === DEFAULT_BASE_URLS[fileProvider as ProviderName];

  if (
    merged.baseUrl === undefined ||
    ((providerChanged || !hasConfigValues(fileValues)) && !hasCliBaseUrl) ||
    (providerChanged && !hasEnvironmentBaseUrl && !hasCliBaseUrl)
  ) {
    merged.baseUrl = DEFAULT_BASE_URLS[provider];
  }

  return assertValidConfig(merged);
}

/** Validates and atomically writes an Atlas config file with private permissions. */
export async function saveConfig(
  configPath: string,
  config: AtlasConfig,
): Promise<void> {
  const validated = assertValidConfig(config);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const directory = dirname(resolve(configPath));
  const temporaryPath = resolve(
    directory,
    `.config.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, resolve(configPath));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ConfigFileError(
      `Could not write Atlas configuration at ${configPath}.`,
      {
        cause: error,
      },
    );
  }
}
