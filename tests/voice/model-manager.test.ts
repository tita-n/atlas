import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ModelManager,
  SHERPA_MODELS,
  describeDownload,
  formatBytes,
  parseVoiceBackend,
  resolveModelProfile,
} from '../../src/voice/model-manager.js';
import { resolveVoiceBackend } from '../../src/voice/backend-factory.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-models-'));
}

describe('download disclosure', () => {
  it('discloses every component and the total before downloading', () => {
    const text = describeDownload('default', '/home/u/.atlas/models');
    expect(text).toMatch(/total/);
    // The wake, speech and speaker lines must all appear.
    expect(text).toContain('keyword spotting');
    expect(text).toContain('Whisper');
    expect(text).toContain('speaker verification');
    expect(text).toContain('/home/u/.atlas/models');
  });

  it('explains the accuracy trade-off for the minimal profile', () => {
    const text = describeDownload('minimal', '/models');
    expect(text).toMatch(/trades accuracy for size/i);
    expect(text).toMatch(/tiny\.en/);
  });

  it('reports sizes in human units', () => {
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(33 * 1024 * 1024)).toBe('33 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  it('picks smaller speech models for the minimal profile', () => {
    expect(SHERPA_MODELS.default.speech.id).toBe('whisper-base.en');
    expect(SHERPA_MODELS.minimal.speech.id).toBe('whisper-tiny.en');
    expect(SHERPA_MODELS.minimal.speech.bytes).toBeLessThan(
      SHERPA_MODELS.default.speech.bytes,
    );
    expect(SHERPA_MODELS.minimal.speaker.bytes).toBeLessThanOrEqual(
      SHERPA_MODELS.default.speaker.bytes,
    );
  });

  it('resolves the profile from the environment', () => {
    expect(resolveModelProfile({})).toBe('default');
    expect(resolveModelProfile({ ATLAS_VOICE_MODELS: 'minimal' })).toBe(
      'minimal',
    );
    expect(resolveModelProfile({ ATLAS_VOICE_MODELS: 'nonsense' })).toBe(
      'default',
    );
  });
});

describe('model caching', () => {
  it('reports a cold cache as incomplete and does not download on check', async () => {
    const root = await tempRoot();
    const models = new ModelManager(root);
    expect(await models.isCached('wake')).toBe(false);
    expect(await models.isComplete()).toBe(false);
    // No network activity: isCached must be a pure filesystem check.
    expect(await readdirSafe(root)).toEqual([]);
  });

  it('uses the cache and does not re-download once present', async () => {
    const root = await tempRoot();
    const models = new ModelManager(root);
    const dir = models.componentDirectory('wake');
    await mkdir(dir, { recursive: true });
    const sentinel = SHERPA_MODELS.default.wake.sentinel;
    await writeFile(join(dir, sentinel), 'cached');

    expect(await models.isCached('wake')).toBe(true);
    // ensure() on a cached component must return without any network access.
    const returned = await models.ensure('wake');
    expect(returned).toBe(dir);
    // The sentinel is untouched, proving nothing was re-fetched.
    expect((await stat(join(dir, sentinel))).isFile()).toBe(true);
  });

  it('treats a partially extracted model as missing', async () => {
    const root = await tempRoot();
    const models = new ModelManager(root);
    const dir = models.componentDirectory('speech');
    await mkdir(dir, { recursive: true });
    // A stray file that is not the sentinel must not count as cached.
    await writeFile(join(dir, 'unrelated.txt'), 'x');
    expect(await models.isCached('speech')).toBe(false);
  });

  it('clears cached models', async () => {
    const root = await tempRoot();
    const models = new ModelManager(root);
    const dir = models.componentDirectory('wake');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SHERPA_MODELS.default.wake.sentinel), 'x');
    expect(await models.isCached('wake')).toBe(true);
    await models.clear();
    expect(await models.isCached('wake')).toBe(false);
  });

  it('reports progress messages when provided', async () => {
    const messages: string[] = [];
    const root = await tempRoot();
    const models = new ModelManager(root, 'default', (m) => messages.push(m));
    expect(models.describe()).toContain('total');
    expect(messages).toEqual([]);
  });
});

describe('backend selection', () => {
  it('defaults to sherpa-onnx', () => {
    expect(resolveVoiceBackend(undefined, {})).toBe('sherpa-onnx');
    expect(resolveVoiceBackend(undefined, { ATLAS_VOICE_BACKEND: '' })).toBe(
      'sherpa-onnx',
    );
  });

  it('honours an explicit flag over the environment', () => {
    expect(
      resolveVoiceBackend('wyoming', { ATLAS_VOICE_BACKEND: 'sherpa-onnx' }),
    ).toBe('wyoming');
    expect(
      resolveVoiceBackend(undefined, { ATLAS_VOICE_BACKEND: 'wyoming' }),
    ).toBe('wyoming');
  });

  it('rejects an unknown backend clearly', () => {
    expect(() => resolveVoiceBackend('nonsense', {})).toThrow(/sherpa-onnx/);
  });

  it('validates backend names in the model layer too', () => {
    expect(parseVoiceBackend('sherpa-onnx')).toBe('sherpa-onnx');
    expect(parseVoiceBackend('wyoming')).toBe('wyoming');
    expect(() => parseVoiceBackend('other')).toThrow();
  });
});

async function readdirSafe(path: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(path);
  } catch {
    return [];
  }
}

describe('model directory resolution', () => {
  const ASSET_DIR = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';

  it('accepts a model placed directly in the component directory', async () => {
    const root = await tempRoot();
    const models = new ModelManager(root);
    const dir = models.componentDirectory('wake');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SHERPA_MODELS.default.wake.sentinel), 'x');
    expect(await models.isCached('wake')).toBe(true);
    expect(await models.modelDirectory('wake')).toBe(dir);
  });

  it('accepts a model left nested by an extracted archive', async () => {
    // A release tarball has its own top-level folder, so extraction produces
    // <component>/<asset-directory>/<sentinel>. Assuming only the flat layout
    // made every archived model report as missing and re-download forever.
    const root = await tempRoot();
    const models = new ModelManager(root);
    const nested = join(models.componentDirectory('wake'), ASSET_DIR);
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, SHERPA_MODELS.default.wake.sentinel), 'x');

    expect(await models.isCached('wake')).toBe(true);
    expect(await models.modelDirectory('wake')).toBe(nested);
  });

  it('reports a missing model rather than guessing', async () => {
    const root = await tempRoot();
    const models = new ModelManager(root);
    expect(await models.isCached('wake')).toBe(false);
  });
});
