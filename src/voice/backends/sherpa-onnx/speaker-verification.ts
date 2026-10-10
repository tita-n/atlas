/**
 * sherpa-onnx speaker verification.
 *
 * Uses `SpeakerEmbeddingExtractor` for embeddings and
 * `SpeakerEmbeddingManager.verify()` for a 1:1 comparison against the
 * enrolled owner. Nothing leaves the process: the enrolled embedding is held
 * by Atlas and passed back in, so the native manager only ever sees one
 * enrolled speaker at a time.
 */
import { basename } from 'node:path';

import sherpa from 'sherpa-onnx-node';
import type { OnlineStream } from 'sherpa-onnx-node';

import { VoiceModelError } from '../../../errors.js';
import type {
  AudioSamples,
  SpeakerVerifier,
  VerificationResult,
  Voiceprint,
} from '../../backend.js';
import type { ModelManager } from '../../model-manager.js';

export interface SherpaSpeakerOptions {
  readonly models: ModelManager;
  /** Cosine threshold above which a sample is accepted. */
  readonly threshold?: number;
  /** Samples shorter than this cannot be identified reliably. */
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly sampleRate?: number;
}

const DEFAULT_THRESHOLD = 0.55;
const DEFAULT_MIN_MS = 2_000;

/** Speaker model used when the profile has not been resolved yet. */
const DEFAULT_SPEAKER_MODEL_FILE =
  '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx';

/** Speaker verification backed by sherpa-onnx. */
export class SherpaSpeakerVerification implements SpeakerVerifier {
  public readonly name = 'sherpa-onnx-speaker-verification';
  public get info(): string {
    return this.name;
  }
  readonly #options: SherpaSpeakerOptions;
  #extractor:
    InstanceType<(typeof sherpa)['SpeakerEmbeddingExtractor']> | undefined;
  /**
   * Filename of the active speaker model.
   *
   * Embedded in the voiceprint so an enrollment made with one model is
   * rejected after switching profiles, instead of being compared in an
   * unrelated embedding space.
   */
  #modelId: string = DEFAULT_SPEAKER_MODEL_FILE;

  public constructor(options: SherpaSpeakerOptions) {
    this.#options = options;
  }

  async #ensureExtractor(): Promise<
    InstanceType<(typeof sherpa)['SpeakerEmbeddingExtractor']>
  > {
    if (this.#extractor !== undefined) return this.#extractor;
    await this.#options.models.ensure('speaker');
    // Read the filename from the active profile: the minimal profile ships a
    // different model, and hardcoding one made it fail with "model missing".
    const model = this.#options.models.modelFile('speaker');
    this.#modelId = basename(model);
    try {
      this.#extractor = new sherpa.SpeakerEmbeddingExtractor({
        model,
        numThreads: 1,
      });
    } catch (cause) {
      throw new VoiceModelError(
        'Could not load the sherpa-onnx speaker model. Re-run "atlas voice setup-models" to refetch it.',
        { cause },
      );
    }
    return this.#extractor;
  }

  async #embed(audio: AudioSamples): Promise<Float32Array | undefined> {
    const extractor = await this.#ensureExtractor();
    const stream: OnlineStream = extractor.createStream();
    try {
      stream.acceptWaveform({
        sampleRate: audio.sampleRate,
        samples: audio.samples,
      });
      stream.inputFinished();
      if (!extractor.isReady(stream)) return undefined;
      const embedding = extractor.compute(stream);
      return embedding.length > 0 ? embedding : undefined;
    } finally {
      stream.free?.();
    }
  }

  public preflight(): Promise<void> {
    return this.#options.models.ensure('speaker').then(() => undefined);
  }

  /**
   * The model identity written into a voiceprint.
   *
   * Enrollment must resolve the model so the stored value matches what
   * {@link verify} compares against; otherwise every fresh enrollment is
   * rejected as belonging to a different model.
   */
  public get modelId(): string {
    return this.#modelId;
  }

  public async enroll(
    audioSamples: readonly AudioSamples[],
  ): Promise<Voiceprint> {
    const embeddings: Float32Array[] = [];
    const sampleMs: number[] = [];
    let totalMs = 0;
    for (const sample of audioSamples) {
      const embedding = await this.#embed(sample);
      if (embedding === undefined) continue;
      embeddings.push(embedding);
      const ms = (sample.samples.length / sample.sampleRate) * 1_000;
      sampleMs.push(ms);
      totalMs += ms;
    }
    if (embeddings.length === 0) {
      throw new VoiceModelError(
        'The speaker model produced no embeddings from the recorded audio. Try enrolling in a quieter room.',
      );
    }

    // Average the enrollment embeddings so one noisy clip cannot skew the
    // voiceprint; the native manager is seeded with that centroid.
    const dim = embeddings[0]?.length ?? 0;
    const centroid = new Float32Array(dim);
    for (const embedding of embeddings) {
      for (let index = 0; index < dim; index += 1) {
        centroid[index] = (centroid[index] ?? 0) + (embedding[index] ?? 0);
      }
    }
    for (let index = 0; index < dim; index += 1) {
      centroid[index] = (centroid[index] ?? 0) / embeddings.length;
    }

    return {
      backend: this.name,
      model: this.#modelId,
      embedding: Array.from(centroid, (value) => Number(value.toFixed(6))),
      enrolledMs: Math.round(totalMs),
      sampleMs: sampleMs.map((ms) => Math.round(ms)),
      enrolledAt: new Date().toISOString(),
    };
  }

  public async verify(
    audio: AudioSamples,
    voiceprint?: Voiceprint,
  ): Promise<VerificationResult> {
    const threshold = this.#options.threshold ?? DEFAULT_THRESHOLD;
    if (voiceprint === undefined) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs: (audio.samples.length / audio.sampleRate) * 1_000,
        reason: 'No voiceprint is enrolled, so the speaker cannot be verified.',
      };
    }
    if (voiceprint.embedding.length === 0) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs: (audio.samples.length / audio.sampleRate) * 1_000,
        reason:
          'The enrolled voiceprint is empty. Re-run "atlas voice enroll --redo".',
      };
    }
    const minMs = this.#options.minMs ?? DEFAULT_MIN_MS;
    const audioMs = (audio.samples.length / audio.sampleRate) * 1_000;

    // A voiceprint from another backend cannot be compared: the embedding
    // spaces are unrelated. Refuse rather than produce a meaningless score.
    // A different model means a different embedding space, even inside the
    // same backend. Comparing across them yields a meaningless score, so the
    // default/minimal switch must invalidate the enrollment.
    if (voiceprint.model !== undefined && voiceprint.model !== this.#modelId) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs,
        reason:
          `This voiceprint was created with "${voiceprint.model}" but the ` +
          `active model is "${this.#modelId}". Re-run "atlas voice enroll --redo".`,
      };
    }

    if (voiceprint.backend !== this.name) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs,
        reason:
          `This voiceprint was created by "${voiceprint.backend}" and cannot be ` +
          `compared with the "${this.name}" backend. Re-run "atlas voice enroll --redo".`,
      };
    }

    if (audioMs < minMs) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs,
        reason: `Sample too short to verify (${Math.round(audioMs)}ms, need ${minMs}ms).`,
      };
    }

    const embedding = await this.#embed(audio);
    if (embedding === undefined) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs,
        reason: 'The speaker model returned no embedding for this audio.',
      };
    }

    const manager = new sherpa.SpeakerEmbeddingManager(embedding.length);
    try {
      manager.add({
        name: 'owner',
        v: Float32Array.from(voiceprint.embedding),
      });
      const accepted = manager.verify({
        name: 'owner',
        v: embedding,
        threshold,
      });
      const score = cosineSimilarity(
        embedding,
        Float32Array.from(voiceprint.embedding),
      );
      return {
        accepted,
        score,
        threshold,
        audioMs,
        ...(accepted
          ? {}
          : { reason: 'Speaker does not match the enrolled owner.' }),
      };
    } finally {
      manager.free?.();
    }
  }

  public dispose(): void {
    this.#extractor?.free?.();
    this.#extractor = undefined;
  }
}

/** Cosine similarity, used to report a score alongside the boolean verdict. */
function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
