import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { CliInputError } from '../errors.js';

/**
 * How a dangerous (Tier 2) command is confirmed while voice is paused.
 *
 * The original design requires the safe word paired with verified voice. With
 * voice work paused that pairing cannot be produced, so the interim mode below
 * accepts the typed safe word alone and says so out loud. `block` refuses
 * dangerous commands outright until voice returns.
 */
export type TextConfirmMode = 'safe-word' | 'block';

export interface AssistantConfig {
  /** Directory holding the Atlas config, database, and personality file. */
  readonly homeDirectory: string;
  /** Maximum memories injected per turn. */
  readonly memoryLimit: number;
  /** Score a memory must reach to be injected. */
  readonly memoryMinScore: number;
  /** Half-life in days for the recency term of retrieval. */
  readonly memoryHalfLifeDays: number;
  /** Recent messages replayed as conversation history. */
  readonly historyLimit: number;
  /** Maximum provider/tool round trips for one user message. */
  readonly maxToolIterations: number;
  /** Whether to show the separated execution detail block. */
  readonly showExecutionDetail: boolean;
  /** Interim text-mode confirmation policy for dangerous commands. */
  readonly textConfirmMode: TextConfirmMode;
  /** Whether the one-time voice-downgrade notice has been shown. */
  readonly showTextConfirmNotice: boolean;

  /**
   * Complexity above which Atlas adds a brief planning beat.
   *
   * Shared with the fidelity check so "when do we add ceremony" is one
   * decision rather than two that drift apart.
   */
  readonly complexityThreshold: number;

  /**
   * Whether completion claims are checked against what actually happened.
   *
   * On by default. Turning it off removes the only guard against reporting
   * work that was never done.
   */
  readonly verifyCompletionClaims: boolean;
}

const DEFAULTS = {
  memoryLimit: 8,
  memoryMinScore: 1,
  memoryHalfLifeDays: 14,
  historyLimit: 30,
  maxToolIterations: 8,
  showExecutionDetail: true,
  complexityThreshold: 3,
} as const;

/** File that records the one-time text-mode downgrade notice. */
export function textConfirmNoticePath(home: string): string {
  return join(home, 'text-confirm-notice-shown');
}

function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export interface AssistantConfigOverrides {
  readonly homeDirectory?: string | undefined;
  readonly memoryLimit?: number | undefined;
  readonly showExecutionDetail?: boolean | undefined;
  readonly textConfirmMode?: TextConfirmMode | undefined;
  readonly complexityThreshold?: number | undefined;
  readonly verifyCompletionClaims?: boolean | undefined;
}

/** Builds the assistant configuration, layering overrides over environment. */
export function loadAssistantConfig(
  overrides: AssistantConfigOverrides = {},
  environment: NodeJS.ProcessEnv = process.env,
): AssistantConfig {
  const home =
    overrides.homeDirectory ??
    environment.ATLAS_HOME ??
    join(homedir(), '.atlas');
  const expanded = isAbsolute(home) ? home : resolve(home);

  const rawMode =
    overrides.textConfirmMode ??
    environment.ATLAS_TEXT_CONFIRM_MODE ??
    'safe-word';
  if (rawMode !== 'safe-word' && rawMode !== 'block') {
    throw new CliInputError(
      'ATLAS_TEXT_CONFIRM_MODE must be safe-word or block.',
    );
  }

  const limitRaw = environment.ATLAS_MEMORY_LIMIT;
  const parsedLimit = limitRaw === undefined ? Number.NaN : Number(limitRaw);

  return {
    homeDirectory: expanded,
    memoryLimit:
      overrides.memoryLimit ??
      (Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.floor(parsedLimit)
        : DEFAULTS.memoryLimit),
    memoryMinScore: DEFAULTS.memoryMinScore,
    memoryHalfLifeDays: DEFAULTS.memoryHalfLifeDays,
    historyLimit: DEFAULTS.historyLimit,
    maxToolIterations: DEFAULTS.maxToolIterations,
    showExecutionDetail:
      overrides.showExecutionDetail ??
      boolEnv(
        environment.ATLAS_SHOW_EXECUTION_DETAIL,
        DEFAULTS.showExecutionDetail,
      ),
    textConfirmMode: rawMode,
    showTextConfirmNotice: true,
    complexityThreshold:
      overrides.complexityThreshold ?? DEFAULTS.complexityThreshold,
    // On by default: this is the guard against reporting unfinished work as
    // finished, so it is opt-out rather than opt-in.
    verifyCompletionClaims: overrides.verifyCompletionClaims ?? true,
  };
}
