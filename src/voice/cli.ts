/**
 * CLI implementation for the Phase 3 voice commands.
 *
 * Kept out of cli.ts so the REPL wiring there stays readable. These functions
 * are the only place that talks to the voice layer for user-facing output.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { loadVoiceConfig, type VoiceConfig } from '../config/voice-config.js';
import { openDatabase } from '../memory/database.js';
import { VoiceCorrectionsRepository } from '../memory/voice-corrections-repository.js';
import { AtlasError } from '../errors.js';
import {
  MicrophoneCapture,
  rmsEnergy,
  UtteranceSegmenter,
} from './audio-capture.js';
import {
  ENROLLMENT_PHRASES,
  EnrollmentSession,
  MAX_SAMPLE_MS,
  MIN_ENROLLMENT_MS,
  trimSample,
} from './enrollment.js';
import {
  EcapaSpeakerVerifier,
  UnenrolledSpeakerVerifier,
} from './speaker-verification.js';
import { WhisperCppService } from './stt-service.js';
import {
  VoiceprintStore,
  type Voiceprint as StoredVoiceprint,
} from './voiceprint-store.js';
import {
  createVoiceBackend,
  defaultModelDirectory,
  resolveVoiceBackend,
} from './backend-factory.js';
import { ModelManager, resolveModelProfile } from './model-manager.js';
import type {
  AudioSamples,
  SpeakerVerifier as SpeakerVerifierBackend,
  Voiceprint,
} from './backend.js';
import { VoicePipeline } from './voice-pipeline.js';
import { OpenWakeWordService } from './wake-word-service.js';
import { ATLAS_AUDIO } from './wyoming.js';

function fail(error: unknown): void {
  if (error instanceof AtlasError) {
    console.error(`Error: ${error.message}`);
    return;
  }
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function voiceStore(config: VoiceConfig): VoiceprintStore {
  return new VoiceprintStore(config.dataDirectory);
}

const PLACEHOLDER_VOICEPRINT: StoredVoiceprint = {
  version: 1,
  embedding: [0],
  enrolledMs: 0,
  sampleMs: [],
  enrolledAt: '',
  model: 'placeholder',
};

/** Reports which local services are up, without failing the command. */
/**
 * Reports whether the active backend's components are ready.
 *
 * This must follow the configured backend: sherpa-onnx runs in-process with no
 * ports at all, so probing Wyoming sockets under the default backend reported
 * every component "down" and even tried to start the Python bridge.
 */
async function probeServices(
  config: VoiceConfig,
  backendName: 'sherpa-onnx' | 'wyoming',
): Promise<boolean> {
  if (backendName === 'sherpa-onnx') {
    console.log(
      'Checking local voice models (sherpa-onnx, no services needed):',
    );
    const models = new ModelManager(
      defaultModelDirectory(),
      resolveModelProfile(),
    );
    const checks: [string, () => Promise<string>][] = [
      ['wake word  ', async () => await models.ensure('wake')],
      ['speech     ', async () => await models.ensure('speech')],
      ['speaker    ', async () => await models.ensure('speaker')],
    ];
    let allReady = true;
    for (const [label, check] of checks) {
      try {
        const directory = await check();
        console.log(`  ok    ${label} ${directory}`);
      } catch (error) {
        allReady = false;
        console.log(`  down  ${label}`);
        if (error instanceof AtlasError)
          console.log(`        ${error.message}`);
      }
    }
    return allReady;
  }

  console.log('Checking local Wyoming services (all must be on 127.0.0.1):');
  const checks: [string, () => Promise<void>][] = [
    [
      `wake word  tcp://127.0.0.1:${config.ports.wakeWord}`,
      async () => {
        await new OpenWakeWordService(config).preflight();
      },
    ],
    [
      `speaker   tcp://127.0.0.1:${config.ports.speakerVerification}`,
      async () => {
        // preflight can spawn the Python bridge; it must be torn down again
        // or a "check the service" helper leaks a model-loading process.
        const probe = new EcapaSpeakerVerifier(config, PLACEHOLDER_VOICEPRINT);
        try {
          await probe.preflight();
        } finally {
          probe.close();
        }
      },
    ],
    [
      `speech    tcp://127.0.0.1:${config.ports.speechToText}`,
      async () => {
        await new WhisperCppService(config).preflight();
      },
    ],
  ];
  let allReady = true;
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`  ok    ${label}`);
    } catch (error) {
      allReady = false;
      console.log(`  down  ${label}`);
      if (error instanceof AtlasError) console.log(`        ${error.message}`);
    }
  }
  return allReady;
}

/**
 * Records one utterance while the user speaks it.
 *
 * Recording starts before the prompt is shown and stops when the user presses
 * Enter, so the speech they are already making is what gets captured. Waiting
 * for Enter *before* recording (the previous behaviour) always discarded the
 * utterance and reported "no audio captured".
 */
async function captureUtterance(prompt: string): Promise<Buffer | undefined> {
  const config = loadVoiceConfig();
  const chunks: Buffer[] = [];
  const capture = new MicrophoneCapture(
    {
      backend: config.audioBackend,
      device: config.audioDevice,
      rate: config.sampleRate,
    },
    (chunk) => {
      chunks.push(chunk.pcm);
    },
  );

  // Start recording first; anything spoken from this moment on is captured.
  await capture.start();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      `${prompt}\nRecording now — speak the phrase, then press Enter: `,
    );
    await new Promise<void>((resolve) => {
      rl.question('', () => {
        resolve();
      });
    });
  } finally {
    rl.close();
  }

  // Let the tail of the utterance land, then stop.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await capture.stop();

  const pcm = Buffer.concat(chunks);
  if (pcm.length < config.sampleRate * ATLAS_AUDIO.width * 0.2) {
    throw new Error(
      'No audio was captured from the microphone. Check that the right input ' +
        'device is selected (set ATLAS_VOICE_AUDIO_DEVICE), then try again.',
    );
  }

  // Trim leading/trailing silence so the embedding sees the speech itself.
  const segmenter = new UtteranceSegmenter(config.vad, config.sampleRate);
  const frameSamples = Math.round(config.sampleRate * 0.1);
  const frameBytes = frameSamples * ATLAS_AUDIO.width;
  let utterance: { pcm: Buffer; audioMs: number } | undefined;
  for (
    let offset = 0;
    offset + frameBytes <= pcm.length;
    offset += frameBytes
  ) {
    const done = segmenter.push(pcm.subarray(offset, offset + frameBytes));
    if (done !== undefined) {
      utterance = done;
      break;
    }
  }

  // VAD closes an utterance on trailing silence. If the user stopped speaking
  // and then pressed Enter, the hangover may not have elapsed, so fall back to
  // the captured audio with the silence trimmed rather than losing the sample.
  utterance ??= {
    pcm: trimSilence(pcm, config),
    audioMs: (pcm.length / (config.sampleRate * ATLAS_AUDIO.width)) * 1000,
  };
  return utterance.pcm;
}

/** Trims leading and trailing silence using the same energy gate as the VAD. */
function trimSilence(
  pcm: Buffer,
  config: ReturnType<typeof loadVoiceConfig>,
): Buffer {
  const frameSamples = Math.round(config.sampleRate * 0.05);
  const frameBytes = frameSamples * ATLAS_AUDIO.width;
  const isLoud = (frame: Buffer): boolean =>
    rmsEnergy(frame) > config.vad.silenceThreshold;

  let start = 0;
  while (
    start + frameBytes <= pcm.length &&
    !isLoud(pcm.subarray(start, start + frameBytes))
  ) {
    start += frameBytes;
  }
  let end = pcm.length - (pcm.length % frameBytes);
  while (
    end - frameBytes >= start &&
    !isLoud(pcm.subarray(end - frameBytes, end))
  ) {
    end -= frameBytes;
  }
  if (end <= start) return pcm;
  return pcm.subarray(start, end);
}

/**
 * A live microphone level meter for the diagnostic command.
 *
 * Without it, "nothing happened" cannot be told apart between a dead
 * microphone, speech that never reaches the model, and a wake phrase that
 * fired but could not be verified.
 */
function createInputMeter(): {
  push(pcm: Buffer): void;
  stop(): void;
  reportPeak(): number;
  reportOffset(): number;
  reportClipRatio(): number;
} {
  const BARS = 24;
  let peak = 0;
  let runningPeak = 0;
  let voiced = false;
  let lastLine = '';
  let sum = 0;
  let count = 0;
  let rails = 0;

  const render = (): void => {
    const filled = Math.min(BARS, Math.round(peak * BARS * 3));
    const bar = `${'#'.repeat(filled)}${'.'.repeat(BARS - filled)}`;
    const suffix = voiced ? 'SPEECH' : 'quiet';
    const line = `  mic ${bar} peak=${peak.toFixed(3)} ${suffix}`;
    if (line === lastLine) return;
    lastLine = line;
    if (process.stdout.isTTY) {
      // Redraw in place so the transcript stays readable.
      process.stdout.write(`\r${line}`);
    } else {
      // When piped there is no cursor to redraw, so emit a line per change.
      console.log(line);
    }
  };

  const timer = setInterval(render, 100);
  timer.unref?.();

  return {
    push(pcm: Buffer): void {
      const energy = rmsEnergy(pcm);
      runningPeak = Math.max(runningPeak, energy);
      // Slow decay so a short syllable stays visible between frames.
      peak = Math.max(energy, peak * 0.85);
      if (energy > 0.02) voiced = true;
      else if (energy < 0.005) voiced = false;
      // Track offset and clipping: a broken input device produces a large DC
      // bias pinned at the rails, which would otherwise look like constant
      // speech and send the user hunting for a wake-word bug.
      const samples = Math.floor(pcm.length / 2);
      for (let index = 0; index < samples; index += 1) {
        const value = pcm.readInt16LE(index * 2);
        sum += value;
        count += 1;
        if (value <= -32_700 || value >= 32_700) rails += 1;
      }
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      if (process.stdout.isTTY && lastLine !== '') {
        process.stdout.write(`\r${' '.repeat(lastLine.length)}\r`);
      }
    },
    reportPeak(): number {
      return runningPeak;
    },
    /** A large DC bias means the input is not delivering real audio. */
    reportOffset(): number {
      return count === 0 ? 0 : sum / count;
    },
    reportClipRatio(): number {
      return count === 0 ? 0 : rails / count;
    },
  };
}

/**
 * `atlas voice setup-models`: disclose sizes, then fetch and cache models.
 *
 * Size disclosure happens before any bytes move, because a silent
 * multi-hundred-megabyte download is exactly the problem this exists to avoid.
 */
export async function runVoiceSetupModels(options: {
  readonly backend?: string;
  readonly yes?: boolean;
  readonly modelsDirectory?: string;
  readonly confirm?: ((message: string) => Promise<boolean>) | undefined;
}): Promise<void> {
  const backend = resolveVoiceBackend(options.backend);
  if (backend === 'wyoming') {
    console.log(
      'The wyoming backend downloads no Atlas-managed models. It uses the\n' +
        'services you start yourself:\n' +
        '  rhasspy/wyoming-openwakeword   (wake word)\n' +
        '  rhasspy/wyoming-whisper-cpp    (speech to text)\n' +
        '  voice-bridge/atlas-speaker-verification.py  (speaker verification)\n' +
        'Those models are managed by the upstream projects, not by Atlas.',
    );
    return;
  }

  const models = new ModelManager(
    options.modelsDirectory ?? defaultModelDirectory(),
    resolveModelProfile(),
    (message) => {
      console.log(message);
    },
  );

  if (await models.isComplete()) {
    console.log('All voice models are already cached. Nothing to download.');
    console.log(
      `Cached under ${options.modelsDirectory ?? defaultModelDirectory()}`,
    );
    return;
  }

  console.log(models.describe());
  if (options.yes !== true) {
    const ask =
      options.confirm ??
      (async (message: string): Promise<boolean> => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const answer = await new Promise<string>((resolve) => {
            rl.question(`${message} [y/N] `, (value: string) => {
              resolve(value);
            });
          });
          return /^y(es)?$/i.test(answer.trim());
        } finally {
          rl.close();
        }
      });
    const proceed = await ask('Download these models now?');
    if (!proceed) {
      console.log('Cancelled. No models were downloaded.');
      return;
    }
  }

  await models.ensureAll();
  console.log('\nVoice models are ready. Run "atlas voice enroll" next.');
}

/**
 * The model identity a verifier will compare against.
 *
 * Backends that resolve a model file expose `modelId`; the rest are identified
 * by their name, which is still distinct per backend.
 */
function modelIdOf(verifier: SpeakerVerifierBackend): string {
  const withModel = verifier as { modelId?: string };
  return withModel.modelId ?? verifier.name;
}

/** `atlas voice enroll` */
export async function runVoiceEnroll(options: {
  readonly redo: boolean;
  readonly backend?: string;
  readonly capture?:
    ((prompt: string) => Promise<Buffer | undefined>) | undefined;
  readonly embed?:
    ((samples: readonly AudioSamples[]) => Promise<number[]>) | undefined;
}): Promise<void> {
  const config = loadVoiceConfig();
  const store = voiceStore(config);

  if (!options.redo && (await store.exists())) {
    console.log(
      'An owner is already enrolled. Re-run with --redo to replace the voiceprint.',
    );
    process.exitCode = 1;
    return;
  }

  const capture = options.capture ?? captureUtterance;

  // Enrollment must use whichever backend is active, otherwise the default
  // sherpa-onnx path would still try to reach the Python Wyoming bridge.
  const backendName = resolveVoiceBackend(options.backend);
  const created = await createVoiceBackend({
    backend: backendName,
    sampleRate: config.sampleRate,
    speakerThreshold: config.speakerThreshold,
    wakeModelPath: config.wakeModelPath,
    wakeVerifierPath: config.wakeVerifierPath,
    wakePhrase: config.wakePhrase,
    speakerCheck: config.speakerCheck,
    ports: config.ports,
  });
  const verifier: SpeakerVerifierBackend = created.speakerVerification;
  console.log(`Enrolling with the ${verifier.name} backend.`);

  const embed =
    options.embed ??
    (async (samples: readonly AudioSamples[]): Promise<number[]> => {
      // Each recorded phrase is embedded separately so the backend can build
      // an averaged voiceprint; one concatenated buffer scores far worse.
      const voiceprint = await verifier.enroll(samples);
      return [...voiceprint.embedding];
    });
  const session = new EnrollmentSession(config, store, embed, {
    backend: verifier.name,
    model: modelIdOf(verifier),
  });

  console.log(
    'Speak the following phrases. Short-duration voice verification degrades ' +
      'below ~3 seconds, so these are full sentences rather than the wake word.',
  );
  console.log(
    `At least ${MIN_ENROLLMENT_MS / 1000}s of speech is required in total.\n`,
  );

  for (let index = 0; index < ENROLLMENT_PHRASES.length; index += 1) {
    const phrase = ENROLLMENT_PHRASES[index] ?? '';
    const pcm = await capture(
      `[${index + 1}/${ENROLLMENT_PHRASES.length}] "${phrase}" — press Enter when done: `,
    );
    if (pcm === undefined) {
      console.log('No audio captured; aborting enrollment.');
      return;
    }
    const trimmed = trimSample(pcm, MAX_SAMPLE_MS, config.sampleRate);
    const ms =
      (trimmed.length / (config.sampleRate * ATLAS_AUDIO.width)) * 1_000;
    session.addSample(trimmed);
    console.log(`  captured ${(ms / 1000).toFixed(1)}s`);
  }

  let result: Awaited<ReturnType<EnrollmentSession['finalize']>>;
  try {
    result = await session.finalize();
  } catch (error) {
    fail(error);
    return;
  }
  if (!result.ok || result.voiceprint === undefined) {
    console.log(result.message);
    return;
  }
  console.log(
    `\nEnrolled ${result.sampleMs.length} samples, ` +
      `${(result.totalMs / 1000).toFixed(1)}s of speech.`,
  );
  console.log(`Voiceprint stored at ${store.path} (owner-readable only).`);
  verifier.dispose();
}

/**
 * Binds a stored voiceprint to a backend verifier.
 *
 * A voiceprint is only meaningful for the backend that produced it: the
 * Wyoming (SpeechBrain) and sherpa-onnx embedding spaces are unrelated. If an
 * enrolled voiceprint belongs to a different backend than the one now active,
 * this refuses rather than comparing incompatible vectors.
 */
function adaptVerifier(
  verifier: SpeakerVerifierBackend,
  stored: StoredVoiceprint,
  config: ReturnType<typeof loadVoiceConfig>,
): SpeakerVerifierBackend {
  const voiceprint: Voiceprint = {
    backend: stored.backend ?? 'wyoming-ecapa-tdnn',
    model: stored.model,
    embedding: stored.embedding,
    enrolledMs: stored.enrolledMs,
    sampleMs: stored.sampleMs,
    enrolledAt: stored.enrolledAt,
  };
  return {
    name: verifier.name,
    preflight: (): Promise<void> => verifier.preflight(),
    enroll: (samples: readonly AudioSamples[]) => verifier.enroll(samples),
    verify: (audio: AudioSamples) => {
      if (voiceprint.backend !== verifier.name) {
        return Promise.resolve({
          accepted: false,
          score: 0,
          threshold: config.speakerThreshold,
          audioMs: (audio.samples.length / audio.sampleRate) * 1000,
          reason:
            `This voiceprint was created by "${voiceprint.backend}" but the ` +
            `active backend is "${verifier.name}". Re-run "atlas voice enroll --redo".`,
        });
      }
      return verifier.verify(audio, voiceprint);
    },
    dispose: (): void => {
      verifier.dispose();
    },
  };
}

/** `atlas voice test-wake` */
export async function runVoiceTestWake(
  options: {
    readonly backend?: string;
    /** Test the exact keyword lines in this file instead of the generated ones. */
    readonly keywords?: string;
  } = {},
): Promise<void> {
  const config = loadVoiceConfig();
  // Validate the backend first: a typo must be reported even when the command
  // would otherwise exit early on the enrollment guard.
  resolveVoiceBackend(options.backend);
  const store = voiceStore(config);
  const voiceprint = await store.load();
  if (voiceprint === undefined) {
    console.log(
      'No owner is enrolled, so speaker verification cannot score anything.\n' +
        'Run "atlas voice enroll" first.',
    );
    process.exitCode = 1;
    return;
  }

  const backendName = resolveVoiceBackend(options.backend);
  const ready = await probeServices(config, backendName);
  if (!ready) {
    console.log(
      '\nThe voice backend is not ready, so detection would never work.\n' +
        'Fix the items above, or run "atlas voice setup-models".',
    );
    process.exitCode = 1;
    return;
  }

  // An explicit keyword file is a one-off diagnostic: those exact lines are
  // used for this run and the generated keyword file is left untouched.
  let keywordLines: string[] | undefined;
  if (options.keywords !== undefined) {
    const text = await readFile(options.keywords, 'utf8');
    keywordLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (keywordLines.length === 0) {
      console.log(`${options.keywords} contains no keyword lines.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Using ${keywordLines.length} keyword line(s) from ${options.keywords} ` +
        'for this run only; the generated keyword file is unchanged.',
    );
  }

  const backend = await createVoiceBackend({
    backend: backendName,
    sampleRate: config.sampleRate,
    speakerThreshold: config.speakerThreshold,
    wakeThreshold: config.wakeThreshold,
    sttModel: config.sttModel,
    wakeModelPath: config.wakeModelPath,
    wakeVerifierPath: config.wakeVerifierPath,
    wakePhrase: config.wakePhrase,
    speakerCheck: config.speakerCheck,
    ports: config.ports,
    ...(keywordLines === undefined ? {} : { keywordLines }),
  });
  const verifier = adaptVerifier(
    backend.speakerVerification,
    voiceprint,
    config,
  );
  const pipeline = new VoicePipeline({
    config,
    detector: backend.wakeWord,
    verifier,
    stt: backend.speechToText,
    onTranscript: (text) => {
      console.log(`  (transcript: ${text})`);
      return Promise.resolve();
    },
    onReport: (report) => {
      // sherpa does not expose a confidence for keyword spotting, so the
      // detected keyword is shown instead of an always-dash score.
      const wake =
        lastKeyword === undefined ? '-' : lastKeyword.replace(/^[▁\s]+/, '');
      const speaker =
        report.speakerScore === undefined
          ? '-'
          : report.speakerScore.toFixed(3);
      console.log(
        `[${new Date(report.at).toISOString().slice(11, 19)}] ` +
          `wake=${wake} speaker=${speaker} accepted=${report.accepted}` +
          (report.reason === undefined ? '' : ` (${report.reason})`),
      );
    },
  });

  const meter = createInputMeter();
  const capture = new MicrophoneCapture(
    {
      backend: config.audioBackend,
      device: config.audioDevice,
      rate: config.sampleRate,
    },
    (chunk) => {
      meter.push(chunk.pcm);
      void pipeline.enqueue(chunk.pcm);
    },
  );

  // Announce a detection the moment it happens. Previously only a completed
  // verification was reported, so a wake that fired without enough following
  // audio produced no output at all.
  let lastKeyword: string | undefined;
  backend.wakeWord.onDetection((event) => {
    meter.stop();
    console.log(
      `\n[${new Date().toISOString().slice(11, 19)}] WAKE DETECTED: "${event.keyword}"` +
        ' - collecting speech to verify the speaker...',
    );
  });

  console.log(
    `Listening for "${config.wakePhrase}" (wake >= ${config.wakeThreshold}, ` +
      `speaker check: ${config.speakerCheck}).\n` +
      'The mic meter below proves audio is reaching Atlas. Ctrl+C to stop.',
  );
  try {
    await pipeline.start();
    await capture.start();
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        resolve();
      });
    });
  } finally {
    // Close sockets explicitly, otherwise the Wyoming TCP handle keeps the
    // event loop alive and the CLI never exits.
    meter.stop();
    const heard = meter.reportPeak();
    const offset = meter.reportOffset();
    const clipped = meter.reportClipRatio();
    if (Math.abs(offset) > 2_000 || clipped > 0.01) {
      // A large DC bias, or samples pinned at the rails, is not audio. It
      // looks like constant loud speech, so no wake word could ever match.
      console.log(
        `\nThe input device is not delivering audio ` +
          `(offset ${offset.toFixed(0)}, ${(clipped * 100).toFixed(1)}% clipped).\n` +
          'This is a hardware or driver problem, not a wake-word problem:\n' +
          '  - pick a different source: pactl list short sources\n' +
          '  - then set ATLAS_VOICE_AUDIO_DEVICE to that exact name\n' +
          '  - if a USB mic or headset is used, check it is plugged in and ' +
          'not hardware-muted',
      );
    } else if (heard < 0.01) {
      console.log(
        '\nNo audio reached Atlas (peak level ~0). The MICROPHONE is the ' +
          'problem, not the wake word. Set ATLAS_VOICE_AUDIO_DEVICE to your ' +
          'input, or set ATLAS_VOICE_AUDIO_BACKEND=arecord.',
      );
    } else {
      console.log(
        `\nAudio reached Atlas (peak ${heard.toFixed(3)}).` +
          (heard < 0.02
            ? ' Levels are very low; check your input gain.'
            : ' If no wake was detected, the wake phrase itself is not matching.'),
      );
    }
    await capture.stop();
    await pipeline.stop();
    verifier.dispose();
    // The microphone child is a live handle; without an explicit exit Ctrl+C
    // leaves the process hanging instead of returning to the shell.
    process.exit(process.exitCode ?? 0);
  }
}

/** `atlas voice listen` */
export async function runVoiceListen(
  options: {
    readonly backend?: string;
  } = {},
): Promise<void> {
  const config = loadVoiceConfig();
  // Validate the backend first: a typo must be reported even when the
  // enrollment guard would otherwise exit early.
  const backendName = resolveVoiceBackend(options.backend);
  const store = voiceStore(config);
  const voiceprint = await store.load();
  if (voiceprint === undefined) {
    console.log(
      'No owner is enrolled, so voice activation is disabled.\n' +
        'Run "atlas voice enroll" first.',
    );
    process.exitCode = 1;
    return;
  }

  const database = openDatabase();
  try {
    const { ConversationRepository } =
      await import('../memory/conversation-repository.js');
    const { Conversation } = await import('../conversation/conversation.js');
    const { createProvider } = await import('../providers/provider-factory.js');
    const { FactsRepository } = await import('../memory/facts-repository.js');
    const { buildSystemPrompt } = await import('../memory/context-builder.js');
    const { loadConfig } = await import('../config/config.js');

    const runtimeConfig = await loadConfig();
    const provider = createProvider(runtimeConfig);
    const facts = new FactsRepository(database);
    const conversation = new Conversation({
      model: runtimeConfig.model,
      ...(runtimeConfig.maxTokens === undefined
        ? {}
        : { maxTokens: runtimeConfig.maxTokens }),
      ...(runtimeConfig.temperature === undefined
        ? {}
        : { temperature: runtimeConfig.temperature }),
      conversationRepository: new ConversationRepository(database),
      buildSystemPrompt: () => buildSystemPrompt(facts.getAllFacts()),
    });

    const corrections = new VoiceCorrectionsRepository(database);
    const backend = await createVoiceBackend({
      backend: resolveVoiceBackend(options.backend),
      sampleRate: config.sampleRate,
      speakerThreshold: config.speakerThreshold,
      wakeThreshold: config.wakeThreshold,
      sttModel: config.sttModel,
      wakeModelPath: config.wakeModelPath,
      wakeVerifierPath: config.wakeVerifierPath,
      ports: config.ports,
    });
    const verifier = adaptVerifier(
      backend.speakerVerification,
      voiceprint,
      config,
    );
    const pipeline = new VoicePipeline({
      config,
      detector: backend.wakeWord,
      verifier,
      stt: backend.speechToText,
      // Command audio is written here so the corrections log can point at the
      // clip instead of storing nothing.
      audioDirectory: config.audioDirectory,
      conversationId: conversation.id,
      corrections: {
        recordHeard: (input) =>
          Promise.resolve(
            corrections.create({
              heardTranscript: input.heardTranscript,
              audioReference: input.audioReference,
              conversationId: conversation.id ?? null,
            }),
          ),
        recordCorrection: (corrected) => {
          const latest = corrections.latestUncorrected();
          if (latest === undefined) return Promise.resolve(undefined);
          const updated = corrections.correct(latest.id, corrected);
          return Promise.resolve(updated ? latest.id : undefined);
        },
      },
      // Voice text goes into the same Phase 0-2 conversation object that
      // `atlas chat` uses; there is no separate voice conversation path.
      onTranscript: async (text) => {
        const response = await conversation.send(provider, text);
        console.log(`\natlas: ${response.content}\n`);
      },
    });

    if (!(await probeServices(config, backendName))) {
      console.log(
        '\nThe voice backend is not ready, so listening would never work.\n' +
          'Fix the items above, or run "atlas voice setup-models".',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      'Voice listening is active. Say "Hey Atlas" followed by a command.\n' +
        'Only your enrolled voice will wake Atlas. Ctrl+C to stop.',
    );
    const capture = new MicrophoneCapture(
      {
        backend: config.audioBackend,
        device: config.audioDevice,
        rate: config.sampleRate,
      },
      (chunk) => {
        // Queued and error-handled: a dropped frame must not race, and a
        // model failure must not become an unhandled rejection.
        void pipeline.enqueue(chunk.pcm);
      },
    );
    try {
      await pipeline.start();
      await capture.start();
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => {
          resolve();
        });
      });
    } finally {
      await capture.stop();
      await pipeline.stop();
      verifier.dispose();
      // The microphone child is a live handle; without an explicit exit
      // Ctrl+C leaves the process hanging instead of returning to the shell.
      process.exit(process.exitCode ?? 0);
    }
  } finally {
    database.close();
  }
}

/** `atlas voice corrections` */
export function runVoiceCorrections(limit: number): void {
  const database = openDatabase();
  try {
    const corrections = new VoiceCorrectionsRepository(database);
    const entries = corrections.list(limit);
    if (entries.length === 0) {
      console.log('No voice corrections logged yet.');
      return;
    }
    console.log(
      `${corrections.count()} logged in total, ` +
        `${corrections.correctedCount()} corrected. ` +
        `Showing the ${entries.length} most recent:`,
    );
    for (const entry of entries) {
      const corrected =
        entry.correctedTranscript === null
          ? ''
          : `\n      corrected: ${entry.correctedTranscript}`;
      console.log(
        `#${entry.id} ${entry.timestamp}\n` +
          `      heard: ${entry.heardTranscript}${corrected}` +
          (entry.conversationId === null
            ? ''
            : `\n      chat: ${entry.conversationId}`),
      );
    }
  } finally {
    database.close();
  }
}

export { UnenrolledSpeakerVerifier };
