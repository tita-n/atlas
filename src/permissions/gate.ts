/**
 * The single place a command is decided.
 *
 * `atlas chat` and `atlas tui` previously each built their own
 * ConfirmationFlow. Only the TUI wired the hard floor and autonomy in, so the
 * two entry points into the same program had different safety guarantees - and
 * `chat` only looked safe because an unrelated readline bug denied by default.
 *
 * Both front-ends now construct the gate through this function, so there is one
 * code path rather than two that can drift.
 */

import {
  ConfirmationFlow,
  type ConfirmationRequest,
  type TextConfirmationResult,
} from './confirmation-flow.js';
import { hardFloorVerdict } from './autonomy.js';
import type { AutonomyLevel } from './autonomy.js';

export interface GateInput {
  provider: ConstructorParameters<typeof ConfirmationFlow>[0]['provider'];
  model: string;
  phrase?: string | undefined;
  /** When true, no dangerous command is ever auto-allowed. */
  blockAll: boolean;
  /** Current level. Recorded by the caller on each audit row. */
  autonomy: () => AutonomyLevel;
  /** The user's home directory, for home-scoped judgement. */
  home: string;
  /**
   * Asks the user, showing the exact command. Returning a denial ends the turn.
   *
   * Takes the request because a prompt that describes a risk without showing
   * what is about to run cannot be approved knowingly.
   */
  ask: (request: ConfirmationRequest) => Promise<TextConfirmationResult>;
  onNotice?: ((message: string) => void) | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
}

/** Builds the confirmation gate used by every front-end. */
export function createGate(input: GateInput): ConfirmationFlow {
  return new ConfirmationFlow({
    provider: input.provider,
    model: input.model,
    phrase: input.phrase,
    // Consulted for every command, independent of tier or autonomy, so a durable
    // grant can skip the ask but never this check.
    hardFloor: (command) =>
      hardFloorVerdict(command, { home: input.home }).applies,
    ...(input.onNotice === undefined ? {} : { onNotice: input.onNotice }),
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    // Forwarded, and this used to be missing entirely. ConfirmationFlow reads
    // the level to decide whether to ask, and with it absent it fell back to
    // 'confirm-everything' - so `unattended` never took effect and the
    // setting was inert. The shape differs on purpose: the audit row wants a
    // level, the gate wants the scope that goes with it.
    autonomy: () => ({ level: input.autonomy() }),
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    confirmText: (request): Promise<TextConfirmationResult> => {
      if (input.blockAll) return Promise.resolve('deny');
      return input.ask(request);
    },
  });
}
