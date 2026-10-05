/**
 * The always-on voice activation pipeline.
 *
 * listen -> wake detected -> speaker verified -> command captured -> transcribed
 * -> handed to the existing conversation loop.
 *
 * Every dependency is injected so the whole sequence can be tested with fixed
 * PCM fixtures and no live microphone, model, or provider.
 */
import * as nodeCrypto from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { VoiceConfig } from '../config/voice-config.js';
import {
  pcmToWav,
  rmsEnergy,
  UtteranceSegmenter,
  type AudioSource,
} from './audio-capture.js';
import { pcmDurationMs } from './speaker-verification.js';
import type { VerificationResult } from './speaker-verification.js';
import {
  audioBufferFromPcm,
  pcmFromAudioBuffer,
  type SpeakerVerifier,
  type SpeechToText,
  type WakeWordDetector,
  type WakeDetectionEvent,
  type Voiceprint,
} from './backend.js';
import { ATLAS_AUDIO } from './wyoming.js';

/** Where transcribed text goes; wired to the Phase 0-2 conversation loop. */
export type TranscriptSink = (text: string) => Promise<void>;

/** Records a heard transcript so Phase 4+ can learn from corrections. */
export interface CorrectionSink {
  recordHeard(input: {
    readonly heardTranscript: string;
    readonly audioReference: string;
    readonly conversationId: string | undefined;
  }): Promise<number | undefined>;
  /**
   * Notes a correction against the most recent heard transcript.
   * Returns the correction id, or undefined when nothing was pending.
   */
  recordCorrection(correctedTranscript: string): Promise<number | undefined>;
}

/** A wake/verification event, surfaced for `atlas voice test-wake`. */
export interface WakeReport {
  readonly at: number;
  readonly wakeScore: number | undefined;
  readonly speakerScore: number | undefined;
  readonly accepted: boolean;
  readonly reason: string | undefined;
}

/** Optional observer for the debug command. */
export type WakeObserver = (report: WakeReport) => void;

export interface VoicePipelineOptions {
  readonly config: VoiceConfig;
  readonly detector: WakeWordDetector;
  readonly verifier: SpeakerVerifier;
  readonly stt: SpeechToText;
  readonly corrections?: CorrectionSink | undefined;
  /** The enrolled owner's voiceprint, for speaker verification. */
  readonly voiceprint?: Voiceprint | undefined;
  /** Where captured command audio is written for the corrections log. */
  readonly audioDirectory?: string | undefined;
  /** Conversation the transcript belongs to. */
  readonly conversationId?: string | undefined;
  readonly onTranscript: TranscriptSink;
  readonly onReport?: WakeObserver | undefined;
  /** Injected clock so tests are deterministic. */
  readonly now?: (() => number) | undefined;
}

/** Phrases that mark an immediate self-correction of a misheard command. */
const CORRECTION_PREFIXES = [
  'no i said',
  'no, i said',
  'no you said',
  'no, you said',
  'i meant',
  'not what i said',
  "that's wrong",
  'thats wrong',
  'i said',
];

/**
 * Heuristic detection of an immediate correction.
 *
 * Deliberately simple: this phase only accumulates data, and a later phase
 * decides what to do with it.
 */
export function looksLikeCorrection(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]/g, '');
  return CORRECTION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Orchestrates the always-on voice path. */
export class VoicePipeline {
  readonly #options: VoicePipelineOptions;
  readonly #config: VoiceConfig;
  readonly #segmenter: UtteranceSegmenter;
  readonly #now: () => number;
  #running = false;
  /** Audio held since a wake fired, awaiting enough for verification. */
  #pending: Buffer = Buffer.alloc(0);
  /** Serialises chunk handling so frames cannot race. */
  #tail: Promise<void> = Promise.resolve();
  #pendingSince = 0;
  /** Set once a wake is verified, so the next utterance is the command. */
  #awaitingCommand = false;
  /** Voiced (non-silent) milliseconds buffered since the wake fired. */
  #pendingVoicedMs = 0;
  /** Consecutive silent milliseconds since the last voiced frame. */
  #pendingSilentMs = 0;

  public constructor(options: VoicePipelineOptions) {
    this.#options = options;
    this.#config = options.config;
    this.#segmenter = new UtteranceSegmenter(
      options.config.vad,
      options.config.sampleRate,
    );
    this.#now = options.now ?? (() => Date.now());
  }

  /** Whether the pipeline is currently listening. */
  public get running(): boolean {
    return this.#running;
  }

  /** Runs one turn's worth of work for a single audio chunk. */
  public async handleChunk(pcm: Buffer): Promise<void> {
    if (!this.#running) return;

    // Once the owner is verified, audio is a command, not a wake candidate.
    if (this.#awaitingCommand) {
      const utterance = this.#segmenter.push(pcm);
      if (utterance !== undefined) await this.#dispatch(utterance.pcm);
      return;
    }

    // Detections arrive through the registered callback. Both backends
    // deliver synchronously from push(): the sherpa spotter decodes inline,
    // and the Wyoming adapter resolves its own pending detection before
    // returning. Anything delivered later is handled by the next chunk.
    let detection: WakeDetectionEvent | undefined;
    this.#options.detector.onDetection((event) => {
      detection = event;
    });
    this.#options.detector.push(pcm);
    detection = this.#options.detector.takePendingDetection() ?? detection;

    if (detection === undefined) {
      // A wake may already be pending an inconclusive verification. Keep
      // collecting audio and re-check once there is enough *voiced* audio:
      // the wake phrase on its own is too short to identify a speaker.
      if (this.#pending.length > 0) {
        this.#pending = Buffer.concat([this.#pending, pcm]);
        const voiced = this.#voicedMs(pcm);
        this.#pendingVoicedMs += voiced;
        this.#pendingSilentMs = voiced === 0 ? this.#pendingSilentMs + 100 : 0;
        if (this.#pendingVoicedMs >= this.#config.minVerificationMs) {
          await this.#tryVerify(undefined);
          return;
        }
        // A bare wake phrase with nothing after it will never reach the
        // minimum, so judge what we have once the speaker stops. A weak
        // score simply fails closed.
        if (
          voiced === 0 &&
          this.#pendingSilentMs >= this.#config.vad.hangoverMs
        ) {
          await this.#tryVerify(undefined, true);
        }
      }
      return;
    }

    // A wake fired. Hold audio from here on so verification has material to
    // work with, including any speech that follows the wake phrase.
    this.#pending = pcmFromAudioBuffer(detection.audio);
    this.#pendingSince = this.#now();
    this.#pendingVoicedMs = this.#voicedMs(this.#pending);
    this.#pendingSilentMs = 0;

    const decision = await this.#tryVerify(detection.score);
    if (decision !== undefined) return; // already resolved one way or the other
    // Still inconclusive: keep buffering until we have enough audio.
  }

  /** Discards a buffered wake. */
  #clearPending(): void {
    this.#pending = Buffer.alloc(0);
    this.#pendingVoicedMs = 0;
    this.#pendingSilentMs = 0;
  }

  /** Writes a command utterance under the configured audio directory. */
  async #saveClip(pcm: Buffer): Promise<string> {
    const directory = this.#options.audioDirectory;
    if (directory === '' || directory === undefined) return '';
    await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
    const path = nodePath.join(directory, `${nodeCrypto.randomUUID()}.wav`);
    await nodeFs.writeFile(path, pcmToWav(pcm, ATLAS_AUDIO.rate), {
      mode: 0o600,
    });
    return path;
  }

  /** Voiced milliseconds in a PCM buffer, using the same energy gate as the VAD. */
  #voicedMs(pcm: Buffer): number {
    const frameBytes = Math.round(this.#config.sampleRate * 0.05) * 2;
    let voiced = 0;
    for (
      let offset = 0;
      offset + frameBytes <= pcm.length;
      offset += frameBytes
    ) {
      if (
        rmsEnergy(pcm.subarray(offset, offset + frameBytes)) >
        this.#config.vad.silenceThreshold
      ) {
        voiced += 50;
      }
    }
    return voiced;
  }

  async #tryVerify(
    wakeScore: number | undefined,
    bestEffort = false,
  ): Promise<VerificationResult | undefined> {
    const held = this.#pending;
    const audioMs = pcmDurationMs(held, ATLAS_AUDIO.rate);
    // A short clip carries no identity signal, so below the minimum we keep
    // waiting. The exception is the end of a wake phrase: a bare "Hey Atlas"
    // will never reach the minimum, so once the speaker stops we judge what we
    // have and let the threshold decide.
    const hasSignal = this.#pendingVoicedMs >= this.#config.minVerificationMs;
    if (!hasSignal && (!bestEffort || this.#pendingVoicedMs < 250)) {
      // Best-effort and still nothing usable: drop the buffer so a short burst
      // does not retry on every subsequent frame.
      if (bestEffort) {
        this.#pending = Buffer.alloc(0);
        this.#pendingVoicedMs = 0;
        this.#pendingSilentMs = 0;
        this.#segmenter.reset();
      }
      return undefined;
    }
    const audio = audioBufferFromPcm(held, ATLAS_AUDIO.rate);
    const result = this.#options.voiceprint
      ? await this.#options.verifier.verify(audio, this.#options.voiceprint)
      : await this.#options.verifier.verify(audio);

    // Too short to judge yet: hold and try again as more audio arrives.
    if (
      result.reason !== undefined &&
      result.reason.startsWith('Sample too short') &&
      audioMs < this.#config.maxVerificationMs
    ) {
      return undefined;
    }

    const mode = this.#config.speakerCheck;
    // Verification is a convenience filter against stray audio, never a
    // security control. In advisory mode a miss is reported but does not
    // block, because a one-second wake phrase is too short for the embedding
    // model to say anything reliable about who spoke it.
    const blocking = mode === 'enforce' && !result.accepted;

    if (!result.accepted && mode === 'off') {
      this.#clearPending();
      this.#report(wakeScore, result);
      this.#awaitingCommand = true;
      this.#segmenter.reset();
      return result;
    }
    if (blocking) {
      // Fail closed and silently. The user is never told a wake happened,
      // so another person saying the phrase is indistinguishable from silence.
      this.#report(wakeScore, result);
      this.#clearPending();
      return result;
    }

    this.#report(wakeScore, result);
    this.#awaitingCommand = true;
    this.#pending = Buffer.alloc(0);
    this.#pendingVoicedMs = 0;
    // Start the command capture from here; trailing wake audio is discarded.
    this.#segmenter.reset();
    return result;
  }

  #report(wakeScore: number | undefined, result: VerificationResult): void {
    this.#options.onReport?.({
      at: this.#now(),
      wakeScore,
      speakerScore: result.score,
      accepted: result.accepted,
      reason: result.reason,
    });
  }

  async #dispatch(commandPcm: Buffer): Promise<void> {
    this.#awaitingCommand = false;
    this.#segmenter.reset();

    const { text } = await this.#options.stt.transcribe(
      audioBufferFromPcm(commandPcm, ATLAS_AUDIO.rate),
    );
    if (text === '') {
      // Nothing intelligible was said. Return to listening without noise.
      return;
    }

    // Re-check for a self-correction before logging the new transcript.
    if (looksLikeCorrection(text)) {
      await this.#options.corrections?.recordCorrection(text);
    }

    if (this.#options.corrections !== undefined) {
      // Persist the utterance so a later phase can replay what was actually
      // said. The corrections log stores a path, never inline audio.
      let audioReference = '';
      try {
        audioReference = await this.#saveClip(commandPcm);
      } catch (error) {
        this.#onFailureCallback?.(error);
      }
      await this.#options.corrections.recordHeard({
        heardTranscript: text,
        audioReference,
        conversationId: this.#options.conversationId,
      });
    }

    // Hand to the existing conversation loop, exactly like typed input.
    await this.#options.onTranscript(text);
  }

  /**
   * Drains a buffered wake once the caller has more audio available.
   *
   * Callers feeding a live stream should call this after each chunk so a wake
   * that was too short to verify gets re-tried as speech continues.
   */
  public async settle(): Promise<void> {
    if (!this.#running || this.#awaitingCommand) return;
    if (this.#pending.length === 0) return;
    if (this.#now() - this.#pendingSince > this.#config.maxVerificationMs) {
      // The window has closed. Make a final decision and drop the buffer, so
      // a non-owner is never given an unbounded stream of audio to analyse.
      this.#pending = Buffer.alloc(0);
      await this.#tryVerify(undefined);
    }
  }

  /**
   * Queues a chunk and resolves when it has been processed.
   *
   * Chunks are serialised deliberately: native inference takes longer than the
   * capture frame interval, so concurrent calls would race on the pending
   * buffer and the utterance segmenter.
   */
  public enqueue(pcm: Buffer): Promise<void> {
    this.#tail = this.#tail
      .then(() => this.handleChunk(pcm))
      .then(() => this.settle())
      .catch((cause: unknown) => {
        // A model or service failure must not become an unhandled rejection,
        // which would kill the process instead of failing closed.
        this.#onFailure(cause);
      });
    return this.#tail;
  }

  /** Reports a background failure without aborting the session. */
  public onFailure(callback: (error: unknown) => void): void {
    this.#onFailureCallback = callback;
  }

  #onFailureCallback: ((error: unknown) => void) | undefined = undefined;

  #onFailure(cause: unknown): void {
    this.#pending = Buffer.alloc(0);
    this.#pendingVoicedMs = 0;
    this.#awaitingCommand = false;
    this.#segmenter.reset();
    this.#onFailureCallback?.(cause);
  }

  /** Runs the pipeline against a finite source until it is exhausted. */
  public async run(
    source: AudioSource & { next?: () => { pcm: Buffer } | undefined },
  ): Promise<void> {
    await source.start();
    this.#running = true;
    try {
      for (;;) {
        const chunk = source.next?.();
        if (chunk === undefined) break;
        await this.handleChunk(chunk.pcm);
        await this.settle();
      }
      // Final decision on anything still buffered. The buffer must still be
      // populated here: #tryVerify reads it to build the audio sample.
      if (this.#pending.length > 0) {
        await this.#tryVerify(undefined);
        this.#pending = Buffer.alloc(0);
        this.#pendingVoicedMs = 0;
      }
    } finally {
      this.#running = false;
      await source.stop();
    }
  }

  /**
   * Starts listening.
   *
   * Runs the preflight first so a missing model file or an unreachable service
   * fails immediately and visibly, instead of the pipeline appearing to run
   * while silently never waking.
   */
  public async start(): Promise<void> {
    await this.#options.detector.preflight();
    await this.#options.verifier.preflight();
    await this.#options.stt.preflight();

    this.#pending = Buffer.alloc(0);
    this.#pendingSince = 0;
    this.#pendingVoicedMs = 0;
    this.#awaitingCommand = false;
    this.#segmenter.reset();
    await this.#options.detector.start();
    this.#running = true;
  }

  /** Stops listening and returns to a clean state. */
  public async stop(): Promise<void> {
    this.#running = false;
    this.#pending = Buffer.alloc(0);
    this.#pendingVoicedMs = 0;
    this.#awaitingCommand = false;
    this.#segmenter.reset();
    await this.#options.detector.stop();
  }
}
