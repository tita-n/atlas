/**
 * The Wyoming backend: existing Phase 3 services adapted to the backend
 * interfaces.
 *
 * External processes, SpeechBrain/PyTorch for speaker verification. This is
 * the heavier, higher-fidelity option; the default is sherpa-onnx. No
 * external behavior changed in the move to these interfaces.
 */
import { readFile } from 'node:fs/promises';

import {
  audioBufferFromPcm,
  pcmFromAudioBuffer,
  type AudioSamples,
  type SpeechToText,
  type SpeakerVerifier,
  type TranscriptionResult,
  type VerificationResult,
  type VoiceBackend,
  type Voiceprint,
  type WakeDetectionEvent,
  type WakeWordDetector,
} from '../../backend.js';
import {
  DEFAULT_PORTS,
  type VoiceConfig,
} from '../../../config/voice-config.js';
import { OpenWakeWordService } from '../../wake-word-service.js';
import {
  EcapaSpeakerVerifier,
  UnenrolledSpeakerVerifier,
} from '../../speaker-verification.js';
import { WhisperCppService } from '../../stt-service.js';
import {
  cosineSimilarity,
  type Voiceprint as StoredVoiceprint,
  parseVoiceprint,
  VoiceprintError,
} from '../../voiceprint-store.js';

export interface WyomingBackendOptions {
  readonly wakeModelPath: string;
  readonly wakeVerifierPath?: string;
  readonly ports: {
    readonly wakeWord: number;
    readonly speakerVerification: number;
    readonly speechToText: number;
  };
  readonly sampleRate?: number;
  readonly speakerThreshold?: number;
  readonly speakerCheck?: VoiceConfig['speakerCheck'];
  readonly wakeThreshold?: number;
  readonly wakePhrase?: string;
  readonly sttModel?: string;
  /** Pre-computed voiceprint, so enrollment can reuse the stored file. */
  readonly voiceprint?: StoredVoiceprint;
}

/** Wake detection over Wyoming, adapting the push/pull service. */
class WyomingWakeWord implements WakeWordDetector {
  public readonly name = 'wyoming-openwakeword';
  public get info(): string {
    return this.name;
  }
  readonly #service: OpenWakeWordService;
  #callback: ((event: WakeDetectionEvent) => void) | undefined;

  public constructor(service: OpenWakeWordService) {
    this.#service = service;
  }

  public preflight(): Promise<void> {
    return this.#service.preflight();
  }
  public async start(): Promise<void> {
    await this.#service.start();
  }

  public onDetection(callback: (event: WakeDetectionEvent) => void): void {
    this.#callback = callback;
  }

  public setSampleRate(rate: number): void {
    this.#sampleRateValue = rate;
  }

  #sampleRateValue = 16_000;

  #pending: WakeDetectionEvent | undefined;

  /**
   * The Wyoming client round-trips over a socket, so a detection resolves
   * after the caller has already moved on. It is latched here and read by the
   * next chunk; without this the Wyoming backend could never wake.
   */
  public takePendingDetection(): WakeDetectionEvent | undefined {
    const current = this.#pending;
    this.#pending = undefined;
    return current;
  }

  public push(pcm: Buffer): void {
    void this.#service
      .push(pcm)
      .then((detection) => {
        if (detection === undefined) return;
        const event: WakeDetectionEvent = {
          keyword: detection.name ?? 'wake',
          score: detection.score,
          audio: audioBufferFromPcm(detection.audio, this.#sampleRateValue),
        };
        this.#pending = event;
        this.#callback?.(event);
      })
      .catch(() => {
        // A dropped connection must not become an unhandled rejection.
        this.#pending = undefined;
      });
  }

  public async stop(): Promise<void> {
    await this.#service.stop();
  }

  public dispose(): void {
    void this.#service.stop();
  }
}

/** Speaker verification over the SpeechBrain bridge. */
class WyomingSpeakerVerification implements SpeakerVerifier {
  public readonly name = 'wyoming-ecapa-tdnn';
  #service: EcapaSpeakerVerifier | UnenrolledSpeakerVerifier | undefined;
  readonly #options: WyomingBackendOptions;
  readonly #sampleRate: number;

  public constructor(options: WyomingBackendOptions) {
    this.#options = options;
    this.#sampleRate = options.sampleRate ?? 16_000;
  }

  public enroll(): Promise<Voiceprint> {
    if (this.#options.voiceprint === undefined) {
      return Promise.reject(
        new Error(
          'The Wyoming backend cannot enroll on its own: it reads the voiceprint written by the native enrollment flow.',
        ),
      );
    }
    return Promise.resolve(this.#asVoiceprint(this.#options.voiceprint));
  }

  public async verify(
    audio: AudioSamples,
    voiceprint: Voiceprint,
  ): Promise<VerificationResult> {
    const stored = this.#toStored(voiceprint);
    this.#service ??= new EcapaSpeakerVerifier(this.#config(), stored);
    if (this.#service instanceof UnenrolledSpeakerVerifier) {
      return this.#service.verify(pcmFromAudioBuffer(audio));
    }
    return this.#service.verify(pcmFromAudioBuffer(audio));
  }

  public preflight(): Promise<void> {
    return this.#service === undefined
      ? Promise.resolve()
      : this.#service.preflight();
  }
  public dispose(): void {
    if (this.#service instanceof EcapaSpeakerVerifier) this.#service.close();
    this.#service = undefined;
  }

  #config(): VoiceConfig {
    return {
      wakeModelPath: this.#options.wakeModelPath,
      dataDirectory: '',
      audioDirectory: '',
      wakeVerifierEnabled: false,
      wakeVerifierPath: this.#options.wakeVerifierPath ?? '',
      wakeThreshold: this.#options.wakeThreshold ?? 0.5,
      wakePhrase: this.#options.wakePhrase ?? 'hey atlas',
      speakerThreshold: this.#options.speakerThreshold ?? 0.55,
      speakerCheck: this.#options.speakerCheck ?? 'advisory',
      minVerificationMs: 700,
      maxVerificationMs: 3_000,
      sttModel: this.#options.sttModel ?? 'base.en',
      sttLanguage: 'en',
      audioBackend: 'auto',
      audioDevice: '',
      sampleRate: this.#sampleRate,
      vad: {
        silenceThreshold: 0.01,
        startMs: 200,
        hangoverMs: 700,
        maxUtteranceMs: 15_000,
      },
      ports: { ...DEFAULT_PORTS, ...this.#options.ports },
    };
  }

  #asVoiceprint(stored: StoredVoiceprint): Voiceprint {
    return {
      backend: this.name,
      model: stored.model,
      embedding: stored.embedding,
      enrolledMs: stored.enrolledMs,
      sampleMs: stored.sampleMs,
      enrolledAt: stored.enrolledAt,
    };
  }

  #toStored(voiceprint: Voiceprint): StoredVoiceprint {
    return {
      version: 1,
      embedding: voiceprint.embedding,
      enrolledMs: voiceprint.enrolledMs,
      sampleMs: voiceprint.sampleMs,
      enrolledAt: voiceprint.enrolledAt,
      model: voiceprint.model,
    };
  }
}

/** Speech-to-text over Wyoming. */
class WyomingSpeechToText implements SpeechToText {
  public readonly name = 'wyoming-whisper-cpp';
  readonly #service: WhisperCppService;

  public constructor(service: WhisperCppService) {
    this.#service = service;
  }

  public preflight(): Promise<void> {
    return this.#service.preflight();
  }
  public async transcribe(audio: AudioSamples): Promise<TranscriptionResult> {
    const text = await this.#service.transcribe(pcmFromAudioBuffer(audio));
    return { text, language: undefined };
  }

  public dispose(): void {
    // The Wyoming client closes after each transcription.
  }
}

/** Assembles the Wyoming backend. */
export class WyomingVoiceBackend implements VoiceBackend {
  public readonly name = 'wyoming';
  public readonly wakeWord: WakeWordDetector;
  public readonly speakerVerification: SpeakerVerifier;
  public readonly speechToText: SpeechToText;

  public constructor(options: WyomingBackendOptions) {
    const config = {
      wakeModelPath: options.wakeModelPath,
      dataDirectory: '',
      audioDirectory: '',
      wakeVerifierEnabled: false,
      wakeVerifierPath: options.wakeVerifierPath ?? '',
      wakeThreshold: options.wakeThreshold ?? 0.5,
      wakePhrase: options.wakePhrase ?? 'hey atlas',
      speakerThreshold: options.speakerThreshold ?? 0.55,
      speakerCheck: options.speakerCheck ?? 'advisory',
      minVerificationMs: 700,
      maxVerificationMs: 3_000,
      sttModel: options.sttModel ?? 'base.en',
      sttLanguage: 'en',
      audioBackend: 'auto' as const,
      audioDevice: '',
      sampleRate: options.sampleRate ?? 16_000,
      vad: {
        silenceThreshold: 0.01,
        startMs: 200,
        hangoverMs: 700,
        maxUtteranceMs: 15_000,
      },
      ports: options.ports,
    };
    this.wakeWord = new WyomingWakeWord(new OpenWakeWordService(config));
    this.speakerVerification = new WyomingSpeakerVerification(options);
    this.speechToText = new WyomingSpeechToText(new WhisperCppService(config));
  }

  /**
   * Reads a stored voiceprint file, if one exists.
   *
   * Delegates to the shared parser: a second copy here would drift, and the
   * previous one silently dropped the backend tag, which is what makes a
   * voiceprint rejectable when the wrong backend is active.
   */
  public static async loadVoiceprint(
    path: string,
  ): Promise<StoredVoiceprint | undefined> {
    try {
      return parseVoiceprint(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof VoiceprintError) {
        throw error;
      }
      return undefined;
    }
  }
}

export { cosineSimilarity };
