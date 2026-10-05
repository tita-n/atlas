/**
 * Model download and caching.
 *
 * Model files are deliberately not bundled in the npm package: that would move
 * a multi-hundred-megabyte download into `npm install` instead of solving it.
 * Everything is fetched on demand into `~/.atlas/models/`, disclosed by size
 * before anything is transferred, and reused across upgrades.
 */
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

import { CliInputError, VoiceModelError } from '../errors.js';

/** Which model sizes to fetch. */
export type ModelProfile = 'default' | 'minimal';

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/** One downloadable asset. */
export interface ModelAsset {
  readonly id: string;
  readonly url: string;
  /** Archive format, or 'file' for a single file. */
  readonly kind: 'tar.bz2' | 'file';
  /** Directory name created inside the component folder, when archived. */
  readonly directory?: string;
  /**
   * A file that must exist after extraction, to prove success.
   *
   * For the speaker model this is also the model identity, so consumers read
   * the filename from here rather than hardcoding one per profile.
   */
  readonly sentinel: string;
  /** Approximate download size in bytes, measured from the release assets. */
  readonly bytes: number;
  readonly description: string;
}

/** Sizes are the measured Content-Length of the current release assets. */
const MEGABYTE = 1024 * 1024;

/** Download ceiling, so a stalled connection fails instead of hanging. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const SHERPA_MODELS: Record<
  ModelProfile,
  {
    readonly wake: ModelAsset;
    readonly speech: ModelAsset;
    readonly speaker: ModelAsset;
  }
> = {
  default: {
    wake: {
      id: 'kws-zipformer',
      url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2`,
      kind: 'tar.bz2',
      directory: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
      sentinel: 'keywords.txt',
      bytes: 33 * MEGABYTE,
      description:
        'keyword spotting model, 3.3M params, sherpa-onnx (wakes on any voice)',
    },
    speech: {
      id: 'whisper-base.en',
      url: `${RELEASES}/asr-models/sherpa-onnx-whisper-base.en.tar.bz2`,
      kind: 'tar.bz2',
      directory: 'sherpa-onnx-whisper-base.en',
      sentinel: 'base.en-encoder.onnx',
      bytes: 199 * MEGABYTE,
      description: 'Whisper base.en speech-to-text (sherpa-onnx ONNX)',
    },
    speaker: {
      id: '3dspeaker-campplus-en',
      url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`,
      kind: 'file',
      sentinel: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
      bytes: 28 * MEGABYTE,
      description:
        '3D-Speaker CAM++ speaker verification (English, VoxCeleb, sherpa-onnx ONNX)',
    },
  },
  minimal: {
    wake: {
      id: 'kws-zipformer',
      url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2`,
      kind: 'tar.bz2',
      directory: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
      sentinel: 'keywords.txt',
      bytes: 33 * MEGABYTE,
      description:
        'keyword spotting model (shared: already the smallest option)',
    },
    speech: {
      id: 'whisper-tiny.en',
      url: `${RELEASES}/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2`,
      kind: 'tar.bz2',
      directory: 'sherpa-onnx-whisper-tiny.en',
      sentinel: 'tiny.en-encoder.onnx',
      bytes: 113 * MEGABYTE,
      description: 'Whisper tiny.en speech-to-text (fastest, least accurate)',
    },
    speaker: {
      id: '3dspeaker-eres2netv2-en',
      url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_en_voxceleb_16k.onnx`,
      kind: 'file',
      sentinel: '3dspeaker_speech_eres2netv2_sv_en_voxceleb_16k.onnx',
      bytes: 26 * MEGABYTE,
      description:
        '3D-Speaker ERes2NetV2 speaker verification (slightly smaller)',
    },
  },
};

/** Formats a byte count for the pre-download disclosure. */
export function formatBytes(bytes: number): string {
  if (bytes < MEGABYTE) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * MEGABYTE) return `${(bytes / MEGABYTE).toFixed(0)} MB`;
  return `${(bytes / (1024 * MEGABYTE)).toFixed(1)} GB`;
}

/** Describes what a profile will download, without downloading anything. */
export function describeDownload(profile: ModelProfile, root: string): string {
  const models = SHERPA_MODELS[profile];
  const total = models.wake.bytes + models.speech.bytes + models.speaker.bytes;
  const lines = [
    'Atlas will download these voice models (cached for later use):',
    `  ${formatBytes(models.wake.bytes).padStart(7)}  ${models.wake.description}`,
    `  ${formatBytes(models.speech.bytes).padStart(7)}  ${models.speech.description}`,
    `  ${formatBytes(models.speaker.bytes).padStart(7)}  ${models.speaker.description}`,
    `  ${formatBytes(total).padStart(7)}  total, into ${root}`,
  ];
  if (profile === 'minimal') {
    lines.push(
      'Minimal profile trades accuracy for size: tiny.en mishears more, and the',
      'speaker model is slightly weaker. Raise with ATLAS_VOICE_MODELS=default.',
    );
  }
  return lines.join('\n');
}

/** Which model profile to use. */
export function resolveModelProfile(
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfile {
  return environment.ATLAS_VOICE_MODELS === 'minimal' ? 'minimal' : 'default';
}

/** Downloads and caches sherpa-onnx models. */
export class ModelManager {
  readonly #root: string;
  readonly #profile: ModelProfile;
  readonly #onProgress: ((message: string) => void) | undefined;

  public constructor(
    root: string,
    profile: ModelProfile = 'default',
    onProgress?: (message: string) => void,
  ) {
    this.#root = root;
    this.#profile = profile;
    this.#onProgress = onProgress;
  }

  /** Directory for one component. */
  public componentDirectory(component: 'wake' | 'speech' | 'speaker'): string {
    return join(this.#root, component);
  }

  /**
   * The model file the active profile uses for a component.
   *
   * Callers must read the filename from here: the speaker model differs
   * between the default and minimal profiles, and hardcoding one made the
   * other profile fail with a misleading "model missing" error.
   */
  public modelFile(component: 'wake' | 'speech' | 'speaker'): string {
    return join(
      this.componentDirectory(component),
      SHERPA_MODELS[this.#profile][component].sentinel,
    );
  }

  /** The profile this manager was built with. */
  public get profile(): ModelProfile {
    return this.#profile;
  }

  /** Whether a component's model is already present and complete. */
  /**
   * Resolves the directory that actually holds a component's model files.
   *
   * A release tarball extracts into a nested folder inside the component
   * directory, while a manually placed model sits directly in it. Both layouts
   * are accepted; assuming only one made every archived model report as
   * missing and re-download on every run.
   */
  public async modelDirectory(
    component: 'wake' | 'speech' | 'speaker',
  ): Promise<string> {
    const asset = SHERPA_MODELS[this.#profile][component];
    const direct = this.componentDirectory(component);
    if (await exists(join(direct, asset.sentinel))) return direct;
    if (asset.directory !== undefined) {
      const nested = join(direct, asset.directory);
      if (await exists(join(nested, asset.sentinel))) return nested;
    }
    return direct;
  }

  public async isCached(
    component: 'wake' | 'speech' | 'speaker',
  ): Promise<boolean> {
    const asset = SHERPA_MODELS[this.#profile][component];
    return exists(join(await this.modelDirectory(component), asset.sentinel));
  }

  /** True when every component is cached. */
  public async isComplete(): Promise<boolean> {
    return (
      (await this.isCached('wake')) &&
      (await this.isCached('speech')) &&
      (await this.isCached('speaker'))
    );
  }

  /** Pre-download disclosure, for confirmation prompts. */
  public describe(): string {
    return describeDownload(this.#profile, this.#root);
  }

  /**
   * Ensures a component is present, downloading once if it is not.
   *
   * Archives are downloaded to a `.part` file and only moved into place after
   * extraction succeeds, so an interrupted download can never leave a
   * half-extracted model that looks complete.
   */
  public async ensure(
    component: 'wake' | 'speech' | 'speaker',
  ): Promise<string> {
    const target = this.componentDirectory(component);
    const asset = SHERPA_MODELS[this.#profile][component];
    // Already cached, in whichever layout it was placed: hand back the real
    // directory so callers build correct model paths.
    if (await this.isCached(component)) return this.modelDirectory(component);

    await mkdir(target, { recursive: true, mode: 0o755 });
    const partial = join(target, `${asset.id}.part`);

    this.#onProgress?.(
      `Downloading ${asset.description} (${formatBytes(asset.bytes)})…`,
    );

    // A network reset or timeout must surface as a clear, retryable error.
    // Letting it escape as an unhandled rejection would kill the CLI.
    let response: Response;
    try {
      response = await fetch(asset.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (cause) {
      await rm(partial, { force: true });
      throw new VoiceModelError(
        `Could not download ${asset.description}: ${errorMessage(cause)} ` +
          'Check your connection and try again; nothing was left behind.',
        { cause },
      );
    }
    if (!response.ok || response.body === null) {
      await rm(partial, { force: true });
      throw new VoiceModelError(
        `Could not download ${asset.description}: HTTP ${response.status} from ${asset.url}`,
      );
    }
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
        createWriteStream(partial, { mode: 0o644 }),
      );
    } catch (cause) {
      await rm(partial, { force: true });
      throw new VoiceModelError(
        `The download of ${asset.description} was interrupted: ` +
          `${errorMessage(cause)}. Nothing was left behind; run the command again to retry.`,
        { cause },
      );
    }

    if (asset.kind === 'tar.bz2') {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      try {
        // The sentinel is checked inside the component directory, so the
        // archive must be extracted there rather than at the model root.
        await run('tar', ['xjf', partial, '-C', target]);
      } catch (cause) {
        await rm(partial, { force: true });
        throw new VoiceModelError(
          `Could not extract ${asset.description}. A tar implementation is required.`,
          { cause },
        );
      }
      await rm(partial, { force: true });
    } else {
      await rename(partial, join(target, asset.sentinel));
    }

    const extracted = await this.modelDirectory(component);
    if (!(await exists(join(extracted, asset.sentinel)))) {
      throw new VoiceModelError(
        `${asset.description} downloaded but ${asset.sentinel} is missing. ` +
          'The archive may be corrupt.',
      );
    }
    await chmod(target, 0o755);
    this.#onProgress?.(`${asset.description} ready.`);
    return extracted;
  }

  /** Ensures every component is present. */
  public async ensureAll(): Promise<void> {
    await this.ensure('wake');
    await this.ensure('speech');
    await this.ensure('speaker');
  }

  /** Deletes cached models so they can be re-fetched. */
  public async clear(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Validates a backend name from config. */
export function parseVoiceBackend(value: string): 'sherpa-onnx' | 'wyoming' {
  if (value === 'sherpa-onnx' || value === 'wyoming') return value;
  throw new CliInputError('voice backend must be "sherpa-onnx" or "wyoming".');
}
