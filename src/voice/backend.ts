/**
 * Voice backend abstraction.
 *
 * This mirrors the `LLMProvider` seam from Phase 0: the activation pipeline,
 * audio capture, and the conversation hand-off depend only on these three
 * interfaces, so a backend can be swapped without touching the harness.
 *
 * Two implementations exist:
 *   - `sherpa-onnx` (default): native ONNX Runtime, no Python, no PyTorch.
 *   - `wyoming`: external services, SpeechBrain/PyTorch for verification.
 */

/** 16-bit signed little-endian PCM at a given rate. */
export interface AudioSamples {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** Builds an AudioSamples from raw PCM bytes. */
export function audioBufferFromPcm(
  pcm: Buffer,
  sampleRate: number,
): AudioSamples {
  const count = Math.floor(pcm.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 32_768;
  }
  return { samples, sampleRate };
}

/** Serializes an AudioSamples back to 16-bit PCM. */
export function pcmFromAudioBuffer(audio: AudioSamples): Buffer {
  const pcm = Buffer.alloc(audio.samples.length * 2);
  for (let index = 0; index < audio.samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, audio.samples[index] ?? 0));
    pcm.writeInt16LE(Math.round(value * 32_767), index * 2);
  }
  return pcm;
}

/** A wake phrase was detected. */
export interface WakeDetectionEvent {
  /** Which keyword fired. */
  readonly keyword: string;
  /** Detection score, when the backend reports one. */
  readonly score: number | undefined;
  /** Audio captured around the detection, for speaker verification. */
  readonly audio: AudioSamples;
}

/** Result of comparing a sample against an enrolled voiceprint. */
export interface VerificationResult {
  readonly accepted: boolean;
  /** Similarity in [-1, 1]. */
  readonly score: number;
  readonly threshold: number;
  readonly audioMs: number;
  readonly reason?: string;
}

/** A recognized utterance. */
export interface TranscriptionResult {
  readonly text: string;
  readonly language: string | undefined;
}

/** Enrolled voiceprint, backend-neutral. */
export interface Voiceprint {
  /** Backend that produced it; a voiceprint is only valid for its own backend. */
  readonly backend: string;
  /** Model identifier used, so a model change invalidates enrollment. */
  readonly model: string;
  readonly embedding: readonly number[];
  readonly enrolledMs: number;
  readonly sampleMs: readonly number[];
  readonly enrolledAt: string;
}

/** Detects the wake phrase. */
export interface WakeWordDetector {
  readonly name: string;
  /** Human-readable description of the live detector, for diagnostics. */
  readonly info: string;
  /** Verifies models/services are usable, before listening. */
  preflight(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pushes a chunk; detections arrive through the registered callback. */
  push(pcm: Buffer): void;
  /**
   * Returns a detection produced by the most recent push, if any.
   *
   * Implementations that resolve a detection asynchronously (the Wyoming
   * client round-trips over a socket) must latch it here so the pipeline can
   * read it on the following chunk rather than losing it.
   */
  takePendingDetection(): WakeDetectionEvent | undefined;
  onDetection(callback: (event: WakeDetectionEvent) => void): void;
  /** Releases native resources. */
  dispose(): void;
}

/** Identifies the enrolled owner. */
export interface SpeakerVerifier {
  readonly name: string;
  preflight(): Promise<void>;
  enroll(audioSamples: readonly AudioSamples[]): Promise<Voiceprint>;
  /**
   * Verifies a sample.
   *
   * `voiceprint` is optional because an adapter may close over the enrolled
   * voiceprint itself; when supplied, the implementation must use it.
   */
  verify(
    audio: AudioSamples,
    voiceprint?: Voiceprint,
  ): Promise<VerificationResult>;
  dispose(): void;
}

/** Transcribes a command. */
export interface SpeechToText {
  readonly name: string;
  preflight(): Promise<void>;
  transcribe(audio: AudioSamples): Promise<TranscriptionResult>;
  dispose(): void;
}

/** The three components a backend provides. */
export interface VoiceBackend {
  readonly name: 'sherpa-onnx' | 'wyoming';
  readonly wakeWord: WakeWordDetector;
  readonly speakerVerification: SpeakerVerifier;
  readonly speechToText: SpeechToText;
}
