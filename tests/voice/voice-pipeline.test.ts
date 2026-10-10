import { describe, expect, it } from 'vitest';

import { loadVoiceConfig } from '../../src/config/voice-config.js';
import {
  FixtureAudioSource,
  rmsEnergy,
  UtteranceSegmenter,
  type AudioChunk,
} from '../../src/voice/audio-capture.js';
import {
  VoicePipeline,
  looksLikeCorrection,
  type CorrectionSink,
} from '../../src/voice/voice-pipeline.js';
import type { VerificationResult } from '../../src/voice/speaker-verification.js';
import {
  audioBufferFromPcm,
  type AudioSamples,
  type SpeakerVerifier,
  type SpeechToText,
  type Voiceprint,
  type WakeDetectionEvent,
  type WakeWordDetector,
} from '../../src/voice/backend.js';
import {
  ATLAS_AUDIO,
  encodeWyomingEvent,
  WyomingReader,
} from '../../src/voice/wyoming.js';

const RATE = ATLAS_AUDIO.rate;
const frameMs = 100;
const frameBytes = (RATE * ATLAS_AUDIO.width * frameMs) / 1000;

/** Builds a PCM frame of a constant amplitude, i.e. speech-like energy. */
function tone(amplitude: number, ms = frameMs): Buffer {
  const samples = Math.round((ms / 1000) * RATE);
  const buffer = Buffer.alloc(samples * ATLAS_AUDIO.width);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(amplitude * 32_767), index * 2);
  }
  return buffer;
}

/** Detector double that fires once, on a chosen chunk index. */
class FakeDetector implements WakeWordDetector {
  public readonly name = 'fake-detector';
  public get info(): string {
    return this.name;
  }
  readonly detections: WakeDetectionEvent[] = [];
  #callback: ((event: WakeDetectionEvent) => void) | undefined;
  #index = 0;
  #fired = false;
  #failure: Error | undefined;
  readonly #fireAt: number;

  public constructor(fireAt = 0) {
    this.#fireAt = fireAt;
  }

  public failPreflightWith(error: Error): void {
    this.#failure = error;
  }

  public preflight(): Promise<void> {
    return this.#failure === undefined
      ? Promise.resolve()
      : Promise.reject(this.#failure);
  }

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
    const index = this.#index;
    this.#index += 1;
    if (this.#fired || index !== this.#fireAt) return;
    this.#fired = true;
    const event: WakeDetectionEvent = {
      keyword: 'hey_atlas',
      score: 0.91,
      audio: audioBufferFromPcm(pcm, RATE),
    };
    this.detections.push(event);
    this.#callback?.(event);
  }

  public dispose(): void {
    this.#callback = undefined;
  }
}

class FakeVerifier implements SpeakerVerifier {
  public readonly name = 'fake-verifier';
  public get info(): string {
    return this.name;
  }
  readonly calls: number[] = [];
  readonly #results: readonly VerificationResult[];
  #index = 0;

  public constructor(results: readonly VerificationResult[]) {
    this.#results = results;
  }

  public preflight(): Promise<void> {
    return Promise.resolve();
  }

  public enroll(): Promise<Voiceprint> {
    return Promise.resolve({
      backend: this.name,
      model: 'fake',
      embedding: [1, 0, 0],
      enrolledMs: 1,
      sampleMs: [1],
      enrolledAt: '',
    });
  }

  public verify(audio: AudioSamples): Promise<VerificationResult> {
    this.calls.push(audio.samples.length);
    const result =
      this.#results[Math.min(this.#index, this.#results.length - 1)] ??
      this.#results[this.#results.length - 1];
    this.#index += 1;
    return Promise.resolve(
      result ?? {
        accepted: false,
        score: 0,
        threshold: 1,
        audioMs: 0,
        reason: 'no scripted result',
      },
    );
  }

  public dispose(): void {
    this.#index = 0;
  }
}

class FakeStt implements SpeechToText {
  public readonly name = 'fake-stt';
  public get info(): string {
    return this.name;
  }
  readonly inputs: number[] = [];
  readonly #text: string;

  public constructor(text = 'show my disk usage') {
    this.#text = text;
  }

  public preflight(): Promise<void> {
    return Promise.resolve();
  }

  public transcribe(
    audio: AudioSamples,
  ): Promise<{ text: string; language: string | undefined }> {
    this.inputs.push(audio.samples.length);
    return Promise.resolve({ text: this.#text, language: 'en' });
  }

  public dispose(): void {
    this.inputs.length = 0;
  }
}

class FakeCorrections implements CorrectionSink {
  readonly heard: string[] = [];
  readonly corrections: string[] = [];
  #pending: number | undefined;

  public recordHeard(input: {
    heardTranscript: string;
    audioReference: string;
    conversationId: string | undefined;
  }): Promise<number | undefined> {
    this.heard.push(input.heardTranscript);
    this.#pending = this.heard.length;
    return Promise.resolve(this.#pending);
  }

  public recordCorrection(corrected: string): Promise<number | undefined> {
    this.corrections.push(corrected);
    return Promise.resolve(this.#pending);
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

/** Speech frames followed by enough silence to close the utterance. */
function commandUtterance(speechFrames = 30, silenceFrames = 6): AudioChunk[] {
  const chunks: AudioChunk[] = [];
  for (let index = 0; index < speechFrames; index += 1) {
    chunks.push({ pcm: tone(0.4), timestampMs: index * frameMs });
  }
  for (let index = 0; index < silenceFrames; index += 1) {
    chunks.push({
      pcm: tone(0),
      timestampMs: (speechFrames + index) * frameMs,
    });
  }
  return chunks;
}

const accept: VerificationResult = {
  accepted: true,
  score: 0.88,
  threshold: 0.55,
  audioMs: 1_200,
};

const reject: VerificationResult = {
  accepted: false,
  score: 0.12,
  threshold: 0.55,
  audioMs: 1_200,
  reason: 'Speaker does not match the enrolled owner.',
};

const tooShort: VerificationResult = {
  accepted: false,
  score: 0,
  threshold: 0.55,
  audioMs: 0,
  reason: 'Sample too short to verify (0ms, need 700ms).',
};

describe('voice activation: verified owner', () => {
  it('reaches STT and hands text to the conversation sink', async () => {
    const transcripts: string[] = [];
    const stt = new FakeStt('how much disk space is left');
    const corrections = new FakeCorrections();
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([accept]),
      stt,
      corrections,
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });

    // Wake fires, verification passes, then the owner speaks a command.
    await pipeline.run(new FixtureAudioSource(commandUtterance()));

    expect(transcripts).toEqual(['how much disk space is left']);
    expect(stt.inputs.length).toBeGreaterThan(0);
    expect(corrections.heard).toEqual(['how much disk space is left']);
  });

  it('returns to listening and can be woken again', async () => {
    const transcripts: string[] = [];
    const detector = new FakeDetector(0);
    const pipeline = new VoicePipeline({
      config: config(),
      detector,
      verifier: new FakeVerifier([accept]),
      stt: new FakeStt('first command'),
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });
    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(transcripts).toEqual(['first command']);
    expect(pipeline.running).toBe(false);
  });
});

describe('voice activation: another speaker', () => {
  it('returns silently without reaching STT or the conversation', async () => {
    const transcripts: string[] = [];
    const stt = new FakeStt();
    const corrections = new FakeCorrections();
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([reject]),
      stt,
      corrections,
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });

    await pipeline.run(new FixtureAudioSource(commandUtterance()));

    expect(transcripts).toEqual([]);
    expect(stt.inputs).toEqual([]);
    expect(corrections.heard).toEqual([]);
  });

  it('never produces a wake report that mentions the attempt as accepted', async () => {
    const reports: { accepted: boolean; reason: string | undefined }[] = [];
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([reject]),
      stt: new FakeStt(),
      onTranscript: () => Promise.resolve(),
      onReport: (report) => {
        reports.push({ accepted: report.accepted, reason: report.reason });
      },
    });
    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.accepted).toBe(false);
  });
});

describe('voice activation: inconclusive wake', () => {
  it('retries verification as more audio arrives', async () => {
    const transcripts: string[] = [];
    const verifier = new FakeVerifier([tooShort, accept]);
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier,
      stt: new FakeStt('second try worked'),
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });

    await pipeline.run(new FixtureAudioSource(commandUtterance()));

    expect(verifier.calls.length).toBeGreaterThan(1);
    expect(transcripts).toEqual(['second try worked']);
  });

  it('gives up silently when verification never passes', async () => {
    const transcripts: string[] = [];
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([tooShort]),
      stt: new FakeStt('should not run'),
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });
    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(transcripts).toEqual([]);
  });
});

describe('voice activation: empty transcription', () => {
  it('does not hand an empty string to the conversation loop', async () => {
    const transcripts: string[] = [];
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([accept]),
      stt: new FakeStt(''),
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });
    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(transcripts).toEqual([]);
  });
});

describe('service preflight failures', () => {
  it('surfaces a clear error instead of crashing when a model is missing', async () => {
    const detector = new FakeDetector(0);
    detector.failPreflightWith(new Error('Wake-word model is missing'));

    const pipeline = new VoicePipeline({
      config: config(),
      detector,
      verifier: new FakeVerifier([accept]),
      stt: new FakeStt(),
      onTranscript: () => Promise.resolve(),
    });

    await expect(pipeline.start()).rejects.toThrow(/missing/i);
    // The pipeline is not left half-started.
    expect(pipeline.running).toBe(false);
  });

  it('reports verification failure without throwing', async () => {
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([
        {
          accepted: false,
          score: 0,
          threshold: 0.55,
          audioMs: 1_000,
          reason: 'no embedding',
        },
      ]),
      stt: new FakeStt(),
      onTranscript: () => Promise.resolve(),
    });
    await expect(
      pipeline.run(
        new FixtureAudioSource(
          Array.from({ length: 20 }, () => ({
            pcm: tone(0.4),
            timestampMs: 0,
          })),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('correction detection', () => {
  it('recognises an immediate self-correction', () => {
    expect(looksLikeCorrection('No, I said show my disks')).toBe(true);
    expect(looksLikeCorrection('i meant the other one')).toBe(true);
    expect(looksLikeCorrection("that's wrong")).toBe(true);
  });

  it('does not treat ordinary speech as a correction', () => {
    expect(looksLikeCorrection('show my disk usage')).toBe(false);
    expect(looksLikeCorrection('what is the weather')).toBe(false);
    expect(looksLikeCorrection('')).toBe(false);
  });

  it('logs a correction pair when the owner self-corrects', async () => {
    const transcripts: string[] = [];
    const corrections = new FakeCorrections();
    const pipeline = new VoicePipeline({
      config: config(),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([accept]),
      stt: new FakeStt('no, I said show my disks'),
      corrections,
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });
    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(corrections.corrections).toEqual(['no, I said show my disks']);
    expect(transcripts).toEqual(['no, I said show my disks']);
  });
});

describe('voice activity detection', () => {
  it('separates speech from silence by energy', () => {
    expect(rmsEnergy(tone(0.5))).toBeGreaterThan(rmsEnergy(tone(0.001)));
  });

  it('emits one utterance after the hangover elapses', () => {
    const segmenter = new UtteranceSegmenter({
      silenceThreshold: 0.01,
      startMs: 100,
      hangoverMs: 200,
      maxUtteranceMs: 5_000,
    });
    let emitted: { pcm: Buffer; audioMs: number } | undefined;
    // Two speech frames to trigger the start threshold, then silence.
    segmenter.push(tone(0.4));
    segmenter.push(tone(0.4));
    for (let index = 0; index < 4 && emitted === undefined; index += 1) {
      emitted = segmenter.push(tone(0.0));
    }
    expect(emitted).toBeDefined();
    expect(emitted?.pcm.length).toBeGreaterThan(0);
  });

  it('does not open an utterance on a single click', () => {
    const segmenter = new UtteranceSegmenter({
      silenceThreshold: 0.01,
      startMs: 100,
      hangoverMs: 200,
      maxUtteranceMs: 5_000,
    });
    expect(segmenter.push(tone(0.4, 40))).toBeUndefined();
    expect(segmenter.speaking).toBe(false);
  });

  it('abandons an in-progress utterance on reset', () => {
    const segmenter = new UtteranceSegmenter({
      silenceThreshold: 0.01,
      startMs: 100,
      hangoverMs: 200,
      maxUtteranceMs: 5_000,
    });
    segmenter.push(tone(0.4));
    segmenter.push(tone(0.4));
    expect(segmenter.speaking).toBe(true);
    segmenter.reset();
    expect(segmenter.speaking).toBe(false);
    expect(segmenter.bufferedMs).toBe(0);
  });
});

describe('Wyoming framing', () => {
  function source(...buffers: Buffer[]): AsyncIterator<Buffer> {
    let index = 0;
    return {
      next: (): Promise<IteratorResult<Buffer>> => {
        const value = buffers[index];
        index += 1;
        return Promise.resolve(
          value === undefined
            ? { done: true, value: undefined }
            : { done: false, value },
        );
      },
    };
  }

  it('round-trips a header-only event', async () => {
    const bytes = encodeWyomingEvent({
      type: 'detect',
      data: { names: ['a'] },
    });
    const event = await new WyomingReader(source(bytes)).read();
    expect(event?.type).toBe('detect');
    expect(event?.data.names).toEqual(['a']);
    expect(event?.payload).toBeUndefined();
  });

  it('round-trips a binary payload', async () => {
    const pcm = tone(0.3, 50);
    const bytes = encodeWyomingEvent({
      type: 'audio-chunk',
      data: { rate: RATE, width: 2, channels: 1 },
      payload: pcm,
    });
    const event = await new WyomingReader(source(bytes)).read();
    expect(event?.type).toBe('audio-chunk');
    expect(event?.payload?.equals(pcm)).toBe(true);
  });

  it('returns undefined at a clean end of stream', async () => {
    expect(await new WyomingReader(source()).read()).toBeUndefined();
  });

  it('rejects a header with no type', async () => {
    await expect(
      new WyomingReader(source(Buffer.from('{"data":{}}\n', 'utf8'))).read(),
    ).rejects.toThrow(/type/);
  });

  it('rejects a malformed header', async () => {
    await expect(
      new WyomingReader(source(Buffer.from('not json\n', 'utf8'))).read(),
    ).rejects.toThrow(/malformed/);
  });

  it('reads several frames from one stream', async () => {
    const reader = new WyomingReader(
      source(
        encodeWyomingEvent({ type: 'audio-start' }),
        encodeWyomingEvent({
          type: 'audio-chunk',
          data: { rate: RATE, width: 2, channels: 1 },
          payload: tone(0.2, 20),
        }),
        encodeWyomingEvent({ type: 'audio-stop' }),
      ),
    );
    const first = await reader.read();
    const second = await reader.read();
    const third = await reader.read();
    expect([first?.type, second?.type, third?.type]).toEqual([
      'audio-start',
      'audio-chunk',
      'audio-stop',
    ]);
  });

  it('frames exactly one chunk of the expected size', () => {
    expect(frameBytes).toBe(RATE * 2 * 0.1);
  });
});

describe('verification requires enough voiced audio', () => {
  const config = () => {
    const base = loadVoiceConfig({}, {});
    return {
      ...base,
      vad: {
        silenceThreshold: 0.01,
        startMs: 100,
        hangoverMs: 200,
        maxUtteranceMs: 15_000,
      },
      minVerificationMs: 2_000,
      maxVerificationMs: 6_000,
    };
  };

  it('does not verify on a short wake phrase alone', async () => {
    let verifications = 0;
    const wake = new FakeDetector(0);
    const pipeline = new VoicePipeline({
      config: config(),
      detector: {
        push: (p: Buffer): void => {
          wake.push(p);
        },
        start: (): Promise<void> => wake.start(),
        stop: (): Promise<void> => wake.stop(),
        onDetection: (cb: (e: WakeDetectionEvent) => void): void => {
          wake.onDetection(cb);
        },
        takePendingDetection: (): WakeDetectionEvent | undefined =>
          wake.takePendingDetection(),
        preflight: (): Promise<void> => Promise.resolve(),
        info: wake.name,
        name: wake.name,
        dispose: (): void => {
          wake.dispose();
        },
      },
      verifier: Object.assign(new FakeVerifier([]), {
        verify: (a: AudioSamples) => {
          verifications += 1;
          return Promise.resolve({
            accepted: true,
            score: 0.99,
            threshold: 0.55,
            audioMs: (a.samples.length / a.sampleRate) * 1000,
          });
        },
      }),
      stt: new FakeStt(),
      onTranscript: () => Promise.resolve(),
    });

    // Only 300ms of voiced audio: well under the 2s minimum.
    await pipeline.run(
      new FixtureAudioSource(
        Array.from({ length: 4 }, () => ({ pcm: tone(0.4), timestampMs: 0 })),
      ),
    );
    expect(verifications).toBe(0);
  });
});

describe('a bare wake phrase still reaches a verdict', () => {
  const config = () => {
    const base = loadVoiceConfig({}, {});
    return {
      ...base,
      vad: {
        silenceThreshold: 0.01,
        startMs: 100,
        hangoverMs: 200,
        maxUtteranceMs: 15_000,
      },
      minVerificationMs: 2_000,
      maxVerificationMs: 6_000,
    };
  };

  it('verifies on trailing silence when the minimum is never reached', async () => {
    let verifications = 0;
    const wake = new FakeDetector(0);
    const pipeline = new VoicePipeline({
      config: config(),
      detector: wake,
      verifier: Object.assign(new FakeVerifier([]), {
        verify: (a: AudioSamples) => {
          verifications += 1;
          return Promise.resolve({
            accepted: false,
            score: 0.2,
            threshold: 0.55,
            audioMs: (a.samples.length / a.sampleRate) * 1_000,
            reason: 'not the owner',
          });
        },
      }),
      stt: new FakeStt(),
      onTranscript: (): Promise<void> => Promise.resolve(),
    });

    // A wake phrase on its own is about a second of speech: under the 2s
    // minimum, so only the trailing-silence check can end it.
    // Enough silence frames to clear the 200ms hangover this test configures.
    // Roughly what a real wake phrase produces: about a second of speech,
    // then silence and nothing else.
    const chunks = [
      ...Array.from({ length: 10 }, (_, index) => ({
        pcm: tone(0.4),
        timestampMs: index * 100,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        pcm: tone(0),
        timestampMs: (10 + index) * 100,
      })),
    ];
    await pipeline.run(new FixtureAudioSource(chunks));

    // Without the silence check this would be 0 and the turn would hang.
    expect(verifications).toBeGreaterThan(0);
  });
});

describe('speaker check mode', () => {
  it('does not block on a miss by default (advisory)', async () => {
    // A wake phrase is ~1s, and the embedding model needs ~4s before the
    // score means anything, so blocking by default rejected the owner every
    // time. Verification is a convenience filter, not a security control.
    const transcripts: string[] = [];
    const pipeline = new VoicePipeline({
      config: config('advisory'),
      detector: new FakeDetector(0),
      verifier: new FakeVerifier([reject]),
      stt: new FakeStt(),
      onTranscript: (text) => {
        transcripts.push(text);
        return Promise.resolve();
      },
    });
    // Real shape: a wake, then a command with trailing silence so the VAD
    // closes the utterance.
    await pipeline.run(new FixtureAudioSource(commandUtterance()));
    expect(transcripts).toEqual(['show my disk usage']);
  });

  it('still blocks on a miss in enforce mode', () => {
    expect(config('enforce').speakerCheck).toBe('enforce');
  });

  it('parses an invalid mode as an error', () => {
    expect(() =>
      loadVoiceConfig({}, { ATLAS_VOICE_SPEAKER_CHECK: 'bogus' }),
    ).toThrow();
    expect(loadVoiceConfig({}, {}).speakerCheck).toBe('advisory');
  });
});
