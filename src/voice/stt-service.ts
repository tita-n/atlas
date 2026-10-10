/**
 * Local speech-to-text.
 *
 * Backed by rhasspy/wyoming-whisper-cpp. whisper.cpp was chosen over
 * faster-whisper because the reference CPU benchmark had it both faster
 * (2m05s vs 1m42s+int8 at higher RAM) and lighter on memory (1049 MB vs
 * 1477 MB for 13 minutes of audio), and it removes the Python/CTranslate2
 * dependency from the hot path.
 */
import type { VoiceConfig } from '../config/voice-config.js';
import { VOICE_HOST } from '../config/voice-config.js';
import {
  audioChunkFrame,
  WyomingClient,
  type WyomingEvent,
} from './wyoming.js';
import { VoiceprintError } from './voiceprint-store.js';

/** Observable surface used by the pipeline, so tests can supply a double. */
export interface SpeechToText {
  preflight(): Promise<void>;
  transcribe(pcm: Buffer): Promise<string>;
  readonly info: string;
}

/** whisper.cpp over the Wyoming protocol. */
export class WhisperCppService implements SpeechToText {
  readonly #config: VoiceConfig;
  readonly #client: WyomingClient;

  public constructor(config: VoiceConfig) {
    this.#config = config;
    this.#client = new WyomingClient({
      host: VOICE_HOST,
      port: config.ports.speechToText,
    });
  }

  public get info(): string {
    return `whisper.cpp via Wyoming at ${this.#client.endpoint}`;
  }

  public async preflight(): Promise<void> {
    const probe = new WyomingClient({
      host: VOICE_HOST,
      port: this.#config.ports.speechToText,
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
        `The whisper.cpp Wyoming service is not answering at ` +
          `${this.#client.endpoint}. Start it with \`script/run --uri ` +
          `tcp://127.0.0.1:${this.#config.ports.speechToText} --model ` +
          `${this.#config.sttModel}\` inside rhasspy/wyoming-whisper-cpp.`,
        { cause },
      );
    } finally {
      probe.close();
    }
  }

  public async transcribe(pcm: Buffer): Promise<string> {
    if (pcm.length === 0) return '';
    await this.#client.connect();
    await this.#client.send({
      type: 'transcribe',
      data: {
        name: this.#config.sttModel,
        ...(this.#config.sttLanguage === ''
          ? {}
          : { language: this.#config.sttLanguage }),
      },
    });
    await this.#client.send({ type: 'audio-start' });
    await this.#client.write(audioChunkFrame(pcm));
    await this.#client.send({ type: 'audio-stop' });

    // The service may stream partials before the final transcript.
    let text = '';
    for (let guard = 0; guard < 256; guard += 1) {
      const event: WyomingEvent | undefined = await this.#client.receive();
      if (event === undefined) break;
      if (event.type === 'transcript-chunk') {
        const chunk = event.data.text;
        if (typeof chunk === 'string') text += chunk;
        continue;
      }
      if (event.type === 'transcript') {
        const final = event.data.text;
        text = typeof final === 'string' ? final : text;
        break;
      }
      if (event.type === 'transcript-stop') break;
    }

    this.#client.close();
    return text.trim();
  }
}
