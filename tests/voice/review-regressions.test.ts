import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/**
 * Regressions for defects found by review and by adversarial testing. Each one
 * was a real, shipped bug, so the test states the failure mode directly.
 */
describe('the Python Wyoming bridge must actually reply', () => {
  it('awaits every write_event so the client receives a response', () => {
    const source = readFileSync(
      join(root, 'voice-bridge/atlas-speaker-verification.py'),
      'utf8',
    );
    // A coroutine that is called without await is silently discarded, which
    // left the bridge running but never answering.
    const definition = source.indexOf('async def write_event');
    // Count every call site except the definition itself.
    const callSites = [...source.matchAll(/(?<!def )write_event\(/g)].filter(
      (match) => (match.index ?? -1) !== definition,
    );
    const awaited = [...source.matchAll(/await write_event\(/g)];
    expect(callSites.length).toBeGreaterThan(0);
    // A coroutine that is not awaited is silently discarded, which left the
    // bridge running but never answering the client.
    expect(awaited.length).toBe(callSites.length);
  });
});

describe('model archives extract where the sentinel is checked', () => {
  it('extracts into the component directory, not the model root', () => {
    const source = readFileSync(
      join(root, 'src/voice/model-manager.ts'),
      'utf8',
    );
    // Previously `tar ... -C this.#root`, so the sentinel was looked for in a
    // directory the archive never created and every model appeared corrupt.
    // Previously `tar ... -C this.#root`, so the sentinel was looked for in a
    // directory the archive never created and every model appeared corrupt.
    expect(source).toMatch(/'xjf', partial, '-C', target/);
    expect(source).not.toMatch(/'xjf', partial, '-C', this.#root/);
  });
});

describe('the long-lived Wyoming socket keeps an error handler', () => {
  it('does not remove the only error listener after connecting', () => {
    const source = readFileSync(join(root, 'src/voice/wyoming.ts'), 'utf8');
    // A net.Socket with no 'error' listener throws on peer restart and kills
    // the process, so the long-lived connection must keep one.
    expect(source).not.toMatch(/removeListener\('error'/);
  });
});

describe('chunk handling is serialised and failures are contained', () => {
  it('queues audio chunks instead of racing them', () => {
    const source = readFileSync(
      join(root, 'src/voice/voice-pipeline.ts'),
      'utf8',
    );
    // handleChunk awaits native inference, which is slower than the 100ms
    // capture frame, so overlapping calls raced on the pending buffer.
    expect(source).toMatch(/enqueue\(pcm: Buffer\)/);
  });

  it('never calls handleChunk directly from the CLI', () => {
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    expect(source).not.toMatch(/handleChunk\(chunk\.pcm\)/);
  });

  it('makes the final decision before discarding the buffer', () => {
    const source = readFileSync(
      join(root, 'src/voice/voice-pipeline.ts'),
      'utf8',
    );
    // tryVerify reads #pending, so clearing it first silently skipped the
    // final decision on a wake that arrived near the end of the stream.
    const cleared = source.indexOf(
      'this.#pending = Buffer.alloc(0);\n        await this.#tryVerify(undefined);',
    );
    expect(cleared).toBe(-1);
  });
});

describe('a probe must not leak the bridge it started', () => {
  it('closes the verifier it spawns', () => {
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    // probeServices previously built an EcapaSpeakerVerifier inline and never
    // closed it, leaking a Python process holding the model in memory. Only
    // the speaker probe can spawn; wake and speech probes are stateless.
    const speakerProbe = source.slice(
      source.indexOf('speaker   tcp://'),
      source.indexOf('speech    tcp://'),
    );
    expect(speakerProbe).toMatch(/probe\.close\(\)/);
    expect(speakerProbe).not.toMatch(
      /PLACEHOLDER_VOICEPRINT,\s*\)\s*\.preflight\(\)/,
    );
  });
});

describe('the long-running voice commands tear down on Ctrl+C', () => {
  it('stops the capture and pipeline, then exits explicitly', () => {
    // Registering a SIGINT handler suppresses Node's default exit, so without
    // an explicit process.exit() the microphone child keeps the event loop
    // alive and Ctrl+C leaves the process hung.
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    const longRunning = source
      .slice(source.indexOf('runVoiceTestWake'))
      .concat(source.slice(source.indexOf('runVoiceListen')));
    expect(longRunning).toMatch(/process\.exit\(process\.exitCode \?\? 0\)/);
  });

  it('reports a dead microphone instead of failing silently', () => {
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    // A silent capture and a failed wake look identical otherwise.
    expect(source).toMatch(/No audio reached Atlas/);
    expect(source).toMatch(/Audio reached Atlas/);
  });

  it('distinguishes a broken input device from a quiet room', () => {
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    // A large DC bias or rail clipping looks like constant loud speech, so
    // without this the meter reports SPEECH on a broken device and sends the
    // user hunting for a wake-word bug that does not exist.
    expect(source).toMatch(/offset \$\{offset\.toFixed\(0\)\}/);
    expect(source).toMatch(/not delivering audio/);
    expect(source).toMatch(/clipped/);
  });

  it('announces a wake detection immediately', () => {
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    // Previously only a completed verification was reported, so a wake that
    // fired without enough following audio produced no output at all.
    expect(source).toMatch(/WAKE DETECTED/);
  });
});

describe('captured audio is conditioned before it reaches the model', () => {
  it('removes DC offset from the microphone stream', () => {
    // Measured on this machine: the capture path carries a constant bias of
    // about -0.28 of full scale. Left in, the energy gate reads constant
    // "speech" and a keyword spotter can never match.
    const source = readFileSync(
      join(root, 'src/voice/audio-capture.ts'),
      'utf8',
    );
    expect(source).toMatch(/class DcBlocker/);
    expect(source).toMatch(/processBuffer/);
  });

  it('applies the blocker in the capture loop, not only in a helper', () => {
    const source = readFileSync(
      join(root, 'src/voice/audio-capture.ts'),
      'utf8',
    );
    expect(source).toMatch(/processBuffer\(data\)/);
  });
});

describe('wake detection listeners', () => {
  it('supports more than one subscriber', () => {
    const source = readFileSync(
      join(root, 'src/voice/backends/sherpa-onnx/wake-word.ts'),
      'utf8',
    );
    // A single-slot callback meant the pipeline, which re-registers on every
    // chunk, silently unregistered the CLI's announcement, so a working
    // detection printed nothing at all.
    expect(source).toMatch(/#callbacks\.add\(/);
    expect(source).not.toMatch(/this\.#callback = callback/);
  });

  it('shows the detected keyword when sherpa reports no score', () => {
    const source = readFileSync(join(root, 'src/voice/cli.ts'), 'utf8');
    // `wake=-` on every line hid the fact that detection was working.
    expect(source).toMatch(/lastKeyword/);
    expect(source).toMatch(/WAKE DETECTED/);
  });
});
