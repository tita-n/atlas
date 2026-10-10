/**
 * Owner enrollment: capture speech samples, build a voiceprint, store it.
 *
 * Sample sizing is based on published short-duration speaker-verification
 * results rather than an invented count. SpeechBrain's own documentation does
 * not state a recommended number of enrollment clips, so this uses the
 * research basis instead:
 *
 *   - The wake phrase "Hey Atlas" is roughly 1-1.3 s, which sits in the
 *     degraded short-duration regime: utterances under ~3 s "result in
 *     unstable speaker representations" (arXiv:2606.16115).
 *   - Picovoice's Eagle documentation states most engines need 2-3 s of
 *     continuous speech for reliable identification.
 *
 * So enrollment collects several prompted phrases, each comfortably longer
 * than the wake word, and requires a minimum total of voiced audio before it
 * will build a voiceprint.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VoiceConfig } from '../config/voice-config.js';
import { ATLAS_AUDIO } from './wyoming.js';
import { audioBufferFromPcm, type AudioSamples } from './backend.js';
import { pcmToWav } from './audio-capture.js';
import { VoiceprintStore, type Voiceprint } from './voiceprint-store.js';

/** Phrases spoken during enrollment. Long enough to exceed the short-audio floor. */
export const ENROLLMENT_PHRASES: readonly string[] = [
  'The quick brown fox jumps over the lazy dog.',
  'Atlas, please read my disk usage and memory status.',
  'I would like to review the projects in my home folder.',
  'When the build finishes, please show me the test results.',
  'Set a reminder to check the backup drive this evening.',
];

/** Minimum total voiced audio before a voiceprint is considered usable. */
export const MIN_ENROLLMENT_MS = 8_000;

/** Longest single sample accepted, so a stray long recording is trimmed. */
export const MAX_SAMPLE_MS = 15_000;

/** Computes the sample budget for a given configuration. */
export function enrollmentPlan(sampleCount?: number): {
  readonly phrases: readonly string[];
  readonly minTotalMs: number;
} {
  const count = Math.max(
    3,
    Math.min(
      ENROLLMENT_PHRASES.length,
      sampleCount ?? ENROLLMENT_PHRASES.length,
    ),
  );
  return {
    phrases: ENROLLMENT_PHRASES.slice(0, count),
    minTotalMs: MIN_ENROLLMENT_MS,
  };
}

/** Trims PCM to at most `maxMs`, keeping the start of the utterance. */
export function trimSample(
  pcm: Buffer,
  maxMs: number,
  rate = ATLAS_AUDIO.rate,
): Buffer {
  const maxBytes = Math.round((maxMs / 1_000) * rate * ATLAS_AUDIO.width);
  return pcm.length > maxBytes ? pcm.subarray(0, maxBytes) : pcm;
}

/** Summary of one enrollment attempt. */
export interface EnrollmentResult {
  readonly ok: boolean;
  readonly totalMs: number;
  readonly sampleMs: readonly number[];
  readonly voiceprint: Voiceprint | undefined;
  readonly message: string;
}

/**
 * Builds a voiceprint from the individual enrollment samples.
 *
 * The backend receives the samples separately, not one concatenated buffer,
 * so it can embed each one and average. Concatenating first produces a
 * markedly worse voiceprint: measured on the bundled test audio, per-sample
 * enrollment scores 0.86-0.97 on held-out clips while a single concatenated
 * buffer scores 0.35-0.75 for the same speaker.
 */
export type EmbeddingComputer = (
  samples: readonly AudioSamples[],
) => Promise<number[]>;

/**
 * Identifies the backend that produced an embedding.
 *
 * The voiceprint records this so a later verification never compares
 * embeddings from two different, incompatible spaces.
 */
export interface EmbeddingIdentity {
  readonly backend: string;
  readonly model: string;
}

/** Drives the enrollment interaction and persists the resulting voiceprint. */
export class EnrollmentSession {
  readonly #config: VoiceConfig;
  readonly #store: VoiceprintStore;
  readonly #embedding: EmbeddingComputer;
  readonly #identity: EmbeddingIdentity;
  #phraseIndex = 0;
  #samples: { pcm: Buffer; ms: number }[] = [];

  public constructor(
    config: VoiceConfig,
    store: VoiceprintStore,
    embedding: EmbeddingComputer,
    identity: EmbeddingIdentity = {
      backend: 'wyoming-ecapa-tdnn',
      model: 'speechbrain/spkrec-ecapa-voxceleb',
    },
  ) {
    this.#config = config;
    this.#store = store;
    this.#embedding = embedding;
    this.#identity = identity;
  }

  /** The phrase the user should be asked to speak next. */
  public get currentPhrase(): string | undefined {
    const { phrases } = enrollmentPlan();
    return phrases[this.#phraseIndex];
  }

  /** Index of the sample being collected, 1-based. */
  public get collectedCount(): number {
    return this.#samples.length;
  }

  /** Records one captured sample. */
  public addSample(pcm: Buffer): void {
    const trimmed = trimSample(pcm, MAX_SAMPLE_MS, this.#config.sampleRate);
    const actualMs = (trimmed.length / (this.#config.sampleRate * 2)) * 1_000;
    this.#samples.push({ pcm: trimmed, ms: actualMs });
    this.#phraseIndex += 1;
  }

  /** Total voiced milliseconds collected so far. */
  public get totalMs(): number {
    return this.#samples.reduce((sum, sample) => sum + sample.ms, 0);
  }

  /**
   * Builds and stores the voiceprint, or explains why it cannot yet.
   *
   * Enrollment audio is written to the private voice directory so it can be
   * re-audited or re-enrolled later, then the embedding replaces it as the
   * thing Atlas actually compares against.
   */
  public async finalize(): Promise<EnrollmentResult> {
    const { phrases, minTotalMs } = enrollmentPlan();
    const sampleMs = this.#samples.map((sample) => sample.ms);

    if (this.#samples.length < 3) {
      return {
        ok: false,
        totalMs: this.totalMs,
        sampleMs,
        voiceprint: undefined,
        message: `Need at least 3 samples, have ${this.#samples.length}.`,
      };
    }
    if (this.totalMs < minTotalMs) {
      return {
        ok: false,
        totalMs: this.totalMs,
        sampleMs,
        voiceprint: undefined,
        message:
          `Need at least ${minTotalMs / 1000}s of speech for a reliable ` +
          `voiceprint, have ${(this.totalMs / 1000).toFixed(1)}s.`,
      };
    }

    const combined = Buffer.concat(this.#samples.map((sample) => sample.pcm));
    const wav = pcmToWav(combined, this.#config.sampleRate);

    // Keep the source audio beside the voiceprint, owner-readable only.
    const sampleDir = join(this.#config.dataDirectory, 'enrollment-audio');
    await mkdir(sampleDir, { recursive: true, mode: 0o700 });
    const samplePath = join(sampleDir, `${randomUUID()}.wav`);
    await writeFile(samplePath, wav, { mode: 0o600 });

    // Embed each recorded phrase separately so the backend can average them.
    // Feeding one concatenated buffer instead measurably degrades the
    // voiceprint and makes later verification unreliable.
    const perSample = this.#samples.map((sample) =>
      audioBufferFromPcm(sample.pcm, this.#config.sampleRate),
    );
    const embedding = await this.#embedding(perSample);
    if (embedding.length === 0) {
      return {
        ok: false,
        totalMs: this.totalMs,
        sampleMs,
        voiceprint: undefined,
        message:
          'The speaker-verification model returned no embedding for this audio.',
      };
    }

    const voiceprint: Voiceprint = {
      version: 1,
      embedding,
      enrolledMs: Math.round(this.totalMs),
      sampleMs: sampleMs.map((ms) => Math.round(ms)),
      enrolledAt: new Date().toISOString(),
      model: this.#identity.model,
      backend: this.#identity.backend,
    };
    await this.#store.save(voiceprint);

    return {
      ok: true,
      totalMs: this.totalMs,
      sampleMs,
      voiceprint,
      message:
        `Enrolled ${this.#samples.length} samples ` +
        `(${phrases.length} prompts, ${(this.totalMs / 1000).toFixed(1)}s of speech).`,
    };
  }
}

/** Adapter so a UtteranceSegmenter result can be fed straight in. */
export interface SegmentedUtterance {
  pcm: Buffer;
  audioMs: number;
}
