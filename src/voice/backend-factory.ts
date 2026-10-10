/**
 * Backend selection.
 *
 * The rest of the harness depends only on the `VoiceBackend` interface, so
 * which implementation is active is invisible to the activation pipeline and
 * the CLI, exactly as `LLMProvider` works for models.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CliInputError } from '../errors.js';
import type { VoiceBackend } from './backend.js';
import type { VoiceConfig } from '../config/voice-config.js';
import { ModelManager, resolveModelProfile } from './model-manager.js';
import { SherpaWakeWord } from './backends/sherpa-onnx/wake-word.js';
import { SherpaSpeakerVerification } from './backends/sherpa-onnx/speaker-verification.js';
import { SherpaSpeechToText } from './backends/sherpa-onnx/stt.js';
import { WyomingVoiceBackend } from './backends/wyoming/backend.js';

export type VoiceBackendName = 'sherpa-onnx' | 'wyoming';

/** Default cache location for downloaded models. */
export function defaultModelDirectory(): string {
  return join(homedir(), '.atlas', 'models');
}

/** Layered resolution: explicit argument, then env, then default. */
export function resolveVoiceBackend(
  explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): VoiceBackendName {
  const raw = explicit ?? environment.ATLAS_VOICE_BACKEND;
  if (raw === undefined || raw === '') return 'sherpa-onnx';
  if (raw === 'sherpa-onnx' || raw === 'wyoming') return raw;
  throw new CliInputError(
    `Unknown voice backend "${raw}". Use "sherpa-onnx" (lightweight, default) or "wyoming".`,
  );
}

export interface CreateVoiceBackendOptions {
  readonly backend: VoiceBackendName;
  readonly modelsDirectory?: string;
  readonly modelDirectory?: string;
  readonly sampleRate?: number;
  readonly speakerThreshold?: number;
  readonly wakeThreshold?: number;
  /** The wake phrase to listen for; defaults to the built-in one. */
  readonly wakePhrase?: string;
  readonly speakerCheck?: VoiceConfig['speakerCheck'];
  readonly sttModel?: string;
  readonly ports?: {
    readonly wakeWord: number;
    readonly speakerVerification: number;
    readonly speechToText: number;
  };
  readonly wakeModelPath?: string;
  readonly wakeVerifierPath?: string;
  readonly onModelProgress?: ((message: string) => void) | undefined;
  /** Exact keyword lines for a diagnostic run, bypassing generation. */
  readonly keywordLines?: readonly string[] | undefined;
}

/** Builds the configured backend. */
export function createVoiceBackend(
  options: CreateVoiceBackendOptions,
): Promise<VoiceBackend> {
  if (options.backend === 'wyoming') {
    const { wakeModelPath, wakeVerifierPath, ports } = options;
    if (wakeModelPath === undefined || ports === undefined) {
      throw new CliInputError(
        'The wyoming backend needs the wake model path and service ports. ' +
          'This is set up by "atlas permissions"-era voice config; see the README.',
      );
    }
    return Promise.resolve(
      new WyomingVoiceBackend({
        wakeModelPath,
        ports,
        ...(wakeVerifierPath === undefined ? {} : { wakeVerifierPath }),
        ...(options.sampleRate === undefined
          ? {}
          : { sampleRate: options.sampleRate }),
        ...(options.speakerThreshold === undefined
          ? {}
          : { speakerThreshold: options.speakerThreshold }),
        ...(options.wakeThreshold === undefined
          ? {}
          : { wakeThreshold: options.wakeThreshold }),
        ...(options.sttModel === undefined
          ? {}
          : { sttModel: options.sttModel }),
      }),
    );
  }

  const models = new ModelManager(
    options.modelsDirectory ?? defaultModelDirectory(),
    resolveModelProfile(),
    options.onModelProgress,
  );

  const prefix =
    resolveModelProfile() === 'minimal'
      ? 'tiny.en'
      : (options.sttModel ?? 'base.en');

  return Promise.resolve({
    name: 'sherpa-onnx' as const,
    wakeWord: new SherpaWakeWord({
      models,
      ...(options.sampleRate === undefined
        ? {}
        : { sampleRate: options.sampleRate }),
      ...(options.wakeThreshold === undefined
        ? {}
        : { score: options.wakeThreshold }),
      ...(options.wakePhrase === undefined
        ? {}
        : { phrase: options.wakePhrase }),
      ...(options.keywordLines === undefined
        ? {}
        : { keywordLines: options.keywordLines }),
    }),
    speakerVerification: new SherpaSpeakerVerification({
      models,
      ...(options.speakerThreshold === undefined
        ? {}
        : { threshold: options.speakerThreshold }),
    }),
    speechToText: new SherpaSpeechToText({ models, modelName: prefix }),
  });
}
