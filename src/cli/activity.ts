/**
 * Minimal, dependency-free activity indicator for the REPL.
 *
 * While Atlas waits on the model or runs a command the terminal used to go
 * completely silent, which looks identical to a hang. This renders an
 * elapsed-time spinner on a TTY and plain status lines when piped to a file,
 * and always degrades to doing nothing when output is not a terminal.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const FRAME_INTERVAL_MS = 80;

/** Carriage return plus erase-to-end-of-line, the portable way to redraw. */
const CLEAR_LINE = '\r\u001B[2K';

export interface ActivityOptions {
  /**
   * Stream to draw on, defaults to stdout.
   *
   * Typed structurally rather than as `NodeJS.WriteStream` so tests can pass a
   * minimal double.
   */
  readonly output?: ActivityStream;
  /** Frame delay in milliseconds. */
  readonly intervalMs?: number;
  /** Force-disable animation regardless of TTY detection. */
  readonly enabled?: boolean;
}

/** Minimal stream surface the indicator needs. */
export interface ActivityStream {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
}

/** Controls the single activity line shown while work is in flight. */
export interface Activity {
  /** Starts or replaces the activity line with a new message. */
  start(message: string): void;
  /** Replaces the message without restarting the elapsed timer. */
  update(message: string): void;
  /** Stops the line, optionally printing a final message. */
  stop(finalMessage?: string): void;
  /** Whether an activity line is currently running. */
  readonly active: boolean;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

/** Collapses a command to a single short line for the activity display. */
export function describeActivity(message: string, maxLength = 60): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function createActivity(options: ActivityOptions = {}): Activity {
  const output = options.output ?? process.stdout;
  const interval = options.intervalMs ?? FRAME_INTERVAL_MS;
  const interactive = options.enabled ?? output.isTTY;

  let timer: NodeJS.Timeout | undefined;
  let message = '';
  let running = false;
  let startedAt = 0;
  let frame = 0;
  let rendered = false;

  const clearLine = (): void => {
    if (!rendered) return;
    // Carriage return, clear to end of line, then clear again for terminals
    // that keep the cursor column after a carriage return.
    output.write(CLEAR_LINE);
    rendered = false;
  };

  const render = (): void => {
    if (!interactive) return;
    const elapsed = formatElapsed(Date.now() - startedAt);
    const spinner = FRAMES[frame % FRAMES.length] ?? '';
    output.write(`${CLEAR_LINE}${spinner} ${message} (${elapsed})`);
    rendered = true;
  };

  const tick = (): void => {
    frame += 1;
    render();
  };

  return {
    get active(): boolean {
      return running;
    },
    start(next: string): void {
      message = next;
      if (running) {
        render();
        return;
      }
      running = true;
      startedAt = Date.now();
      frame = 0;
      if (!interactive) {
        // Non-interactive output still gets one durable status line so logs
        // and CI transcripts show that work started.
        output.write(`… ${message}\n`);
        return;
      }
      render();
      timer = setInterval(tick, interval);
      timer.unref?.();
    },
    update(next: string): void {
      message = next;
      if (!running) return;
      if (interactive) render();
    },
    stop(finalMessage?: string): void {
      if (!running) return;
      running = false;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (interactive) clearLine();
      if (finalMessage !== undefined && finalMessage !== '') {
        output.write(`${finalMessage}\n`);
      }
    },
  };
}
