import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigNotFoundError,
  ConfigValidationError,
} from '../../src/errors.js';
import { loadConfig } from '../../src/config/config.js';

const COMPLETE_ENVIRONMENT = {
  ATLAS_PROVIDER: 'openai-compatible',
  ATLAS_API_KEY: 'env-key',
  ATLAS_MODEL: 'env-model',
} as const;

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-env-'));
}

async function loadFromEnvironment(
  env: Record<string, string>,
): Promise<{ temperature?: number; maxTokens?: number; model: string }> {
  const directory = await temporaryDirectory();
  try {
    const config = await loadConfig({
      configPath: join(directory, 'missing.json'),
      env: { ...COMPLETE_ENVIRONMENT, ...env },
    });
    return {
      ...(config.temperature === undefined
        ? {}
        : { temperature: config.temperature }),
      ...(config.maxTokens === undefined
        ? {}
        : { maxTokens: config.maxTokens }),
      model: config.model,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('numeric environment overrides', () => {
  it('parses valid numeric values', async () => {
    await expect(
      loadFromEnvironment({
        ATLAS_MAX_TOKENS: '4096',
        ATLAS_TEMPERATURE: '0.7',
      }),
    ).resolves.toEqual({
      maxTokens: 4096,
      temperature: 0.7,
      model: 'env-model',
    });
  });

  it('names ATLAS_MAX_TOKENS when the value is not a number', async () => {
    await expect(
      loadFromEnvironment({ ATLAS_MAX_TOKENS: 'abc' }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.issues.some((issue) => issue.includes('ATLAS_MAX_TOKENS')),
    );
  });

  it('names ATLAS_TEMPERATURE when the value is not a number', async () => {
    await expect(
      loadFromEnvironment({ ATLAS_TEMPERATURE: 'warm' }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.issues.some((issue) => issue.includes('ATLAS_TEMPERATURE')),
    );
  });

  it('rejects an empty numeric value rather than reading it as zero', async () => {
    await expect(
      loadFromEnvironment({ ATLAS_TEMPERATURE: '' }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(
      loadFromEnvironment({ ATLAS_MAX_TOKENS: '' }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('reports out-of-range numbers against the configuration field', async () => {
    await expect(
      loadFromEnvironment({ ATLAS_TEMPERATURE: '9' }),
    ).rejects.toThrow(/temperature/);
    await expect(
      loadFromEnvironment({ ATLAS_MAX_TOKENS: '-4' }),
    ).rejects.toThrow(/maxTokens/);
  });
});

describe('string environment overrides', () => {
  it('reports the provider field for an unknown ATLAS_PROVIDER', async () => {
    await expect(
      loadFromEnvironment({ ATLAS_PROVIDER: 'gemini' }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.issues.some((issue) => issue.includes('provider')),
    );
  });

  it('rejects empty API key and model overrides', async () => {
    await expect(loadFromEnvironment({ ATLAS_API_KEY: '' })).rejects.toThrow(
      /apiKey/,
    );
    await expect(loadFromEnvironment({ ATLAS_MODEL: '' })).rejects.toThrow(
      /model/,
    );
  });

  it('lets environment values override the config file', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'openai-compatible',
        apiKey: 'file-key',
        baseUrl: 'https://file.example/v1',
        model: 'file-model',
        maxTokens: 512,
        temperature: 0.2,
      }),
    );

    try {
      const config = await loadConfig({
        configPath,
        env: {
          ATLAS_MAX_TOKENS: '1024',
          ATLAS_TEMPERATURE: '1.5',
        },
      });

      expect(config).toMatchObject({
        apiKey: 'file-key',
        baseUrl: 'https://file.example/v1',
        model: 'file-model',
        maxTokens: 1024,
        temperature: 1.5,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('still reports a missing configuration file and environment as ConfigNotFoundError', async () => {
    const directory = await temporaryDirectory();
    try {
      await expect(
        loadConfig({ configPath: join(directory, 'missing.json'), env: {} }),
      ).rejects.toBeInstanceOf(ConfigNotFoundError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
