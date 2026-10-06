/**
 * Bridge between the assistant runtime and the React tree.
 *
 * The runtime has to exist before Ink renders, but the confirmation gate and
 * the tool-execution observer both belong to components that only mount later.
 * This holds the two callbacks so `run.tsx` can wire them into the runtime up
 * front and the app can publish them on mount.
 *
 * Defaults are deliberately conservative: with nothing mounted, a confirmation
 * is refused and a tool start is ignored, so the runtime can never be left
 * waiting on an interface that is not there.
 */

import type { ToolCall } from '../providers/provider.interface.js';

/**
 * What a confirmation modal decided.
 *
 * `approve` is the only value that runs a command. There is no path from the
 * modal back to the permission logic itself, which stays exactly as it was.
 */
export type GateDecision = 'approve' | 'deny';

/** What is being approved, so the modal can show it rather than ask blindly. */
export interface GateRequest {
  /** The typed safe word the configured policy expects. */
  readonly phrase: string;
  /** The command that will run if approved. */
  readonly command: string;
  /** Why confirmation is required, when known. */
  readonly reason?: string | undefined;
}

/** Called when the permission gate needs an answer from the user. */
export type GateHandler = (request: GateRequest) => Promise<GateDecision>;

/** Called just before a tool runs, so the UI can show "executing". */
export type ToolStartObserver = (call: ToolCall) => void;

export class TuiBridge {
  /**
   * Notices raised while the runtime was starting.
   *
   * These arrive before the app mounts, so they are buffered here and drained
   * by the splash. Printing them straight to stdout instead would put raw text
   * above the interface, which Ink then redraws over.
   */
  readonly notices: string[] = [];

  /** Records a startup notice for the splash. */
  onNotice: (message: string) => void = (message) => {
    this.notices.push(message);
  };

  /** Takes the buffered notices, leaving the buffer empty. */
  drainNotices(): readonly string[] {
    return this.notices.splice(0, this.notices.length);
  }

  /** Replaced by the app on mount; refuses by default. */
  onGate: GateHandler = () => Promise.resolve('deny');

  /** Replaced by the app on mount; ignores by default. */
  onToolStart: ToolStartObserver = () => undefined;

  /**
   * Pass this to the runtime's `requestConfirmation`.
   *
   * The runtime takes a boolean; only `approve` becomes true, so a modal that
   * times out or is dismissed refuses the command rather than defaulting to
   * running it.
   */
  readonly requestConfirmation = async (phrase: string): Promise<boolean> => {
    // `pendingCommand` is published by the runtime's tool observer before the
    // gate is consulted, so it is readable here. It was previously read before
    // the handler ran, which left the modal approving an unnamed action.
    const request: GateRequest = {
      phrase,
      command: this.pendingCommand ?? '',
      ...(this.pendingReason === undefined
        ? {}
        : { reason: this.pendingReason }),
    };
    const decision = await this.onGate(request);
    this.pendingCommand = undefined;
    this.pendingReason = undefined;
    return decision === 'approve';
  };

  /** Command currently awaiting approval, shown in the modal. */
  pendingCommand: string | undefined;
  pendingReason: string | undefined;

  /** Pass this to the runtime's `onToolStart`. */
  readonly observeToolStart = (call: ToolCall): void => {
    this.onToolStart(call);
  };
}
