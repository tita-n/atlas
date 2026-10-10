/**
 * Microphone capture, buffering, and voice activity detection.
 *
 * Capture shells out to `arecord` (ALSA) or `pw-record` (PipeWire) rather than
 * adding a native Node audio dependency. Both emit raw signed 16-bit little
 * endian PCM, which is exactly Wyoming's audio-chunk payload.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { VadConfig } from '../config/voice-config.js';
import { ATLAS_AUDIO } from './wyoming.js';

/** A chunk of captured PCM. */
export interface AudioChunk {
  readonly pcm: Buffer;
  /** Capture timestamp in ms since the stream started. */
  readonly timestampMs: number;
}

/** Observable capture surface, so tests can replay fixtures. */
export interface AudioSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * Single-pole DC blocker.
 *
 * Capture paths on Linux frequently carry a large constant bias (measured at
 * roughly -0.2 to -0.4 of full scale on this machine). Speech then sits on
 * top of that offset, so an energy gate reads constant loudness and a
 * keyword spotter never matches. Removing the offset is standard front-end
 * practice and is what makes the signal look like audio again.
 */
export class DcBlocker {
  /** Previous input sample. */
  #previousInput = 0;
  /** Previous output sample. */
  #previousOutput = 0;
  /** Smoothing factor, closer to 1 removes slower drift. */
  readonly #coefficient: number;

  public constructor(sampleRate = 16_000, cutoffHz = 20) {
    // One-pole high-pass corner at `cutoffHz`.
    const dt = 1 / sampleRate;
    this.#coefficient = Math.exp(-2 * Math.PI * cutoffHz * dt);
  }

  /** Returns the sample with its DC component removed. */
  public process(input: number): number {
    const output =
      input - this.#previousInput + this.#coefficient * this.#previousOutput;
    this.#previousInput = input;
    this.#previousOutput = output;
    return output;
  }

  /** Removes DC from a PCM buffer in place-safe fashion, returning a new buffer. */
  public processBuffer(pcm: Buffer, width = 2): Buffer {
    const out = Buffer.from(pcm);
    const samples = Math.floor(out.length / width);
    for (let index = 0; index < samples; index += 1) {
      const value = this.process(out.readInt16LE(index * width));
      const clamped = Math.max(-32_768, Math.min(32_767, Math.round(value)));
      out.writeInt16LE(clamped, index * width);
    }
    return out;
  }
}

/** Root-mean-square energy of a PCM buffer, used as a speech/silence proxy. */
export function rmsEnergy(pcm: Buffer, width = ATLAS_AUDIO.width): number {
  if (pcm.length < width) return 0;
  const samples = Math.floor(pcm.length / width);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = pcm.readInt16LE(index * width);
    sum += value * value;
  }
  return Math.sqrt(sum / samples) / 32_768;
}

/** State machine that emits one utterance at a time from a PCM stream. */
export class UtteranceSegmenter {
  readonly #vad: VadConfig;
  readonly #rate: number;
  #active = false;
  #buffer: Buffer = Buffer.alloc(0);
  #speechMs = 0;
  #silenceMs = 0;

  public constructor(vad: VadConfig, rate = ATLAS_AUDIO.rate) {
    this.#vad = vad;
    this.#rate = rate;
  }

  /** Whether an utterance is currently being accumulated. */
  public get speaking(): boolean {
    return this.#active;
  }

  /** Milliseconds of audio currently buffered. */
  public get bufferedMs(): number {
    return (this.#buffer.length / (this.#rate * ATLAS_AUDIO.width)) * 1_000;
  }

  /** Milliseconds of detected speech in the current utterance. */
  public get speechMs(): number {
    return this.#speechMs;
  }

  /** Feeds PCM, returning a completed utterance when one ends. */
  public push(pcm: Buffer): { pcm: Buffer; audioMs: number } | undefined {
    const frameMs = (pcm.length / (this.#rate * ATLAS_AUDIO.width)) * 1_000;
    const speech = rmsEnergy(pcm) > this.#vad.silenceThreshold;

    if (!this.#active) {
      if (!speech) return undefined;
      // Require sustained speech so a door click does not open an utterance.
      this.#speechMs += frameMs;
      if (this.#speechMs < this.#vad.startMs) return undefined;
      this.#active = true;
      this.#silenceMs = 0;
      this.#buffer = Buffer.alloc(0);
    } else {
      this.#buffer = Buffer.concat([this.#buffer, pcm]);
      if (speech) {
        this.#speechMs += frameMs;
        this.#silenceMs = 0;
      } else {
        this.#silenceMs += frameMs;
      }
    }

    if (this.#silenceMs >= this.#vad.hangoverMs) return this.#finish();
    if (this.bufferedMs >= this.#vad.maxUtteranceMs) return this.#finish();
    return undefined;
  }

  #finish(): { pcm: Buffer; audioMs: number } | undefined {
    const pcm = this.#buffer;
    const audioMs = this.bufferedMs;
    this.#active = false;
    this.#buffer = Buffer.alloc(0);
    this.#silenceMs = 0;
    this.#speechMs = 0;
    if (pcm.length === 0) return undefined;
    return { pcm, audioMs };
  }

  /** Abandons any in-progress utterance, for example after a rejected wake. */
  public reset(): void {
    this.#active = false;
    this.#buffer = Buffer.alloc(0);
    this.#speechMs = 0;
    this.#silenceMs = 0;
  }
}

/** Microphone capture via an external recorder process. */
export class MicrophoneCapture implements AudioSource {
  readonly #config: {
    readonly backend: 'auto' | 'arecord' | 'pw-record' | 'parecord';
    readonly device: string;
    readonly rate: number;
  };
  readonly #onChunk: (chunk: AudioChunk) => void;
  #child: ChildProcessWithoutNullStreams | undefined;
  #startedAt = 0;
  #pending = Buffer.alloc(0);
  #lastError: NodeJS.ErrnoException | undefined;
  readonly #dcBlocker: DcBlocker;

  public constructor(
    config: {
      readonly backend: 'auto' | 'arecord' | 'pw-record' | 'parecord';
      readonly device: string;
      readonly rate: number;
    },
    onChunk: (chunk: AudioChunk) => void,
  ) {
    this.#config = config;
    this.#onChunk = onChunk;
    this.#dcBlocker = new DcBlocker(config.rate);
  }

  public get running(): boolean {
    return this.#child !== undefined;
  }

  /** Picks a backend, honouring an explicit choice. */
  public static resolveBackend(
    requested: 'auto' | 'arecord' | 'pw-record' | 'parecord',
  ): 'arecord' | 'pw-record' | 'parecord' {
    if (requested !== 'auto') return requested;
    // PipeWire is the default on modern desktops; fall back to ALSA.
    // parecord is preferred on Linux because --raw gives true PCM on stdout.
    // pw-record has no raw mode and would prepend a WAV header.
    if (process.platform === 'linux') return 'parecord';
    return 'arecord';
  }

  public async start(): Promise<void> {
    if (this.#child !== undefined) return;
    const backend = MicrophoneCapture.resolveBackend(this.#config.backend);

    const args =
      backend === 'pw-record'
        ? [
            '--rate',
            String(this.#config.rate),
            '--channels',
            '1',
            '--format',
            's16',
            ...(this.#config.device === ''
              ? []
              : ['--target', this.#config.device]),
            '-',
          ]
        : backend === 'parecord'
          ? [
              '--raw',
              '--format=s16le',
              `--rate=${this.#config.rate}`,
              '--channels=1',
              ...(this.#config.device === ''
                ? []
                : [`--device=${this.#config.device}`]),
            ]
          : [
              '-q',
              '-t',
              'raw',
              '-f',
              'S16_LE',
              '-r',
              String(this.#config.rate),
              '-c',
              '1',
              ...(this.#config.device === ''
                ? []
                : ['-D', this.#config.device]),
              '-',
            ];

    const child = spawn(backend, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#startedAt = Date.now();
    this.#pending = Buffer.alloc(0);

    child.stderr.resume();
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.#child = undefined;
      this.#lastError = error;
    });
    child.once('exit', () => {
      this.#child = undefined;
    });

    child.stdout.on('data', (data: Buffer) => {
      // Strip DC before anything else sees the samples.
      const cleaned = this.#dcBlocker.processBuffer(data);
      this.#pending = Buffer.concat([this.#pending, cleaned]);
      // Some recorders prepend a RIFF/WAVE header; strip it so the frames
      // are genuine 16-bit PCM.
      if (
        this.#pending.length >= 44 &&
        this.#pending.subarray(0, 4).toString('ascii') === 'RIFF' &&
        this.#pending.subarray(8, 12).toString('ascii') === 'WAVE'
      ) {
        this.#pending = this.#pending.subarray(44);
      }
      // Emit in ~100 ms frames so VAD timing is meaningful.
      const frameBytes = this.#config.rate * 2 * 0.1;
      while (this.#pending.length >= frameBytes) {
        const frame = this.#pending.subarray(0, frameBytes);
        this.#pending = this.#pending.subarray(frameBytes);
        this.#onChunk({
          pcm: frame,
          timestampMs: Date.now() - this.#startedAt,
        });
      }
    });

    // Give the process a moment to fail loudly if the device is missing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (this.#child === undefined) {
      const detail =
        this.#lastError === undefined
          ? ''
          : ` (${this.#lastError.code ?? this.#lastError.message})`;
      throw new Error(
        `Could not start the microphone recorder (${backend})${detail}. ` +
          'Check that a microphone is connected, or set ' +
          'ATLAS_VOICE_AUDIO_BACKEND and ATLAS_VOICE_AUDIO_DEVICE.',
      );
    }
  }

  public stop(): Promise<void> {
    this.#child?.kill('SIGTERM');
    this.#child = undefined;
    return Promise.resolve();
  }
}

/** Replays fixed PCM buffers, used by tests and offline dry runs. */
export class FixtureAudioSource implements AudioSource {
  readonly #chunks: readonly AudioChunk[];
  #index = 0;

  public constructor(chunks: readonly AudioChunk[]) {
    this.#chunks = chunks;
  }

  public get running(): boolean {
    return this.#index < this.#chunks.length;
  }

  public start(): Promise<void> {
    this.#index = 0;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.#index = this.#chunks.length;
    return Promise.resolve();
  }

  /** Returns the next chunk, or undefined when exhausted. */
  public next(): AudioChunk | undefined {
    const chunk = this.#chunks[this.#index];
    this.#index += 1;
    return chunk;
  }
}

/** Wraps raw 16-bit PCM in a minimal RIFF/WAVE container. */
export function pcmToWav(
  pcm: Buffer,
  rate = ATLAS_AUDIO.rate,
  channels = ATLAS_AUDIO.channels,
): Buffer {
  const bytesPerSample = ATLAS_AUDIO.width;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(8 * bytesPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
