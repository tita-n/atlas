import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { CliInputError } from '../errors.js';

/** Default loopback ports for the Wyoming services Atlas expects. */
export const DEFAULT_PORTS = {
  /** rhasspy/wyoming-openwakeword */
  wakeWord: 10400,
  /** Atlas's own ECAPA-TDNN bridge (see voice-bridge/) */
  speakerVerification: 10401,
  /** rhasspy/wyoming-whisper-cpp */
  speechToText: 10300,
} as const;

/** Built-in voice activity detection tuning. */
export interface VadConfig {
  /** RMS energy below which a frame counts as silence. */
  readonly silenceThreshold: number;
  /** Speech must exceed the threshold for this many ms to start an utterance. */
  readonly startMs: number;
  /** Silence must last this long, in ms, to end an utterance. */
  readonly hangoverMs: number;
  /** Hard cap on a single utterance, in ms. */
  readonly maxUtteranceMs: number;
}

/** How speaker verification affects activation. */
type SpeakerCheck = 'advisory' | 'enforce' | 'off';

export interface VoiceConfig {
  /** Directory holding the voiceprint and enrollment audio. */
  readonly dataDirectory: string;
  /** Where captured audio clips are written for the corrections log. */
  readonly audioDirectory: string;
  /** openWakeWord model file for the custom "Hey Atlas" model. */
  readonly wakeModelPath: string;
  /** Wake-word probability above which a detection is accepted. */
  readonly wakeThreshold: number;
  /** Whether the openWakeWord custom verifier stage is enabled. */
  readonly wakeVerifierEnabled: boolean;
  /** openWakeWord custom verifier model for the enrolled owner. */
  readonly wakeVerifierPath: string;
  /** Cosine-similarity threshold above which a speaker is accepted. */
  /** The phrase that wakes Atlas, as plain words. */
  readonly wakePhrase: string;
  readonly speakerThreshold: number;
  /**
   * How speaker verification affects activation.
   *
   * `advisory` (default) reports a match but never blocks. A wake phrase is
   * roughly one second, and the embedding model needs about four seconds of
   * the same speaker before a score carries information, so blocking on it
   * would reject the owner almost every time. `enforce` restores strict
   * gating; `off` skips verification entirely.
   *
   * This is a convenience filter against stray audio (a TV, a podcast, a
   * roommate), never a security control: anyone at an unlocked session can
   * simply run `atlas chat` in a terminal.
   */
  readonly speakerCheck: SpeakerCheck;
  /** Utterances shorter than this cannot be verified and are rejected. */
  readonly minVerificationMs: number;
  /** Longer audio is truncated to this before verification. */
  readonly maxVerificationMs: number;
  /** Whisper model name or path. */
  readonly sttModel: string;
  /** STT language code, or empty to auto-detect. */
  readonly sttLanguage: string;
  /** Microphone capture backend. */
  readonly audioBackend: 'auto' | 'arecord' | 'pw-record' | 'parecord';
  /** ALSA/PipeWire device name, or empty for the system default. */
  readonly audioDevice: string;
  /** PCM sample rate requested from the microphone. */
  readonly sampleRate: number;
  readonly vad: VadConfig;
  /** Wyoming service endpoints, always on loopback. */
  readonly ports: {
    readonly wakeWord: number;
    readonly speakerVerification: number;
    readonly speechToText: number;
  };
}

/** Loopback host used for every Wyoming connection. */
export const VOICE_HOST = '127.0.0.1';

/** Parses the speaker-check mode, rejecting anything unrecognised. */
function readSpeakerCheck(
  raw: string | undefined,
): 'advisory' | 'enforce' | 'off' {
  if (raw === 'enforce' || raw === 'off') return raw;
  if (raw !== undefined && raw !== '') {
    throw new CliInputError(
      'ATLAS_VOICE_SPEAKER_CHECK must be advisory, enforce, or off.',
    );
  }
  return 'advisory';
}

const DEFAULTS: VoiceConfig = {
  dataDirectory: join(homedir(), '.atlas', 'voiceprint'),
  audioDirectory: join(homedir(), '.atlas', 'voice-audio'),
  wakeModelPath: join(
    homedir(),
    '.atlas',
    'voice-models',
    'hey_atlas',
    'hey_atlas.tflite',
  ),
  wakeThreshold: 0.5,
  wakeVerifierEnabled: true,
  wakeVerifierPath: join(
    homedir(),
    '.atlas',
    'voice-models',
    'hey_atlas',
    'hey_atlas_verifier.pkl',
  ),
  wakePhrase: 'hey atlas',
  speakerThreshold: 0.55,
  speakerCheck: 'advisory',
  // Measured on the enrolled owner: a 1s clip has essentially no identity
  // signal (owner and stranger both score ~0.0), 2s separates cleanly, and
  // 4s is comfortable. Verification therefore runs on the wake phrase PLUS the
  // speech that follows it, never on the wake phrase alone.
  minVerificationMs: 2_000,
  maxVerificationMs: 6_000,
  sttModel: 'base.en',
  sttLanguage: 'en',
  audioBackend: 'auto',
  audioDevice: '',
  sampleRate: 16_000,
  vad: {
    silenceThreshold: 0.01,
    startMs: 200,
    hangoverMs: 700,
    maxUtteranceMs: 15_000,
  },
  ports: DEFAULT_PORTS,
};

function positiveInt(raw: string, name: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliInputError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function unitFloat(raw: string, name: string): number {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliInputError(`${name} must be a number between 0 and 1.`);
  }
  return parsed;
}

/** Overrides accepted from environment variables and CLI flags. */
export interface VoiceConfigOverrides {
  readonly dataDirectory?: string | undefined;
  readonly audioDirectory?: string | undefined;
  readonly wakeModelPath?: string | undefined;
  readonly wakeThreshold?: number | undefined;
  readonly wakePhrase?: string | undefined;
  readonly speakerThreshold?: number | undefined;
  readonly speakerCheck?: SpeakerCheck | undefined;
  readonly sttModel?: string | undefined;
  readonly audioBackend?: VoiceConfig['audioBackend'] | undefined;
  readonly audioDevice?: string | undefined;
  readonly sampleRate?: number | undefined;
}

/** Expands a leading `~` so config paths can be written naturally. */
export function expandUserPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function pathOr(explicit: string | undefined, fallback: string): string {
  const chosen = explicit ?? fallback;
  return isAbsolute(chosen) ? chosen : resolve(expandUserPath(chosen));
}

/** Builds a voice config, layering CLI flags over environment over defaults. */
export function loadVoiceConfig(
  overrides: VoiceConfigOverrides = {},
  environment: NodeJS.ProcessEnv = process.env,
): VoiceConfig {
  const envBackend = environment.ATLAS_VOICE_AUDIO_BACKEND;
  const backend =
    overrides.audioBackend ??
    (envBackend === 'arecord' ||
    envBackend === 'pw-record' ||
    envBackend === 'parecord'
      ? envBackend
      : undefined);

  const device =
    overrides.audioDevice ?? environment.ATLAS_VOICE_AUDIO_DEVICE ?? '';
  const sampleRateRaw =
    overrides.sampleRate ??
    (environment.ATLAS_VOICE_SAMPLE_RATE === undefined
      ? undefined
      : positiveInt(
          environment.ATLAS_VOICE_SAMPLE_RATE,
          'ATLAS_VOICE_SAMPLE_RATE',
        ));

  return {
    ...DEFAULTS,
    dataDirectory: pathOr(
      overrides.dataDirectory ?? environment.ATLAS_VOICE_DATA_DIR,
      DEFAULTS.dataDirectory,
    ),
    audioDirectory: pathOr(
      overrides.audioDirectory ?? environment.ATLAS_VOICE_AUDIO_DIR,
      DEFAULTS.audioDirectory,
    ),
    wakeModelPath: pathOr(
      overrides.wakeModelPath ?? environment.ATLAS_VOICE_WAKE_MODEL,
      DEFAULTS.wakeModelPath,
    ),
    wakePhrase:
      overrides.wakePhrase ??
      (environment.ATLAS_VOICE_WAKE_PHRASE === undefined ||
      environment.ATLAS_VOICE_WAKE_PHRASE === ''
        ? DEFAULTS.wakePhrase
        : environment.ATLAS_VOICE_WAKE_PHRASE),
    wakeThreshold:
      overrides.wakeThreshold ??
      (environment.ATLAS_VOICE_WAKE_THRESHOLD === undefined
        ? DEFAULTS.wakeThreshold
        : unitFloat(
            environment.ATLAS_VOICE_WAKE_THRESHOLD,
            'ATLAS_VOICE_WAKE_THRESHOLD',
          )),
    speakerCheck:
      overrides.speakerCheck ??
      readSpeakerCheck(environment.ATLAS_VOICE_SPEAKER_CHECK),
    speakerThreshold:
      overrides.speakerThreshold ??
      (environment.ATLAS_VOICE_SPEAKER_THRESHOLD === undefined
        ? DEFAULTS.speakerThreshold
        : unitFloat(
            environment.ATLAS_VOICE_SPEAKER_THRESHOLD,
            'ATLAS_VOICE_SPEAKER_THRESHOLD',
          )),
    sttModel:
      overrides.sttModel ??
      environment.ATLAS_VOICE_STT_MODEL ??
      DEFAULTS.sttModel,
    audioBackend: backend ?? DEFAULTS.audioBackend,
    audioDevice: device,
    sampleRate: sampleRateRaw ?? DEFAULTS.sampleRate,
  };
}
