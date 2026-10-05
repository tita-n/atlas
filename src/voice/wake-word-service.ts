/**
 * Client for the openWakeWord Wyoming service.
 *
 * Backed by rhasspy/wyoming-openwakeword, which loads a custom `.tflite`
 * model. See https://github.com/rhasspy/wyoming-openwakeword.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import type { VoiceConfig } from '../config/voice-config.js';
import { VOICE_HOST } from '../config/voice-config.js';
import { VoiceprintError } from './voiceprint-store.js';
import {
  ATLAS_AUDIO,
  audioChunkFrame,
  WyomingClient,
  type WyomingEvent,
} from './wyoming.js';

/** A wake-word detection reported by the service. */
export interface WakeDetection {
  /** Model name that fired, when reported. */
  readonly name: string | undefined;
  /** Millisecond offset within the stream, when reported. */
  readonly timestamp: number | undefined;
  /** Model score above the configured threshold, when reported. */
  readonly score: number | undefined;
  /** Raw audio for the detection, so it can be used for speaker verification. */
  readonly audio: Buffer;
}

/** Observable surface used by the pipeline, so tests can supply a double. */
export interface WakeWordDetector {
  /** Verifies the model file and service are usable. */
  preflight(): Promise<void>;
  /** Starts listening. Resolves once the service accepts audio. */
  start(): Promise<void>;
  /** Feeds PCM, resolving with a detection if one occurred. */
  push(pcm: Buffer): Promise<WakeDetection | undefined>;
  /** Stops listening. */
  stop(): Promise<void>;
  /** The live detector, for diagnostics. */
  readonly info: string;
}

/** Verifies a file exists and is readable, with a clear error if not. */
export async function assertReadableFile(
  path: string,
  what: string,
): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch (cause) {
    throw new VoiceprintError(
      `${what} is missing or unreadable at ${path}. ` +
        'Train or download the model first, or set ATLAS_VOICE_WAKE_MODEL.',
      { cause },
    );
  }
}

/** openWakeWord over the Wyoming protocol. */
export class OpenWakeWordService implements WakeWordDetector {
  readonly #config: VoiceConfig;
  readonly #client: WyomingClient;
  #running = false;
  /** Rolling audio kept so a detection can be re-examined. */
  #recent: Buffer = Buffer.alloc(0);
  static readonly #KEEP_BYTES = ATLAS_AUDIO.rate * 4;

  public constructor(config: VoiceConfig) {
    this.#config = config;
    this.#client = new WyomingClient({
      host: VOICE_HOST,
      port: config.ports.wakeWord,
    });
  }

  public get info(): string {
    return `openWakeWord via Wyoming at ${this.#client.endpoint}`;
  }

  public async preflight(): Promise<void> {
    await assertReadableFile(this.#config.wakeModelPath, 'Wake-word model');
    // Confirm the service is actually up rather than failing mid-conversation.
    const probe = new WyomingClient({
      host: VOICE_HOST,
      port: this.#config.ports.wakeWord,
    });
    try {
      await probe.connect(2_000);
      await probe.send({ type: 'describe' });
      const info = await probe.receive();
      if (info?.type !== 'info') {
        throw new Error('no info response');
      }
    } catch (cause) {
      throw new VoiceprintError(
        `The openWakeWord Wyoming service is not answering at ` +
          `${this.#client.endpoint}. Start it with ` +
          '`script/run --uri tcp://127.0.0.1:' +
          `${this.#config.ports.wakeWord}\` inside rhasspy/wyoming-openwakeword.`,
        { cause },
      );
    } finally {
      probe.close();
    }
  }

  public async start(): Promise<void> {
    await this.#client.connect();
    await this.#client.send({
      type: 'detect',
      data: { names: ['hey_atlas'] },
    });
    await this.#client.send({ type: 'audio-start' });
    this.#running = true;
  }

  public async push(pcm: Buffer): Promise<WakeDetection | undefined> {
    if (!this.#running) return undefined;

    // Keep a short tail so the audio surrounding a detection is recoverable
    // even though detection frames carry no audio of their own.
    this.#recent = Buffer.concat([this.#recent, pcm]);
    if (this.#recent.length > OpenWakeWordService.#KEEP_BYTES) {
      this.#recent = this.#recent.subarray(
        this.#recent.length - OpenWakeWordService.#KEEP_BYTES,
      );
    }

    await this.#client.write(audioChunkFrame(pcm));

    // Drain any frames already queued; do not block waiting for more audio.
    for (;;) {
      const event = await this.#client.receive();
      if (event === undefined) return undefined;
      if (event.type === 'detection') {
        return this.#toDetection(event);
      }
      if (event.type === 'not-detected') return undefined;
    }
  }

  #toDetection(event: WyomingEvent): WakeDetection {
    const score = event.data.score;
    const name = event.data.name;
    const timestamp = event.data.timestamp;
    return {
      name: typeof name === 'string' ? name : undefined,
      timestamp: typeof timestamp === 'number' ? timestamp : undefined,
      score: typeof score === 'number' ? score : undefined,
      audio: Buffer.from(this.#recent),
    };
  }

  public async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    try {
      await this.#client.send({ type: 'audio-stop' });
    } catch {
      // The peer may already be gone; closing is enough.
    }
    this.#client.close();
  }
}
