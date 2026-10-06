/**
 * Slash commands available inside the Phase 4 assistant loop.
 *
 * These are the assistant loop's own commands, deliberately distinct from the
 * pre-Phase-4 REPL's set in `cli/repl-commands.ts`: the assistant surfaces
 * facts and corrections, which the raw loop never had.
 *
 * Handling lives here rather than inline in a front-end so that the plain
 * `atlas chat` REPL and the TUI cannot drift apart. Every handler returns the
 * text to display instead of printing, which is what lets the TUI render it
 * inside its own chrome.
 */

import type { CorrectionsRepository } from '../memory/corrections-repository.js';
import type { FactsRepository } from '../memory/facts-repository.js';

/**
 * The assistant loop's command registry.
 *
 * Structured data rather than a preformatted help string, so the help text,
 * the completion dropdown, and any future discovery surface all read from one
 * source instead of three that can drift.
 */
export interface AssistantCommandSpec {
  /** Token the user types, without the leading slash. */
  readonly name: string;
  /** One-line description shown in the dropdown and in /help. */
  readonly summary: string;
  /** Whether the command takes an argument, e.g. `/corrections forget <id>`. */
  readonly takesArgument: boolean;
  /** Example argument form, for the dropdown. */
  readonly argumentHint?: string;
  /** Whether the command reaches outside the conversation to change settings. */
  readonly opensModal: boolean;
}

export const ASSISTANT_COMMAND_REGISTRY: readonly AssistantCommandSpec[] = [
  {
    name: 'help',
    summary: 'Show this list',
    takesArgument: false,
    opensModal: false,
  },
  {
    name: 'facts',
    summary: 'List durable facts Atlas remembers',
    takesArgument: false,
    opensModal: false,
  },
  {
    name: 'corrections',
    summary: 'List standing corrections you have taught it',
    takesArgument: true,
    argumentHint: 'forget <id>',
    opensModal: false,
  },
  {
    name: 'model',
    summary: 'Switch the active model',
    takesArgument: false,
    opensModal: true,
  },
  {
    name: 'autonomy',
    summary: 'Show or set how often Atlas asks before acting',
    takesArgument: false,
    opensModal: true,
  },
  {
    name: 'init',
    summary: 'Set up a provider and API key',
    takesArgument: false,
    opensModal: true,
  },
  {
    name: 'exit',
    summary: 'Leave Atlas (Ctrl+D also works)',
    takesArgument: false,
    opensModal: false,
  },
];

/** Commands matching a partially typed name, for the completion dropdown. */
export function filterAssistantCommands(query: string): AssistantCommandSpec[] {
  const needle = query.replace(/^\//, '').trim().toLowerCase();
  if (needle === '') return [...ASSISTANT_COMMAND_REGISTRY];
  // Prefix matches first: typing "/c" should offer /corrections, not every
  // command whose description happens to contain the letter "c".
  const byName = ASSISTANT_COMMAND_REGISTRY.filter((command) =>
    command.name.startsWith(needle),
  );
  if (byName.length > 0) return byName;
  return ASSISTANT_COMMAND_REGISTRY.filter((command) =>
    command.summary.toLowerCase().includes(needle),
  );
}

/** Commands available inside the assistant loop. */
export const ASSISTANT_HELP = [
  'Commands:',
  ...ASSISTANT_COMMAND_REGISTRY.map((command) => {
    const argument = command.argumentHint ?? '';
    const label = `  /${command.name}${argument === '' ? '' : ` ${argument}`}`;
    return `${label.padEnd(28)}${command.summary}`;
  }),
  '',
  'Anything else is sent to Atlas. It resumes your last conversation',
  'automatically; use "atlas chat --new" to start over.',
].join('\n');

export interface AssistantCommandDeps {
  readonly facts: FactsRepository;
  readonly corrections: CorrectionsRepository;
}

/** What the front-end should do with a submitted line. */
export type AssistantCommandOutcome =
  /** Leave the session. */
  | { readonly kind: 'exit' }
  /** Run this line as a normal assistant turn. */
  | { readonly kind: 'prose'; readonly message: string }
  /** Display this text locally; nothing was sent to the model. */
  | { readonly kind: 'output'; readonly text: string };

/**
 * Interprets one submitted line.
 *
 * Pure with respect to the repositories apart from an explicit `forget`
 * deletion, which is the command's whole purpose.
 */
export function runAssistantCommand(
  line: string,
  deps: AssistantCommandDeps,
): AssistantCommandOutcome {
  const message = line.trim();
  if (message === '/exit' || message === '/quit') return { kind: 'exit' };
  if (message === '') return { kind: 'output', text: '' };

  if (message === '/help') {
    return { kind: 'output', text: ASSISTANT_HELP };
  }

  if (message === '/facts') {
    const all = deps.facts.getAllFacts();
    if (all.length === 0)
      return { kind: 'output', text: 'No durable facts stored yet.' };
    return {
      kind: 'output',
      text: all
        .map(
          (fact) =>
            `-${fact.category === null ? '' : ` [${fact.category}]`} ${fact.content}`,
        )
        .join('\n'),
    };
  }

  if (message === '/corrections' || message.startsWith('/corrections ')) {
    const argument = message.slice('/corrections'.length).trim();
    if (argument.startsWith('forget ')) {
      const raw = argument.slice('forget '.length).trim();
      const id = Number.parseInt(raw, 10);
      const forgotten = Number.isFinite(id) && deps.corrections.delete(id);
      return {
        kind: 'output',
        text: forgotten
          ? `Forgot correction #${id}.`
          : `No correction #${raw}.`,
      };
    }
    const all = deps.corrections.list();
    if (all.length === 0) {
      return { kind: 'output', text: 'No corrections recorded yet.' };
    }
    const lines = all.map((c) => `#${c.id} ${c.instruction}`);
    lines.push('Remove one with: /corrections forget <id>');
    return { kind: 'output', text: lines.join('\n') };
  }

  if (message.startsWith('/')) {
    return {
      kind: 'output',
      text: `Unknown command ${message}. Type /help for what is available.`,
    };
  }

  return { kind: 'prose', message };
}
