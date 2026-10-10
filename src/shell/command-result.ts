/** Result returned by one persistent shell command. */
export interface CommandResult {
  /** Complete standard output captured for the command. */
  stdout: string;
  /** Complete standard error captured for the command. */
  stderr: string;
  /** Exit status; timeout uses the conventional 124 status. */
  exitCode: number;
  /** Wall-clock execution duration in milliseconds. */
  durationMs: number;
  /** Whether Atlas killed the command because it exceeded its timeout. */
  timedOut: boolean;
  /** Whether the command was stopped because the user cancelled the turn. */
  cancelled?: boolean;
}
