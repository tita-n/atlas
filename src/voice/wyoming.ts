/**
 * Wyoming protocol client.
 *
 * Wyoming is a peer-to-peer TCP protocol: a one-line JSON header terminated by
 * `\n`, then optional `data_length` bytes of additional JSON, then optional
 * `payload_length` bytes of binary payload. It is an Open Home Foundation open
 * standard, has no authentication or encryption by design, and is only ever
 * used here over loopback.
 *
 * See https://github.com/OHF-Voice/wyoming for the specification.
 */
import { connect, type Socket } from 'node:net';

import { AtlasError } from '../errors.js';

/** Audio format Atlas uses everywhere in the voice layer. */
export const ATLAS_AUDIO: WyomingAudioFormat = {
  rate: 16_000,
  width: 2,
  channels: 1,
};

/** Raised when a Wyoming peer is unreachable or misbehaves. */
export class WyomingError extends AtlasError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** PCM audio format carried in Wyoming messages. */
export interface WyomingAudioFormat {
  readonly rate: number;
  readonly width: number;
  readonly channels: number;
}

/** A decoded Wyoming frame. */
export interface WyomingEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  /** Present only for events that carry a binary payload, such as audio. */
  readonly payload?: Buffer;
}

interface RawHeader {
  type?: unknown;
  data?: unknown;
  data_length?: unknown;
  payload_length?: unknown;
}

/**
 * A buffered reader over a Wyoming byte stream.
 *
 * A single TCP read can contain a header, its extra JSON, and part of the next
 * frame. The reader therefore keeps a private buffer and consumes from it
 * before pulling more bytes, so a frame split across reads, and a frame
 * delivered in one read, both parse correctly.
 */
export class WyomingReader {
  readonly #stream: AsyncIterator<Buffer>;
  #buffered = Buffer.alloc(0);
  #ended = false;

  public constructor(stream: AsyncIterator<Buffer>) {
    this.#stream = stream;
  }

  /** Consumes exactly `count` bytes, or undefined at a clean end of stream. */
  async #readExactly(count: number): Promise<Buffer | undefined> {
    while (this.#buffered.length < count) {
      if (this.#ended) {
        return this.#buffered.length === 0
          ? undefined
          : this.#buffered.subarray(0, count);
      }
      const next = await this.#stream.next();
      if (next.done === true) {
        this.#ended = true;
        break;
      }
      this.#buffered = Buffer.concat([this.#buffered, next.value]);
    }
    if (this.#buffered.length < count) return undefined;
    const taken = this.#buffered.subarray(0, count);
    this.#buffered = this.#buffered.subarray(count);
    return taken;
  }

  /** Reads one frame, or undefined at end of stream. */
  async read(): Promise<WyomingEvent | undefined> {
    // Find the end of the header line, refilling as needed.
    let newline = this.#buffered.indexOf(0x0a);
    while (newline === -1) {
      if (this.#ended) {
        if (this.#buffered.length === 0) return undefined;
        throw new WyomingError('Wyoming stream ended mid-header.');
      }
      const next = await this.#stream.next();
      if (next.done === true) {
        this.#ended = true;
        if (this.#buffered.length === 0) return undefined;
        throw new WyomingError('Wyoming stream ended mid-header.');
      }
      this.#buffered = Buffer.concat([this.#buffered, next.value]);
      newline = this.#buffered.indexOf(0x0a);
    }

    const line = this.#buffered.subarray(0, newline).toString('utf8');
    this.#buffered = this.#buffered.subarray(newline + 1);

    let header: RawHeader;
    try {
      header = JSON.parse(line) as RawHeader;
    } catch (cause) {
      throw new WyomingError('Wyoming peer sent a malformed JSON header.', {
        cause,
      });
    }
    if (typeof header.type !== 'string' || header.type === '') {
      throw new WyomingError('Wyoming header is missing a "type" field.');
    }

    const dataLength =
      typeof header.data_length === 'number' && header.data_length > 0
        ? header.data_length
        : 0;
    const payloadLength =
      typeof header.payload_length === 'number' && header.payload_length > 0
        ? header.payload_length
        : 0;

    let data: Record<string, unknown> =
      header.data !== null && typeof header.data === 'object'
        ? (header.data as Record<string, unknown>)
        : {};

    if (dataLength > 0) {
      const extra = await this.#readExactly(dataLength);
      if (extra === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(extra.toString('utf8'));
        if (parsed !== null && typeof parsed === 'object') {
          data = { ...data, ...(parsed as Record<string, unknown>) };
        }
      } catch (cause) {
        throw new WyomingError('Wyoming peer sent malformed extra data.', {
          cause,
        });
      }
    }

    if (payloadLength > 0) {
      const payload = await this.#readExactly(payloadLength);
      if (payload === undefined) return undefined;
      return { type: header.type, data, payload };
    }
    return { type: header.type, data };
  }
}

/**
 * Reads a single frame from a fresh stream.
 *
 * For sequential reads, construct a {@link WyomingReader} and reuse it so the
 * buffered position is preserved between frames.
 */
export async function readWyomingEvent(
  stream: AsyncIterator<Buffer>,
): Promise<WyomingEvent | undefined> {
  return new WyomingReader(stream).read();
}

/** Serialises one frame into bytes ready to write to a socket. */
export function encodeWyomingEvent(event: {
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly payload?: Buffer;
}): Buffer {
  const data = event.data ?? {};
  const payload = event.payload;
  const header: Record<string, unknown> = { type: event.type, data };
  if (payload !== undefined && payload.length > 0) {
    header.payload_length = payload.length;
  }
  return Buffer.concat([
    Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'),
    payload ?? Buffer.alloc(0),
  ]);
}

/** Builds an `audio-chunk` frame carrying PCM. */
export function audioChunkFrame(
  pcm: Buffer,
  format: WyomingAudioFormat = ATLAS_AUDIO,
): Buffer {
  return encodeWyomingEvent({
    type: 'audio-chunk',
    data: {
      rate: format.rate,
      width: format.width,
      channels: format.channels,
    },
    payload: pcm,
  });
}

/** A connection to one Wyoming service. */
export class WyomingClient {
  readonly #host: string;
  readonly #port: number;
  #socket: Socket | undefined;
  #reader: WyomingReader | undefined;

  public constructor(options: { host?: string; port: number }) {
    // Loopback only. Wyoming has no authentication, so binding this anywhere
    // reachable would let anyone inject audio and transcripts.
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port;
  }

  /** The resolved TCP endpoint, for diagnostics. */
  public get endpoint(): string {
    return `${this.#host}:${this.#port}`;
  }

  /** Whether a socket is currently open. */
  public get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed;
  }

  /** Opens the TCP connection, rejecting with a clear message on failure. */
  public async connect(timeoutMs = 5_000): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.#host, port: this.#port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new WyomingError(
            `Timed out connecting to Wyoming service at ${this.endpoint}.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      const onError = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(
          new WyomingError(
            `Could not reach Wyoming service at ${this.endpoint}. ` +
              'Is it running? (' +
              error.message +
              ')',
            { cause: error },
          ),
        );
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        // The connection is deliberately long lived, so it must keep an error
        // handler. Removing it means a peer restart raises an uncaught
        // 'error' event and kills the whole CLI.
        socket.on('error', () => {
          this.#socket = undefined;
          this.#reader = undefined;
        });
        // Keep the connection alive across idle periods between turns.
        socket.setNoDelay(true);
        this.#socket = socket;
        this.#reader = new WyomingReader(socket[Symbol.asyncIterator]());
        resolve();
      });
    });
  }

  /** Sends a frame. */
  public async send(event: {
    type: string;
    data?: Record<string, unknown>;
    payload?: Buffer;
  }): Promise<void> {
    if (this.#socket === undefined) {
      throw new WyomingError('Wyoming client is not connected.');
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket?.write(encodeWyomingEvent(event), (error) => {
        if (error === undefined || error === null) resolve();
        else
          reject(
            new WyomingError('Failed to write to Wyoming peer.', {
              cause: error,
            }),
          );
      });
    });
  }

  /** Sends raw bytes, for pre-encoded audio frames. */
  public async write(bytes: Buffer): Promise<void> {
    if (this.#socket === undefined) {
      throw new WyomingError('Wyoming client is not connected.');
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket?.write(bytes, (error) => {
        if (error === undefined || error === null) resolve();
        else
          reject(
            new WyomingError('Failed to write to Wyoming peer.', {
              cause: error,
            }),
          );
      });
    });
  }

  /** Receives the next frame, or undefined when the peer closes. */
  public async receive(): Promise<WyomingEvent | undefined> {
    if (this.#reader === undefined) {
      throw new WyomingError('Wyoming client is not connected.');
    }
    return this.#reader.read();
  }

  /** Closes the connection. */
  public close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#reader = undefined;
  }
}
