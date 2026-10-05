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

/** Commands available inside the assistant loop. */
export const ASSISTANT_HELP = [
  'Commands:',
  '  /help        show this list',
  '  /facts       list durable facts Atlas remembers',
  '  /corrections list standing corrections you have taught it',
  '  /corrections forget <id>  remove one you no longer want remembered',
  '  /exit        leave (Ctrl+D also works)',
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
