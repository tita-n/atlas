/**
 * Ambient declarations for `sherpa-onnx-node`.
 *
 * The package ships no `.d.ts` and no `types` field, so Atlas declares only
 * the surface it actually uses. Everything here mirrors the documented
 * JavaScript API of sherpa-onnx 1.13.x; unlisted exports are intentionally
 * absent so an unsupported call is a compile error rather than a runtime
 * surprise.
 *
 * Verified against the published package: KeywordSpotter (custom keywords via
 * a keywords file), SpeakerEmbeddingExtractor + SpeakerEmbeddingManager.verify
 * (1:1 enrolment comparison), and OfflineRecognizer (Whisper and others).
 */
declare module 'sherpa-onnx-node' {
  /** The package is CommonJS, so ESM consumers use the default export. */
  const sherpa: {
    KeywordSpotter: typeof KeywordSpotter;
    OfflineRecognizer: typeof OfflineRecognizer;
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
    SpeakerEmbeddingManager: typeof SpeakerEmbeddingManager;
    LinearResampler: typeof LinearResampler;
    version: string;
    gitSha1: string;
    gitDate: string;
    onnxruntimeVersion: string;
  };
  export default sherpa;

  /** Feature extraction settings shared by the keyword spotter. */
  export interface FeatureConfig {
    readonly sampleRate?: number;
    readonly featureDim?: number;
    readonly numThreads?: number;
    readonly provider?: string;
    readonly debug?: boolean | number;
    readonly [key: string]: unknown;
  }

  /** Files backing an offline model. */
  export interface OfflineModelConfig {
    readonly model?: string;
    readonly tokens?: string;
    readonly [key: string]: unknown;
  }

  /**
   * Transducer (zipformer) model paths.
   *
   * Verified against the shipped KWS release: encoder, decoder and joiner are
   * three separate files under `modelConfig.transducer`, not a joined string.
   */
  export interface TransducerModelConfig {
    readonly encoder?: string;
    readonly decoder?: string;
    readonly joiner?: string;
  }

  /** Configuration for keyword spotting. */
  export interface KeywordSpotterConfig {
    readonly featConfig?: FeatureConfig;
    readonly modelConfig?: OfflineModelConfig & {
      readonly transducer?: TransducerModelConfig;
    };
    readonly maxActivePaths?: number;
    readonly numTrailingBlanks?: number;
    readonly keywordsScore?: number;
    readonly keywordsThreshold?: number;
    /**
     * Path to a newline-delimited keyword list, using `@` to mark the
     * keyword and its boosted tokens. This is how a custom phrase such as
     * "Hey Atlas" is supplied with a generic pretrained model.
     */
    readonly keywordsFile?: string;
  }

  /** One detection reported by the keyword spotter. */
  export interface KeywordResult {
    readonly keyword: string;
    readonly tokens: readonly string[];
    readonly start: number;
    readonly end?: number;
  }

  /** Streaming audio input. */
  export interface OnlineStream {
    acceptWaveform(input: {
      readonly sampleRate: number;
      readonly samples: Float32Array;
    }): void;
    inputFinished(): void;
    free?(): void;
  }

  /** Keyword spotting over a stream of audio. */
  export class KeywordSpotter {
    constructor(config: KeywordSpotterConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): KeywordResult;
  }

  /** Configuration for extracting speaker embeddings. */
  export interface SpeakerEmbeddingExtractorConfig {
    readonly model?: string;
    readonly numThreads?: number;
    readonly debug?: boolean | number;
    readonly provider?: string;
    readonly [key: string]: unknown;
  }

  /** A named speaker embedding held by the manager. */
  export interface SpeakerEmbeddingEntry {
    readonly name: string;
    readonly v: Float32Array;
  }

  /** Verification request: compare one sample against one enrolled speaker. */
  export interface SpeakerEmbeddingManagerVerifyObj {
    readonly name: string;
    readonly v: Float32Array;
    readonly threshold: number;
  }

  /** A transcribed utterance. */
  export interface OfflineRecognizerResult {
    readonly text: string;
    readonly lang?: string;
    readonly emotion?: string;
    readonly tokens?: readonly string[];
    readonly timestamps?: readonly number[];
    readonly durations?: readonly number[];
    readonly lang?: string;
  }

  /**
   * Whisper model paths.
   *
   * Verified against the shipped release: encoder and decoder are separate
   * files, not a joined `model` string.
   */
  export interface WhisperModelConfig {
    readonly encoder?: string;
    readonly decoder?: string;
    /** 'transcribe' or 'translate'. */
    readonly task?: string;
    readonly language?: string;
    readonly tailPaddings?: number;
    readonly enableTokenTimestamps?: boolean;
    readonly enableSegmentTimestamps?: boolean;
  }

  /** Configuration for the offline recognizer. */
  export interface OfflineRecognizerConfig {
    readonly featConfig?: FeatureConfig;
    readonly modelConfig?: {
      readonly whisper?: WhisperModelConfig;
      readonly tokens?: string;
      readonly numThreads?: number;
      readonly provider?: string;
      readonly debug?: boolean | number;
      readonly [key: string]: unknown;
    };
    readonly numThreads?: number;
    readonly debug?: boolean | number;
    readonly [key: string]: unknown;
  }

  /** Offline speech recognition over a complete utterance. */
  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    createStream(): OfflineStream;
    /** Decodes a whole utterance and returns its result. */
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
    free?(): void;
  }

  /** A single offline utterance. */
  export interface OfflineStream {
    acceptWaveform(input: {
      readonly sampleRate: number;
      readonly samples: Float32Array;
    }): void;
    setOption(key: string, value: string): void;
    free?(): void;
  }

  /** Extracts fixed-size speaker embeddings from audio. */
  export class SpeakerEmbeddingExtractor {
    constructor(config: SpeakerEmbeddingExtractorConfig);
    readonly dim: number;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
    free?(): void;
  }

  /** Stores enrolled speakers and matches samples against them. */
  export class SpeakerEmbeddingManager {
    constructor(dim: number);
    readonly dim: number;
    add(entry: SpeakerEmbeddingEntry): boolean;
    addMulti(entry: {
      readonly name: string;
      readonly v: readonly Float32Array[];
    }): boolean;
    remove(name: string): boolean;
    search(obj: {
      readonly name: string;
      readonly v: Float32Array;
      readonly threshold: number;
    }): string;
    verify(obj: SpeakerEmbeddingManagerVerifyObj): boolean;
    contains(name: string): boolean;
    getNumSpeakers(): number;
    /** Present in some builds; call defensively. */
    free?(): void;
  }

  /** Resamples audio to a different rate. */
  export class LinearResampler {
    constructor(
      inputSampleRate: number,
      outputSampleRate: number,
      numThreads?: number,
    );
    acceptWaveform(input: {
      readonly sampleRate: number;
      readonly samples: Float32Array;
    }): Float32Array;
    inputFinished(): Float32Array;
    reset(): void;
    free(): void;
  }

  /** Library and runtime versions, useful in diagnostics. */
  export const version: string;
  export const gitSha1: string;
  export const gitDate: string;
  export const onnxruntimeVersion: string;
}
