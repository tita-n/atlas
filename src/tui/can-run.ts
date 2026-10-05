/**
 * Whether the graphical front-end can run here.
 *
 * Kept in its own dependency-free module so the plain `atlas chat` path never
 * has to load Ink just to answer this question.
 */

/**
 * A TUI on a pipe corrupts the output, so the graphical front-end requires an
 * interactive terminal. `atlas` falls back to the plain front-end otherwise.
 */
export function canRunTui(
  options: { isTTY?: boolean | undefined } = {},
): boolean {
  return options.isTTY ?? process.stdout.isTTY ?? false;
}
