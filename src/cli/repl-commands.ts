/**
 * Slash commands available inside the chat REPL.
 *
 * Without these, anything starting with `/` is silently sent to the model,
 * which is confusing when the banner only mentions `/exit`. Unknown commands
 * now get a helpful hint instead of a wasted model round trip.
 */

/** One REPL command. */
export interface ReplCommand {
  /** Token the user types, without the leading slash. */
  readonly name: string;
  /** One-line description shown by `/help`. */
  readonly summary: string;
}

export const REPL_COMMANDS: readonly ReplCommand[] = [
  { name: 'help', summary: 'Show this list of commands.' },
  { name: 'new', summary: 'Start a fresh conversation.' },
  { name: 'history', summary: 'List stored conversations.' },
  { name: 'memory', summary: 'List stored memory facts.' },
  { name: 'grants', summary: 'List remembered command approvals.' },
  { name: 'audit', summary: 'Show recent permission decisions.' },
  {
    name: 'status',
    summary: 'Show the active model, provider, and conversation.',
  },
  { name: 'exit', summary: 'Leave Atlas (Ctrl+D also works).' },
];

/** Parses a line into a command name and argument, or undefined for prose. */
export function parseSlashCommand(
  line: string,
): { name: string; argument: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const match = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(trimmed);
  if (match === null) return undefined;
  return {
    name: (match[1] ?? '').toLowerCase(),
    argument: (match[2] ?? '').trim(),
  };
}

/** True when a slash line looks like a command rather than a typo. */
export function looksLikeCommand(line: string): boolean {
  return parseSlashCommand(line) !== undefined;
}

/** Renders the `/help` body. */
export function renderHelp(): string {
  const width = Math.max(
    ...REPL_COMMANDS.map((command) => command.name.length),
  );
  return [
    'Commands:',
    ...REPL_COMMANDS.map(
      (command) => `  /${command.name.padEnd(width)}  ${command.summary}`,
    ),
    '',
    'Anything that does not start with / is sent to the model.',
  ].join('\n');
}
