/**
 * Speaker verification against the enrolled owner's voiceprint.
 *
 * Uses SpeechBrain's ECAPA-TDNN (`speechbrain/spkrec-ecapa-voxceleb`), which
 * reports 0.80% EER on the VoxCeleb1-O protocol. There is no published Node
 * binding and no Wyoming server for it, so Atlas ships its own small Wyoming
 * bridge in voice-bridge/atlas-speaker-verification.py and speaks to that.
 *
 * This is a usability gate, not an authentication system. ECAPA is not
 * designed to resist recorded or replayed speech, which is why the pipeline
 * treats a pass as "probably the owner" rather than as proof of identity.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { VoiceConfig } from '../config/voice-config.js';
import { VOICE_HOST } from '../config/voice-config.js';
import { ATLAS_AUDIO, audioChunkFrame, WyomingClient } from './wyoming.js';
import { VoiceprintError } from './voiceprint-store.js';
import { cosineSimilarity } from './voiceprint-store.js';
import type { Voiceprint } from './voiceprint-store.js';

/** Outcome of one verification attempt. */
export interface VerificationResult {
  /** Whether the speaker is accepted at the configured threshold. */
  readonly accepted: boolean;
  /** Cosine similarity between the sample and the stored voiceprint. */
  readonly score: number;
  /** Threshold the score was compared against. */
  readonly threshold: number;
  /** Milliseconds of audio the decision was based on. */
  readonly audioMs: number;
  /** Why the sample was rejected, when it was. */
  readonly reason?: string;
}

/** Observable surface used by the pipeline, so tests can supply a double. */
export interface SpeakerVerifier {
  preflight(): Promise<void>;
  verify(pcm: Buffer): Promise<VerificationResult>;
  readonly info: string;
}

/** Bytes for a duration at the given PCM format. */
export function pcmByteLength(ms: number, rate = ATLAS_AUDIO.rate): number {
  return Math.max(0, Math.round((ms / 1_000) * rate * ATLAS_AUDIO.width));
}

/** Duration in ms of a PCM buffer. */
export function pcmDurationMs(pcm: Buffer, rate = ATLAS_AUDIO.rate): number {
  return (pcm.length / (rate * ATLAS_AUDIO.width)) * 1_000;
}

/** Resolves the bundled Python bridge regardless of install location. */
export function defaultBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(
    here,
    '..',
    '..',
    'voice-bridge',
    'atlas-speaker-verification.py',
  );
}

/**
 * ECAPA-TDNN over a Wyoming bridge, compared locally in-process.
 *
 * The bridge returns the raw embedding so that scoring, thresholds, and the
 * enrolled voiceprint all stay inside Atlas and never leave the machine.
 */
export class EcapaSpeakerVerifier implements SpeakerVerifier {
  readonly #config: VoiceConfig;
  readonly #voiceprint: Voiceprint;
  #client: WyomingClient | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;

  public constructor(config: VoiceConfig, voiceprint: Voiceprint) {
    this.#config = config;
    this.#voiceprint = voiceprint;
  }

  public get info(): string {
    return `ECAPA-TDNN via Wyoming bridge at ${VOICE_HOST}:${this.#config.ports.speakerVerification}`;
  }

  public async preflight(): Promise<void> {
    // Start the bridge if it is not already listening, then confirm it answers.
    if (this.#child === undefined && !(await this.#probe(1_500))) {
      this.#spawnBridge();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await this.#probe(1_000)) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new VoiceprintError(
        'The speaker-verification bridge did not start. Check that ' +
          '`python3 -c "import speechbrain, torch"` succeeds.',
      );
    }
  }

  async #probe(timeoutMs: number): Promise<boolean> {
    const probe = new WyomingClient({
      host: VOICE_HOST,
      port: this.#config.ports.speakerVerification,
    });
    try {
      await probe.connect(timeoutMs);
      await probe.send({ type: 'describe' });
      const info = await probe.receive();
      return info?.type === 'info';
    } catch {
      return false;
    } finally {
      probe.close();
    }
  }

  #spawnBridge(): void {
    const child = spawn(
      'python3',
      [
        defaultBridgePath(),
        '--uri',
        `tcp://${VOICE_HOST}:${this.#config.ports.speakerVerification}`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Never surface raw stderr, which could contain model paths or frame data.
    child.stderr.resume();
    child.stdout.resume();
    child.once('error', () => {
      this.#child = undefined;
    });
    child.once('exit', () => {
      this.#child = undefined;
    });
    this.#child = child;
  }

  public async verify(pcm: Buffer): Promise<VerificationResult> {
    const audioMs = pcmDurationMs(pcm);
    const threshold = this.#config.speakerThreshold;

    const tooShort: VerificationResult = {
      accepted: false,
      score: 0,
      threshold,
      audioMs,
      reason:
        audioMs < this.#config.minVerificationMs
          ? `Sample too short to verify (${Math.round(audioMs)}ms, need ${this.#config.minVerificationMs}ms).`
          : 'Sample could not be verified.',
    };
    if (audioMs < this.#config.minVerificationMs) return tooShort;

    const maxBytes = pcmByteLength(this.#config.maxVerificationMs);
    const sample =
      pcm.length > maxBytes ? pcm.subarray(pcm.length - maxBytes) : pcm;

    const embedding = await this.#embeddingFor(sample);
    if (embedding === undefined) {
      return {
        accepted: false,
        score: 0,
        threshold,
        audioMs,
        reason: 'The speaker-verification model returned no embedding.',
      };
    }

    const score = cosineSimilarity(embedding, this.#voiceprint.embedding);
    return {
      accepted: score >= threshold,
      score,
      threshold,
      audioMs,
      ...(score >= threshold
        ? {}
        : { reason: 'Speaker does not match the enrolled owner.' }),
    };
  }

  async #embeddingFor(pcm: Buffer): Promise<number[] | undefined> {
    if (this.#client === undefined) {
      this.#client = new WyomingClient({
        host: VOICE_HOST,
        port: this.#config.ports.speakerVerification,
      });
      await this.#client.connect();
    }
    await this.#client.send({ type: 'transcribe' });
    await this.#client.send({ type: 'audio-start' });
    await this.#client.write(audioChunkFrame(pcm));
    await this.#client.send({ type: 'audio-stop' });

    for (let guard = 0; guard < 8; guard += 1) {
      const event = await this.#client.receive();
      if (event === undefined) return undefined;
      if (event.type === 'transcript') {
        const raw = event.data.text;
        try {
          const parsed: unknown = JSON.parse(
            typeof raw === 'string' ? raw : '',
          );
          if (Array.isArray(parsed)) {
            return parsed.filter(
              (value): value is number =>
                typeof value === 'number' && Number.isFinite(value),
            );
          }
        } catch {
          return undefined;
        }
        return undefined;
      }
    }
    return undefined;
  }

  /** Stops a bridge that this instance started. */
  public close(): void {
    this.#client?.close();
    this.#child?.kill('SIGTERM');
    this.#child = undefined;
  }
}

/**
 * A verifier that always rejects, used when no owner is enrolled.
 *
 * Failing closed here is what makes "nobody has enrolled" safe: an unenrolled
 * install cannot be woken by voice at all.
 */
export class UnenrolledSpeakerVerifier implements SpeakerVerifier {
  public readonly info = 'no enrolled owner (voice activation disabled)';

  public async preflight(): Promise<void> {
    // Nothing to check; the pipeline reports the missing enrollment itself.
  }

  public async verify(pcm: Buffer): Promise<VerificationResult> {
    return Promise.resolve({
      accepted: false,
      score: 0,
      threshold: 1,
      audioMs: pcmDurationMs(pcm),
      reason: 'No owner is enrolled.',
    });
  }
}
