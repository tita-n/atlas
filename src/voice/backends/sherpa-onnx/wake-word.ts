/**
 * sherpa-onnx keyword spotting for the "Hey Atlas" wake phrase.
 *
 * sherpa-onnx's keyword spotter takes a generic pretrained model plus a
 * keyword list, so no custom training run is required: Atlas writes
 * `keywords.txt` marking the phrase and its boosted tokens, and passes it as
 * `keywordsFile`. (An openWakeWord custom model is still used by the Wyoming
 * backend, where training is unavoidable.)
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sherpa from 'sherpa-onnx-node';
import type { OnlineStream } from 'sherpa-onnx-node';

import { VoiceModelError } from '../../../errors.js';
import {
  audioBufferFromPcm,
  type WakeDetectionEvent,
  type WakeWordDetector,
} from '../../backend.js';
import type { ModelManager } from '../../model-manager.js';
import { toFloat32 } from './audio.js';
import {
  DEFAULT_KEYWORD_BOOST,
  DEFAULT_KEYWORD_THRESHOLD,
  candidateKeywordLines,
} from '../../wake-keyword.js';

/** The wake phrase Atlas listens for. */
export const KEYWORD = 'hey atlas';

const DEFAULT_SCORE = 1.5;
const DEFAULT_THRESHOLD = 0.25;
/** Wake audio retained for speaker verification, in ms. */
const TAIL_MS = 2_000;

/**
 * Picks the checkpoint variant present in a KWS model directory.
 *
 * Integer checkpoints are ignored in favour of int8 (the smaller option used
 * by `ATLAS_VOICE_MODELS=minimal`); full precision is the fallback.
 */
export async function findModelVariant(directory: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(directory);

  // A variant is only usable when encoder, decoder AND joiner all exist for
  // it. Some releases ship a quantised encoder without the matching decoder
  // and joiner, which fails at load time with a bare "check your config".
  const usable = files
    .map((file) => /^encoder-(.+)\.onnx$/.exec(file)?.[1])
    .filter(
      (variant): variant is string =>
        variant !== undefined &&
        files.includes(`decoder-${variant}.onnx`) &&
        files.includes(`joiner-${variant}.onnx`),
    );

  if (usable.length === 0) {
    throw new VoiceModelError(
      `No complete sherpa-onnx keyword model was found in ${directory}. ` +
        'Re-run "atlas voice setup-models" to download it.',
    );
  }
  // Prefer the int8 set when it is complete, since that is the small option.
  const int8 = usable.find((variant) => variant.endsWith('.int8'));
  const chosen = int8 ?? usable[0];
  if (chosen === undefined) {
    throw new VoiceModelError(
      `No usable sherpa-onnx keyword model was found in ${directory}.`,
    );
  }
  return chosen;
}

export interface SherpaWakeOptions {
  readonly models: ModelManager;
  readonly sampleRate?: number;
  readonly score?: number;
  readonly threshold?: number;
  /** The wake phrase; defaults to the built-in one. */
  readonly phrase?: string;
  /**
   * Exact keyword lines to use instead of generating them.
   *
   * Used to point the detector at the model's shipped `keywords.txt` for a
   * diagnostic run. The persistent keyword file is never overwritten in that
   * case: the lines are written to a temporary file instead.
   */
  readonly keywordLines?: readonly string[] | undefined;
}

/** Keyword spotting backed by sherpa-onnx keyword spotting. */
export class SherpaWakeWord implements WakeWordDetector {
  public readonly name = 'sherpa-onnx-keyword-spotter';
  /** The generated keyword line, for diagnostics. */
  public get keywordLine(): string | undefined {
    return this.#keywordLine;
  }

  public get info(): string {
    return this.name;
  }
  readonly #options: SherpaWakeOptions;
  readonly #sampleRate: number;
  #spotter: InstanceType<(typeof sherpa)['KeywordSpotter']> | undefined;
  #stream: OnlineStream | undefined;
  readonly #callbacks = new Set<(event: WakeDetectionEvent) => void>();
  #tail: Buffer = Buffer.alloc(0);
  #keywordLine: string | undefined;
  #probePath: string | undefined;

  public constructor(options: SherpaWakeOptions) {
    this.#options = options;
    this.#sampleRate = options.sampleRate ?? 16_000;
  }

  public preflight(): Promise<void> {
    return this.#options.models.ensure('wake').then(() => undefined);
  }

  public async start(): Promise<void> {
    const directory = await this.#options.models.ensure('wake');
    const keywords = join(directory, 'atlas-keywords.txt');

    // Verified against the shipped release: the KWS model is a three-file
    // transducer (encoder, decoder, joiner) plus a tokens file, all under
    // modelConfig.
    const variant = await findModelVariant(directory);
    const tokensPath = join(directory, 'tokens.txt');

    // The keyword line is generated from the model's own vocabulary and
    // carries a per-line boost and threshold. The token sequence is a hard
    // constraint in the decoder, and a keyword with no boost frequently never
    // scores high enough to fire (sherpa-onnx issue #2678).
    //
    // Some words admit more than one valid segmentation, and only the one the
    // model was trained with actually matches, so every candidate is kept and
    // tried in turn rather than guessing.
    const candidates =
      this.#options.keywordLines ??
      (
        await candidateKeywordLines(this.#options.phrase ?? KEYWORD, tokensPath)
      ).map(
        (tokens) =>
          `${tokens.join(' ')} :${DEFAULT_KEYWORD_BOOST} #${DEFAULT_KEYWORD_THRESHOLD}`,
      );
    if (candidates.length === 0) {
      throw new VoiceModelError(
        `The wake phrase "${this.#options.phrase ?? KEYWORD}" cannot be expressed ` +
          "with this model's vocabulary.",
      );
    }
    this.#keywordLine = candidates[0];
    // Explicit lines are a one-off diagnostic: keep them out of the
    // persistent keyword file so a test run cannot change normal operation.
    const keywordsPath =
      this.#options.keywordLines === undefined
        ? keywords
        : join(directory, `atlas-keywords-probe-${process.pid}.txt`);
    if (this.#options.keywordLines !== undefined) {
      this.#probePath = keywordsPath;
    }
    await writeFile(keywordsPath, `${candidates.join('\n')}\n`, 'utf8');

    const modelConfig = {
      transducer: {
        encoder: join(directory, `encoder-${variant}.onnx`),
        decoder: join(directory, `decoder-${variant}.onnx`),
        joiner: join(directory, `joiner-${variant}.onnx`),
      },
      tokens: tokensPath,
    };
    try {
      this.#spotter = new sherpa.KeywordSpotter({
        featConfig: {
          sampleRate: this.#sampleRate,
          featureDim: 80,
          numThreads: 1,
        },
        modelConfig,
        keywordsFile: keywordsPath,
        keywordsScore: this.#options.score ?? DEFAULT_SCORE,
        keywordsThreshold: this.#options.threshold ?? DEFAULT_THRESHOLD,
        maxActivePaths: 4,
        numTrailingBlanks: 1,
      });
      this.#stream = this.#spotter.createStream();
    } catch (cause) {
      throw new VoiceModelError(
        'Could not load the sherpa-onnx keyword model. Re-run "atlas voice setup-models" to refetch it.',
        { cause },
      );
    }
  }

  public takePendingDetection(): WakeDetectionEvent | undefined {
    return undefined;
  }

  public onDetection(callback: (event: WakeDetectionEvent) => void): void {
    // Multiple listeners: the pipeline and the CLI both subscribe, and a
    // single-slot callback meant the pipeline silently unregistered the CLI.
    this.#callbacks.add(callback);
  }

  #emit(event: WakeDetectionEvent): void {
    for (const callback of this.#callbacks) callback(event);
  }

  public push(pcm: Buffer): void {
    if (this.#spotter === undefined || this.#stream === undefined) return;

    const keep = Math.round((TAIL_MS / 1000) * this.#sampleRate * 2);
    this.#tail = Buffer.concat([this.#tail, pcm]);
    if (this.#tail.length > keep) {
      this.#tail = this.#tail.subarray(this.#tail.length - keep);
    }

    this.#stream.acceptWaveform({
      sampleRate: this.#sampleRate,
      samples: toFloat32(pcm),
    });

    while (this.#spotter.isReady(this.#stream)) {
      this.#spotter.decode(this.#stream);
      // getResult reflects the latest decode and reports an empty keyword
      // between decodes, so only a non-empty keyword is a real detection.
      const result = this.#spotter.getResult(this.#stream);
      if (result?.keyword === undefined || result.keyword === '') {
        continue;
      }
      this.#emit({
        keyword: result.keyword,
        score: undefined,
        audio: audioBufferFromPcm(this.#tail, this.#sampleRate),
      });
      // Reset after firing so the decoder does not stay latched on the keyword
      // it just emitted.
      this.#spotter.reset(this.#stream);
    }
  }

  public async stop(): Promise<void> {
    this.#stream?.free?.();
    this.#stream = undefined;
    this.#spotter = undefined;
    // Remove the temporary probe keyword file. This is awaited because the
    // process exits immediately after teardown, so a detached promise would
    // never complete.
    if (this.#probePath !== undefined) {
      const { rm } = await import('node:fs/promises');
      await rm(this.#probePath, { force: true }).catch(() => undefined);
      this.#probePath = undefined;
    }
  }

  public dispose(): void {
    void this.stop();
  }
}
