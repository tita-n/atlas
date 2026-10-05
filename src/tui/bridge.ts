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

/** Called when the permission gate needs an answer from the user. */
export type GateHandler = (phrase: string) => Promise<boolean>;

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
  onGate: GateHandler = () => Promise.resolve(false);

  /** Replaced by the app on mount; ignores by default. */
  onToolStart: ToolStartObserver = () => undefined;

  /** Pass this to the runtime's `requestConfirmation`. */
  readonly requestConfirmation = async (phrase: string): Promise<boolean> =>
    this.onGate(phrase);

  /** Pass this to the runtime's `onToolStart`. */
  readonly observeToolStart = (call: ToolCall): void => {
    this.onToolStart(call);
  };
}
