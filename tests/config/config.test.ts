import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigNotFoundError,
  ConfigValidationError,
} from '../../src/errors.js';
import {
  getDefaultConfigPath,
  loadConfig,
  saveConfig,
} from '../../src/config/config.js';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-config-'));
}

describe('loadConfig', () => {
  it('loads a JSON file and applies the provider default base URL', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'openai-compatible',
        apiKey: 'file-key',
        model: 'gpt-test',
      }),
    );

    try {
      await expect(loadConfig({ configPath, env: {} })).resolves.toMatchObject({
        provider: 'openai-compatible',
        apiKey: 'file-key',
        model: 'gpt-test',
        baseUrl: 'https://api.openai.com/v1',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies environment and CLI values in precedence order', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'openai-compatible',
        apiKey: 'file-key',
        baseUrl: 'https://file.example/v1',
        model: 'file-model',
      }),
    );

    try {
      const config = await loadConfig({
        configPath,
        env: {
          ATLAS_PROVIDER: 'anthropic-compatible',
          ATLAS_API_KEY: 'env-key',
          ATLAS_MODEL: 'env-model',
        },
        overrides: { model: 'cli-model' },
      });

      expect(config).toMatchObject({
        provider: 'anthropic-compatible',
        apiKey: 'env-key',
        baseUrl: 'https://file.example/v1',
        model: 'cli-model',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a missing file clearly', async () => {
    const directory = await temporaryDirectory();
    try {
      await expect(
        loadConfig({ configPath: join(directory, 'missing.json'), env: {} }),
      ).rejects.toBeInstanceOf(ConfigNotFoundError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports invalid fields without echoing invalid secrets', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'openai-compatible',
        apiKey: 'invalid-secret',
        model: 123,
      }),
    );

    try {
      await expect(loadConfig({ configPath, env: {} })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ConfigValidationError &&
          !error.message.includes('invalid-secret') &&
          error.message.includes('model'),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('saveConfig', () => {
  it('writes valid JSON that can be loaded again', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'nested', 'config.json');
    const config = {
      provider: 'anthropic-compatible' as const,
      apiKey: 'secret',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test',
    };

    try {
      await saveConfig(configPath, config);
      await expect(loadConfig({ configPath, env: {} })).resolves.toEqual(
        config,
      );
      await expect(readFile(configPath, 'utf8')).resolves.toContain(
        '"apiKey": "secret"',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('getDefaultConfigPath', () => {
  it('uses the Atlas directory under the supplied home directory', () => {
    expect(getDefaultConfigPath('/tmp/atlas-home')).toBe(
      '/tmp/atlas-home/.atlas/config.json',
    );
  });
});
