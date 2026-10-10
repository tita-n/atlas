/**
 * Storage for the enrolled owner's voiceprint.
 *
 * A voiceprint is biometric-adjacent, so it is treated with the same care as
 * the API key from earlier phases: the directory is 0700, the file is 0600,
 * existing permissions are tightened on load, and the stored values are never
 * written to logs, audit entries, or error messages.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AtlasError } from '../errors.js';

/** Raised when the voiceprint is missing, unreadable, or malformed. */
export class VoiceprintError extends AtlasError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** On-disk voiceprint. */
export interface Voiceprint {
  /** Schema version so future changes can migrate rather than break. */
  readonly version: 1;
  /** ECAPA-TDNN embedding, 192 floats for the standard checkpoint. */
  readonly embedding: readonly number[];
  /** Total voiced milliseconds used to build the embedding. */
  readonly enrolledMs: number;
  /** Individual enrollment sample durations, in ms. */
  readonly sampleMs: readonly number[];
  /** ISO timestamp of enrollment. */
  readonly enrolledAt: string;
  /** Model identifier the embedding came from, for re-enrollment checks. */
  readonly model: string;
  /**
   * Backend that produced the embedding.
   *
   * Persisted so a voiceprint is never compared across incompatible embedding
   * spaces. Older records predate this field and belong to the Wyoming
   * (SpeechBrain ECAPA-TDNN) backend.
   */
  readonly backend?: string;
}

const FILE_NAME = 'voiceprint.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** A stable, non-reversible identifier for logs and audit entries. */
export function voiceprintFingerprint(voiceprint: Voiceprint): string {
  // FNV-1a over the embedding, rendered as hex. Used only to correlate
  // events, never to reconstruct the voiceprint.
  let hash = 0x811c9dc5;
  for (const value of voiceprint.embedding) {
    const text = value.toFixed(6);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/** Reads and validates a voiceprint record. */
export function parseVoiceprint(text: string): Voiceprint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new VoiceprintError(
      'The stored voiceprint is not valid JSON. Re-enroll with "atlas voice enroll --redo".',
      { cause },
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new VoiceprintError(
      'The stored voiceprint is malformed. Re-enroll with "atlas voice enroll --redo".',
    );
  }
  const record = parsed as Record<string, unknown>;
  const embedding = record.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new VoiceprintError(
      'The stored voiceprint has no embedding. Re-enroll with "atlas voice enroll --redo".',
    );
  }
  const floats = embedding.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  );
  if (floats.length !== embedding.length) {
    throw new VoiceprintError(
      'The stored voiceprint contains non-numeric values. Re-enroll with "atlas voice enroll --redo".',
    );
  }
  return {
    version: 1,
    embedding: floats,
    enrolledMs: typeof record.enrolledMs === 'number' ? record.enrolledMs : 0,
    sampleMs: Array.isArray(record.sampleMs)
      ? record.sampleMs.filter((v): v is number => typeof v === 'number')
      : [],
    enrolledAt: typeof record.enrolledAt === 'string' ? record.enrolledAt : '',
    model:
      typeof record.model === 'string'
        ? record.model
        : 'speechbrain/spkrec-ecapa-voxceleb',
    // Records written before this field existed predate the backend tag and
    // were produced by the Wyoming/SpeechBrain path.
    backend:
      typeof record.backend === 'string'
        ? record.backend
        : 'wyoming-ecapa-tdnn',
  };
}

/** Reads, writes, and deletes the enrolled owner's voiceprint. */
export class VoiceprintStore {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = directory;
  }

  /** Where the voiceprint file lives. */
  public get path(): string {
    return join(this.#directory, FILE_NAME);
  }

  /** Creates the private directory, tightening permissions if it exists. */
  public async ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: DIR_MODE });
    await chmod(this.#directory, DIR_MODE);
  }

  /** Returns the stored voiceprint, or undefined when not enrolled. */
  public async load(): Promise<Voiceprint | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, { encoding: 'utf8' });
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return undefined;
      }
      throw new VoiceprintError(
        'Could not read the voiceprint file. Check permissions on the Atlas voice directory.',
        { cause: error },
      );
    }

    // Tighten permissions on read, so a copy that was left world-readable is
    // repaired the first time it is used.
    await this.#tighten();

    return parseVoiceprint(text);
  }

  /** True when an owner has been enrolled. */
  public async exists(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  /** Persists a voiceprint with owner-only permissions. */
  public async save(voiceprint: Voiceprint): Promise<void> {
    await this.ensureDirectory();
    // Write to a temp file first so a crash cannot leave a half-written
    // voiceprint that fails to parse on the next run.
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(voiceprint, null, 2)}\n`, {
      encoding: 'utf8',
      mode: FILE_MODE,
    });
    await chmod(temporary, FILE_MODE);

    const { rename } = await import('node:fs/promises');
    await rename(temporary, this.path);
    await this.#tighten();
  }

  /** Removes any stored voiceprint. */
  public async clear(): Promise<boolean> {
    try {
      await rm(this.path, { force: false });
      return true;
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return false;
      }
      throw new VoiceprintError('Could not remove the voiceprint file.', {
        cause: error,
      });
    }
  }

  async #tighten(): Promise<void> {
    try {
      const info = await stat(this.path);
      const mode = info.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        // Someone can currently read the biometric file. Fix it now.
        await chmod(this.path, mode & ~0o077);
      }
    } catch {
      // Nothing to tighten when the file does not exist.
    }
  }
}

/** Cosine similarity between two embeddings, in [-1, 1]. */
export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** Re-exported so callers can assert readability without importing fs. */
export const VOICEPRINT_FILE_MODE = constants.S_IRUSR | constants.S_IWUSR;
