import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

const LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1';
const OPENAI_DEFAULT = 'https://api.openai.com/v1';
const ANTHROPIC_DEFAULT = 'https://api.anthropic.com/v1';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-base-url-'));
}

async function writeConfig(
  directory: string,
  values: Record<string, unknown>,
): Promise<string> {
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(values));
  return configPath;
}

describe('base URL precedence', () => {
  it('honors ATLAS_BASE_URL when no config file exists', async () => {
    const directory = await temporaryDirectory();

    try {
      const config = await loadConfig({
        configPath: join(directory, 'missing.json'),
        env: {
          ATLAS_PROVIDER: 'openai-compatible',
          ATLAS_API_KEY: 'env-key',
          ATLAS_MODEL: 'env-model',
          ATLAS_BASE_URL: LOCAL_BASE_URL,
        },
      });

      expect(config.baseUrl).toBe(LOCAL_BASE_URL);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets an explicit CLI base URL beat ATLAS_BASE_URL', async () => {
    const directory = await temporaryDirectory();

    try {
      const config = await loadConfig({
        configPath: join(directory, 'missing.json'),
        env: {
          ATLAS_PROVIDER: 'openai-compatible',
          ATLAS_API_KEY: 'env-key',
          ATLAS_MODEL: 'env-model',
          ATLAS_BASE_URL: LOCAL_BASE_URL,
        },
        overrides: { baseUrl: 'https://cli.example/v1' },
      });

      expect(config.baseUrl).toBe('https://cli.example/v1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the config file base URL when neither env nor CLI supplies one', async () => {
    const directory = await temporaryDirectory();

    try {
      const configPath = await writeConfig(directory, {
        provider: 'openai-compatible',
        apiKey: 'file-key',
        baseUrl: 'https://file.example/v1',
        model: 'file-model',
      });

      const config = await loadConfig({ configPath, env: {} });

      expect(config.baseUrl).toBe('https://file.example/v1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resets a stale provider default when the provider changes and no env base URL is set', async () => {
    const directory = await temporaryDirectory();

    try {
      const configPath = await writeConfig(directory, {
        provider: 'openai-compatible',
        apiKey: 'file-key',
        baseUrl: OPENAI_DEFAULT,
        model: 'file-model',
      });

      const config = await loadConfig({
        configPath,
        env: { ATLAS_PROVIDER: 'anthropic-compatible' },
      });

      expect(config.baseUrl).toBe(ANTHROPIC_DEFAULT);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps ATLAS_BASE_URL when the provider also changed', async () => {
    const directory = await temporaryDirectory();

    try {
      const configPath = await writeConfig(directory, {
        provider: 'openai-compatible',
        apiKey: 'file-key',
        baseUrl: OPENAI_DEFAULT,
        model: 'file-model',
      });

      const config = await loadConfig({
        configPath,
        env: {
          ATLAS_PROVIDER: 'anthropic-compatible',
          ATLAS_BASE_URL: LOCAL_BASE_URL,
        },
      });

      expect(config.provider).toBe('anthropic-compatible');
      expect(config.baseUrl).toBe(LOCAL_BASE_URL);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies the provider default when no layer supplies a base URL', async () => {
    const directory = await temporaryDirectory();

    try {
      const configPath = await writeConfig(directory, {
        provider: 'openai-compatible',
        apiKey: 'file-key',
        model: 'file-model',
      });

      const config = await loadConfig({ configPath, env: {} });

      expect(config.baseUrl).toBe(OPENAI_DEFAULT);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an invalid ATLAS_BASE_URL instead of silently defaulting', async () => {
    const directory = await temporaryDirectory();

    try {
      await expect(
        loadConfig({
          configPath: join(directory, 'missing.json'),
          env: {
            ATLAS_PROVIDER: 'openai-compatible',
            ATLAS_API_KEY: 'env-key',
            ATLAS_MODEL: 'env-model',
            ATLAS_BASE_URL: 'not-a-url',
          },
        }),
      ).rejects.toThrow(/baseUrl/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
