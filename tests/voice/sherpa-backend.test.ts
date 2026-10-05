import { describe, expect, it } from 'vitest';

import {
  audioBufferFromPcm,
  pcmFromAudioBuffer,
  type AudioSamples,
  type VerificationResult,
  type Voiceprint,
  type WakeDetectionEvent,
  type WakeWordDetector,
  type SpeakerVerifier,
  type SpeechToText,
} from '../../src/voice/backend.js';
import { VoicePipeline } from '../../src/voice/voice-pipeline.js';
import { FixtureAudioSource } from '../../src/voice/audio-capture.js';
import { loadVoiceConfig } from '../../src/config/voice-config.js';
import { ATLAS_AUDIO } from '../../src/voice/wyoming.js';
import { toFloat32 } from '../../src/voice/backends/sherpa-onnx/audio.js';
import { KEYWORD } from '../../src/voice/backends/sherpa-onnx/wake-word.js';

const RATE = 16_000;
const frameMs = 100;

function tone(amplitude: number, ms = frameMs): Buffer {
  const samples = Math.round((ms / 1000) * RATE);
  const buffer = Buffer.alloc(samples * ATLAS_AUDIO.width);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(amplitude * 32_767), index * 2);
  }
  return buffer;
}

function commandUtterance(speechFrames = 30, silenceFrames = 6) {
  const chunks = [];
  for (let i = 0; i < speechFrames; i += 1) {
    chunks.push({ pcm: tone(0.4), timestampMs: i * frameMs });
  }
  for (let i = 0; i < silenceFrames; i += 1) {
    chunks.push({
      pcm: tone(0),
      timestampMs: (speechFrames + i) * frameMs,
    });
  }
  return chunks;
}

/** A fake backend built to the same interface the sherpa classes implement. */
class FakeSherpaWake implements WakeWordDetector {
  public readonly name = 'sherpa-onnx-keyword-spotter';
  public get info(): string {
    return this.name;
  }
  public preflight(): Promise<void> {
    return Promise.resolve();
  }
  readonly events: WakeDetectionEvent[] = [];
  #callback: ((event: WakeDetectionEvent) => void) | undefined;
  #fired = false;

  public start(): Promise<void> {
    return Promise.resolve();
  }
  public stop(): Promise<void> {
    return Promise.resolve();
  }
  public onDetection(callback: (event: WakeDetectionEvent) => void): void {
    this.#callback = callback;
  }

  public takePendingDetection(): WakeDetectionEvent | undefined {
    return undefined;
  }
  public push(pcm: Buffer): void {
    if (this.#fired) return;
    this.#fired = true;
    const event: WakeDetectionEvent = {
      keyword: KEYWORD,
      score: undefined,
      audio: audioBufferFromPcm(pcm, RATE),
    };
    this.events.push(event);
    this.#callback?.(event);
  }
  public dispose(): void {
    this.#callback = undefined;
  }
}

class FakeSherpaSpeaker implements SpeakerVerifier {
  public readonly name = 'sherpa-onnx-speaker-verification';
  public get info(): string {
    return this.name;
  }
  public preflight(): Promise<void> {
    return Promise.resolve();
  }
  readonly results: VerificationResult[] = [];
  #index = 0;

  public enroll(): Promise<Voiceprint> {
    return Promise.resolve({
      backend: this.name,
      model: 'test',
      embedding: [1, 0, 0],
      enrolledMs: 1,
      sampleMs: [1],
      enrolledAt: '',
    });
  }

  public verify(audio: AudioSamples): Promise<VerificationResult> {
    const ms = (audio.samples.length / audio.sampleRate) * 1000;
    const next =
      this.results[Math.min(this.#index, this.results.length - 1)] ??
      this.results[this.results.length - 1];
    this.#index += 1;
    return Promise.resolve(
      next ?? { accepted: false, score: 0, threshold: 0.55, audioMs: ms },
    );
  }

  public dispose(): void {
    this.#index = 0;
  }
}

class FakeSherpaStt implements SpeechToText {
  public readonly name = 'sherpa-onnx-whisper';
  public get info(): string {
    return this.name;
  }
  public preflight(): Promise<void> {
    return Promise.resolve();
  }
  readonly lengths: number[] = [];
  readonly #text: string;
  public constructor(text = 'how much disk space is left') {
    this.#text = text;
  }
  public transcribe(
    audio: AudioSamples,
  ): Promise<{ text: string; language: string | undefined }> {
    this.lengths.push(audio.samples.length);
    return Promise.resolve({ text: this.#text, language: 'en' });
  }
  public dispose(): void {
    this.lengths.length = 0;
  }
}

function config(speakerCheck: 'advisory' | 'enforce' | 'off' = 'enforce') {
  const base = loadVoiceConfig({ speakerCheck }, {});
  return {
    ...base,
    speakerCheck,
    vad: {
      silenceThreshold: 0.01,
      startMs: 100,
      hangoverMs: 200,
      maxUtteranceMs: 5_000,
    },
    minVerificationMs: 2_000,
    maxVerificationMs: 6_000,
  };
}

const accept: VerificationResult = {
  accepted: true,
  score: 0.91,
  threshold: 0.55,
  audioMs: 1_200,
};
const reject: VerificationResult = {
  accepted: false,
  score: 0.11,
  threshold: 0.55,
  audioMs: 1_200,
  reason: 'Speaker does not match the enrolled owner.',
};

describe('sherpa-onnx activation pipeline', () => {
  it('reaches STT and hands text to the conversation loop on a verified wake', async () => {
    const transcripts: string[] = [];
    const stt = new FakeSherpaStt();
    const wake = new FakeSherpaWake();
    const pipeline = new VoicePipeline({
      config: config(),
      detector: {
        push: (pcm: Buffer) => {
          const before = wake.events.length;
          wake.push(pcm);
          const added = wake.events.length > before;
          return Promise.resolve(added ? wake.events.at(-1) : undefined);
        },
        start: () => wake.start(),
        stop: () => wake.stop(),
        onDetection: (cb: (event: WakeDetectionEvent) => void): void => {
          wake.onDetection(cb);
        },
        takePendingDetection: (): WakeDetectionEvent | undefined =>
          wake.takePendingDetection(),
        preflight: () => Promise.resolve(),
        info: wake.name,
      } as never,
      verifier: Object.assign(new FakeSherpaSpeaker(), {
        results: [accept],
      }),
      stt: stt,
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });

    await pipeline.run(new FixtureAudioSource(commandUtterance()));

    expect(wake.events).toHaveLength(1);
    expect(wake.events[0]?.keyword).toBe(KEYWORD);
    expect(transcripts).toEqual(['how much disk space is left']);
    expect(stt.lengths.length).toBeGreaterThan(0);
  });

  it('returns silently when speaker verification fails', async () => {
    const transcripts: string[] = [];
    const stt = new FakeSherpaStt();
    const wake = new FakeSherpaWake();
    const pipeline = new VoicePipeline({
      config: config(),
      detector: {
        push: (pcm: Buffer) => {
          const before = wake.events.length;
          wake.push(pcm);
          const added = wake.events.length > before;
          return Promise.resolve(added ? wake.events.at(-1) : undefined);
        },
        start: () => wake.start(),
        stop: () => wake.stop(),
        onDetection: (cb: (event: WakeDetectionEvent) => void) => {
          wake.onDetection(cb);
        },
        takePendingDetection: (): WakeDetectionEvent | undefined =>
          wake.takePendingDetection(),
        preflight: () => Promise.resolve(),
        info: wake.name,
      } as never,
      verifier: Object.assign(new FakeSherpaSpeaker(), {
        results: [reject],
      }),
      stt: stt,
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });

    await pipeline.run(new FixtureAudioSource(commandUtterance()));

    expect(transcripts).toEqual([]);
    expect(stt.lengths).toEqual([]);
  });

  it('records a correction on the sherpa path', async () => {
    const corrections: string[] = [];
    const stt = new FakeSherpaStt('no, I said show my disk usage');
    const wake = new FakeSherpaWake();
    const pipeline = new VoicePipeline({
      config: config(),
      detector: {
        push: (pcm: Buffer) => {
          const before = wake.events.length;
          wake.push(pcm);
          const added = wake.events.length > before;
          return Promise.resolve(added ? wake.events.at(-1) : undefined);
        },
        start: () => wake.start(),
        stop: () => wake.stop(),
        onDetection: (cb: (event: WakeDetectionEvent) => void) => {
          wake.onDetection(cb);
        },
        takePendingDetection: (): WakeDetectionEvent | undefined =>
          wake.takePendingDetection(),
        preflight: () => Promise.resolve(),
        info: wake.name,
      } as never,
      verifier: Object.assign(new FakeSherpaSpeaker(), {
        results: [accept],
      }),
      stt: stt,
      corrections: {
        recordHeard: () => Promise.resolve(1),
        recordCorrection: (text: string) => {
          corrections.push(text);
          return Promise.resolve(2);
        },
      },
      onTranscript: (): Promise<void> => Promise.resolve(),
    });

    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(corrections).toEqual(['no, I said show my disk usage']);
  });
});

describe('sherpa-onnx audio conversion', () => {
  it('round-trips PCM through Float32 samples', () => {
    const pcm = tone(0.5, 50);
    const audio = audioBufferFromPcm(pcm, RATE);
    expect(audio.samples.length).toBe(pcm.length / 2);
    expect(audio.sampleRate).toBe(RATE);
    const back = pcmFromAudioBuffer(audio);
    expect(back.length).toBe(pcm.length);
    // 16-bit round-trip is near-lossless.
    const original = pcm.readInt16LE(0);
    const restored = back.readInt16LE(0);
    expect(Math.abs(original - restored)).toBeLessThanOrEqual(1);
  });

  it('clamps out-of-range floats when writing', () => {
    const audio: AudioSamples = {
      samples: Float32Array.from([2, -2, 0]),
      sampleRate: RATE,
    };
    const pcm = pcmFromAudioBuffer(audio);
    expect(pcm.readInt16LE(0)).toBe(32_767);
    expect(pcm.readInt16LE(2)).toBe(-32_767);
  });

  it('produces the same samples as the sherpa helper', () => {
    const pcm = tone(0.3, 20);
    const a = toFloat32(pcm);
    const b = audioBufferFromPcm(pcm, RATE).samples;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toBeCloseTo(b[i] ?? 0, 6);
    }
  });

  it('handles an empty buffer', () => {
    const audio = audioBufferFromPcm(Buffer.alloc(0), RATE);
    expect(audio.samples.length).toBe(0);
    expect(pcmFromAudioBuffer(audio).length).toBe(0);
  });
});

describe('sherpa-onnx keyword', () => {
  it('uses the wake phrase in sherpa keyword syntax', () => {
    expect(KEYWORD).toBe('hey atlas');
    expect(KEYWORD).not.toContain('@');
  });
});
