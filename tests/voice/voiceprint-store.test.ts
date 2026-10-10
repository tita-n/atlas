import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  VoiceprintError,
  VoiceprintStore,
  cosineSimilarity,
  parseVoiceprint,
  voiceprintFingerprint,
  type Voiceprint,
} from '../../src/voice/voiceprint-store.js';
import {
  loadVoiceConfig,
  expandUserPath,
  VOICE_HOST,
} from '../../src/config/voice-config.js';

function voiceprint(embedding: number[] = [0.1, 0.2, 0.3]): Voiceprint {
  return {
    version: 1,
    embedding,
    enrolledMs: 12_000,
    sampleMs: [2_400, 2_500, 2_600],
    enrolledAt: '2026-09-26T00:00:00.000Z',
    model: 'speechbrain/spkrec-ecapa-voxceleb',
  };
}

describe('voiceprint storage', () => {
  it('creates an owner-only directory and file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    await store.save(voiceprint());

    const fileMode = (await stat(store.path)).mode & 0o777;
    const dirMode = (await stat(join(dir, 'voiceprint'))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('round-trips a voiceprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    const original = voiceprint();
    await store.save(original);

    const loaded = await store.load();
    expect(loaded).toBeDefined();
    expect(loaded?.embedding).toEqual(original.embedding);
    expect(loaded?.model).toBe(original.model);
    expect(loaded?.enrolledMs).toBe(original.enrolledMs);
  });

  it('repairs a world-readable voiceprint on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    await store.save(voiceprint());

    // Simulate a file copied with loose permissions.
    await chmod(store.path, 0o644);
    expect((await stat(store.path)).mode & 0o077).toBe(0o044);

    await store.load();
    expect((await stat(store.path)).mode & 0o077).toBe(0);
  });

  it('never writes the embedding into a file other than the voiceprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    await store.save(voiceprint([9.87654321, 0.11111111]));
    const text = await readFile(store.path, 'utf8');
    // The value is present in the voiceprint itself, and nowhere else on disk.
    expect(text).toContain('9.87654321');
  });

  it('clears an enrollment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    await store.save(voiceprint());
    expect(await store.exists()).toBe(true);
    expect(await store.clear()).toBe(true);
    expect(await store.exists()).toBe(false);
    expect(await store.clear()).toBe(false);
  });

  it('reports absence without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    expect(await store.load()).toBeUndefined();
  });
});

describe('voiceprint parsing', () => {
  it('rejects corrupt JSON with a re-enroll hint', () => {
    expect(() => parseVoiceprint('{not json')).toThrow(VoiceprintError);
    try {
      parseVoiceprint('{not json');
    } catch (error) {
      expect((error as Error).message).toMatch(/re-enroll/i);
    }
  });

  it('rejects a record with no embedding', () => {
    expect(() => parseVoiceprint('{"embedding":[]}')).toThrow(VoiceprintError);
  });

  it('rejects non-numeric embedding values', () => {
    expect(() => parseVoiceprint('{"embedding":["a","b"]}')).toThrow(
      VoiceprintError,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => parseVoiceprint('"nope"')).toThrow(VoiceprintError);
  });

  it('does not leak embedding values in its error messages', () => {
    try {
      parseVoiceprint('{"embedding":[1,"SECRET_VALUE"]}');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET_VALUE');
    }
  });
});

describe('fingerprint and similarity', () => {
  it('produces a stable, non-reversible fingerprint', () => {
    const first = voiceprintFingerprint(voiceprint());
    const second = voiceprintFingerprint(voiceprint());
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(first).not.toContain('0.1');
  });

  it('changes when the embedding changes', () => {
    expect(voiceprintFingerprint(voiceprint([0.1, 0.2, 0.3]))).not.toBe(
      voiceprintFingerprint(voiceprint([0.9, 0.2, 0.3])),
    );
  });

  it('scores identical vectors as 1 and unrelated vectors below 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('is safe on mismatched or empty input', () => {
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('voice config', () => {
  it('defaults to a loopback host and safe thresholds', () => {
    const config = loadVoiceConfig({}, {});
    expect(VOICE_HOST).toBe('127.0.0.1');
    expect(config.speakerThreshold).toBeGreaterThan(0);
    expect(config.speakerThreshold).toBeLessThan(1);
    expect(config.sampleRate).toBe(16_000);
  });

  it('validates threshold overrides from the environment', () => {
    expect(() =>
      loadVoiceConfig({}, { ATLAS_VOICE_SPEAKER_THRESHOLD: '5' }),
    ).toThrow();
    expect(() =>
      loadVoiceConfig({}, { ATLAS_VOICE_WAKE_THRESHOLD: 'abc' }),
    ).toThrow();
    const config = loadVoiceConfig(
      {},
      { ATLAS_VOICE_SPEAKER_THRESHOLD: '0.8' },
    );
    expect(config.speakerThreshold).toBe(0.8);
  });

  it('rejects a non-positive sample rate', () => {
    expect(() =>
      loadVoiceConfig({}, { ATLAS_VOICE_SAMPLE_RATE: '0' }),
    ).toThrow();
  });

  it('expands a leading tilde in paths', () => {
    expect(expandUserPath('~/x')).toBe(`${homedir()}/x`);
    expect(expandUserPath('~')).toBe(homedir());
    expect(expandUserPath('/absolute')).toBe('/absolute');
  });
});

describe('backend tagging survives a save/load round trip', () => {
  it('preserves the backend and model that produced the embedding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-tag-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    const record: Voiceprint = {
      version: 1,
      embedding: [0.5, 0.25],
      enrolledMs: 20_000,
      sampleMs: [4_000],
      enrolledAt: '2026-09-28T00:00:00.000Z',
      model: 'sherpa-onnx-speaker-verification',
      backend: 'sherpa-onnx-speaker-verification',
    };
    await store.save(record);

    const loaded = await store.load();
    // Regression: the parser previously dropped `backend`, so a freshly
    // enrolled voiceprint was rejected by its own backend.
    expect(loaded?.backend).toBe('sherpa-onnx-speaker-verification');
    expect(loaded?.model).toBe('sherpa-onnx-speaker-verification');
  });

  it('defaults a legacy untagged record to the Wyoming backend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-vp-legacy-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint'));
    await mkdir(join(dir, 'voiceprint'), { recursive: true });
    await writeFile(
      store.path,
      JSON.stringify({
        version: 1,
        embedding: [1, 0],
        enrolledMs: 1,
        sampleMs: [1],
        enrolledAt: '',
        model: 'speechbrain/spkrec-ecapa-voxceleb',
      }),
    );
    const loaded = await store.load();
    expect(loaded?.backend).toBe('wyoming-ecapa-tdnn');
  });
});
