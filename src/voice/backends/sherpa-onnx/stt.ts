/**
 * sherpa-onnx speech-to-text.
 *
 * Uses the same Whisper family as the Wyoming backend, so the size trade-off
 * reasoning carries over: `tiny.en` is the smallest viable option for short
 * commands, `base.en` is the default balance. sherpa-onnx ships
 * `base.en-encoder-merged.onnx`, which is why the encoder/decoder pair is a
 * single file here.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import sherpa from 'sherpa-onnx-node';
import type { OfflineStream } from 'sherpa-onnx-node';

import { VoiceModelError } from '../../../errors.js';
import type {
  AudioSamples,
  SpeechToText,
  TranscriptionResult,
} from '../../backend.js';
import type { ModelManager } from '../../model-manager.js';

export interface SherpaSttOptions {
  readonly models: ModelManager;
  /** 'base.en' or 'tiny.en'; must match the downloaded model. */
  readonly modelName?: string;
  /** Whisper language code, e.g. 'en'. Omit to let the model decide. */
  readonly language?: string;
  readonly numThreads?: number;
}

/** Offline speech recognition backed by sherpa-onnx. */
export class SherpaSpeechToText implements SpeechToText {
  public readonly name = 'sherpa-onnx-whisper';
  public get info(): string {
    return this.name;
  }
  readonly #options: SherpaSttOptions;
  #recognizer: InstanceType<(typeof sherpa)['OfflineRecognizer']> | undefined;
  #encoder: string | undefined;
  #tokens: string | undefined;

  public constructor(options: SherpaSttOptions) {
    this.#options = options;
  }

  async #ensureRecognizer(): Promise<
    InstanceType<(typeof sherpa)['OfflineRecognizer']>
  > {
    if (this.#recognizer !== undefined) return this.#recognizer;
    const directory = await this.#options.models.ensure('speech');
    const prefix = this.#options.modelName ?? 'base.en';
    const encoder = join(directory, `${prefix}-encoder.onnx`);
    const decoder = join(directory, `${prefix}-decoder.onnx`);
    const tokens = join(directory, `${prefix}-tokens.txt`);

    const files = await readdir(directory);
    if (!files.includes(`${prefix}-encoder.onnx`)) {
      throw new VoiceModelError(
        `The sherpa-onnx speech model for "${prefix}" is not present in ${directory}. ` +
          'Set ATLAS_VOICE_STT_MODEL to the profile you downloaded, or run ' +
          '"atlas voice setup-models".',
      );
    }

    try {
      // Verified against the shipped release: Whisper takes separate encoder
      // and decoder paths under `modelConfig.whisper`, not a joined `model`.
      this.#recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          whisper: {
            encoder,
            decoder,
            task: 'transcribe',
            ...(this.#options.language === undefined
              ? {}
              : { language: this.#options.language }),
          },
          tokens,
          numThreads: this.#options.numThreads ?? 1,
        },
      });
    } catch (cause) {
      throw new VoiceModelError(
        'Could not load the sherpa-onnx speech model. Re-run "atlas voice setup-models" to refetch it.',
        { cause },
      );
    }
    this.#encoder = encoder;
    this.#tokens = tokens;
    return this.#recognizer;
  }

  public preflight(): Promise<void> {
    return this.#options.models
      .ensure('speech')
      .then(() => this.#ensureRecognizer())
      .then(() => undefined);
  }

  public async transcribe(audio: AudioSamples): Promise<TranscriptionResult> {
    if (audio.samples.length === 0) return { text: '', language: undefined };
    const recognizer = await this.#ensureRecognizer();
    const stream: OfflineStream = recognizer.createStream();
    try {
      stream.acceptWaveform({
        sampleRate: audio.sampleRate,
        samples: audio.samples,
      });
      // decodeAsync runs the whole utterance and returns the parsed result.
      const result = await recognizer.decodeAsync(stream);
      return {
        text: (result.text ?? '').trim(),
        language: result.lang,
      };
    } finally {
      stream.free?.();
    }
  }

  public dispose(): void {
    this.#recognizer?.free?.();
    this.#recognizer = undefined;
    this.#encoder = undefined;
    this.#tokens = undefined;
  }

  /** Paths of the loaded model, for diagnostics and for tests. */
  public get modelFiles(): { encoder: string; tokens: string } | undefined {
    if (this.#encoder === undefined || this.#tokens === undefined) {
      return undefined;
    }
    return { encoder: this.#encoder, tokens: this.#tokens };
  }
}
