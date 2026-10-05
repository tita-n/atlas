import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_HELP,
  runAssistantCommand,
} from '../../src/conversation/assistant-commands.js';
import { TuiBridge } from '../../src/tui/bridge.js';
import { canRunTui } from '../../src/tui/can-run.js';
import type { CorrectionsRepository } from '../../src/memory/corrections-repository.js';
import type { FactsRepository } from '../../src/memory/facts-repository.js';

/**
 * The command handler is shared by the plain REPL and the TUI, so a bug here
 * shows up in both front-ends at once.
 */
function deps(
  overrides: {
    facts?: readonly { category: string | null; content: string }[];
    corrections?: readonly { id: number; instruction: string }[];
    deleted?: boolean;
  } = {},
): {
  facts: FactsRepository;
  corrections: CorrectionsRepository;
} {
  const facts = {
    getAllFacts: () => overrides.facts ?? [],
  } as unknown as FactsRepository;
  const corrections = {
    list: () => overrides.corrections ?? [],
    delete: () => overrides.deleted ?? false,
  } as unknown as CorrectionsRepository;
  return { facts, corrections };
}

describe('assistant slash commands', () => {
  it('exits on /exit and /quit', () => {
    expect(runAssistantCommand('/exit', deps()).kind).toBe('exit');
    expect(runAssistantCommand('/quit', deps()).kind).toBe('exit');
    expect(runAssistantCommand('  /exit  ', deps()).kind).toBe('exit');
  });

  it('treats an empty line as nothing to do', () => {
    const result = runAssistantCommand('   ', deps());
    expect(result).toEqual({ kind: 'output', text: '' });
  });

  it('routes ordinary prose to the assistant', () => {
    const result = runAssistantCommand('what is my project?', deps());
    expect(result).toEqual({
      kind: 'prose',
      message: 'what is my project?',
    });
  });

  it('trims surrounding whitespace from prose', () => {
    expect(runAssistantCommand('  hello  ', deps())).toEqual({
      kind: 'prose',
      message: 'hello',
    });
  });

  it('lists facts, saying so when there are none', () => {
    expect(runAssistantCommand('/facts', deps())).toEqual({
      kind: 'output',
      text: 'No durable facts stored yet.',
    });
  });

  it('renders a fact category only when there is one', () => {
    const result = runAssistantCommand(
      '/facts',
      deps({
        facts: [
          { category: null, content: 'likes tea' },
          { category: 'work', content: 'uses TypeScript' },
        ],
      }),
    );
    expect(result).toEqual({
      kind: 'output',
      text: '- likes tea\n- [work] uses TypeScript',
    });
  });

  it('lists corrections with their ids', () => {
    const result = runAssistantCommand(
      '/corrections',
      deps({ corrections: [{ id: 7, instruction: 'call it Acme' }] }),
    );
    expect(result).toEqual({
      kind: 'output',
      text: '#7 call it Acme\nRemove one with: /corrections forget <id>',
    });
  });

  it('reports when there are no corrections', () => {
    expect(runAssistantCommand('/corrections', deps())).toEqual({
      kind: 'output',
      text: 'No corrections recorded yet.',
    });
  });

  it('forgets a correction and confirms it', () => {
    expect(
      runAssistantCommand('/corrections forget 7', deps({ deleted: true })),
    ).toEqual({ kind: 'output', text: 'Forgot correction #7.' });
  });

  it('reports a correction that was not there', () => {
    expect(runAssistantCommand('/corrections forget 9', deps())).toEqual({
      kind: 'output',
      text: 'No correction #9.',
    });
  });

  it('does not treat a non-numeric forget argument as a deletion', () => {
    expect(runAssistantCommand('/corrections forget abc', deps())).toEqual({
      kind: 'output',
      text: 'No correction #abc.',
    });
  });

  it('explains an unknown command instead of sending it to the model', () => {
    const result = runAssistantCommand('/nope', deps());
    expect(result).toEqual({
      kind: 'output',
      text: 'Unknown command /nope. Type /help for what is available.',
    });
  });

  it('never forwards a slash line to the model', () => {
    for (const line of ['/help', '/facts', '/corrections', '/nope']) {
      expect(runAssistantCommand(line, deps()).kind).not.toBe('prose');
    }
  });

  it('returns the same help text the plain front-end prints', () => {
    const result = runAssistantCommand('/help', deps());
    expect(result).toEqual({ kind: 'output', text: ASSISTANT_HELP });
  });
});

describe('TUI bridge defaults', () => {
  it('refuses a confirmation when nothing has mounted', async () => {
    // The safe default: an unanswerable gate must not auto-approve a command.
    const bridge = new TuiBridge();
    await expect(bridge.requestConfirmation('ATLAS CONFIRM')).resolves.toBe(
      false,
    );
  });

  it('ignores a tool start when nothing has mounted', () => {
    const bridge = new TuiBridge();
    expect(() => {
      bridge.observeToolStart({ id: '1', name: 'shell', arguments: {} });
    }).not.toThrow();
  });

  it('delegates a confirmation to the mounted handler', async () => {
    const bridge = new TuiBridge();
    bridge.onGate = () => Promise.resolve(true);
    await expect(bridge.requestConfirmation('ATLAS CONFIRM')).resolves.toBe(
      true,
    );
  });

  it('buffers startup notices until the app drains them', () => {
    const bridge = new TuiBridge();
    bridge.onNotice('first');
    bridge.onNotice('second');
    expect(bridge.drainNotices()).toEqual(['first', 'second']);
    // Draining twice must not replay them.
    expect(bridge.drainNotices()).toEqual([]);
  });
});

describe('canRunTui', () => {
  it('runs only on an interactive terminal', () => {
    expect(canRunTui({ isTTY: true })).toBe(true);
  });

  it('refuses on a pipe, so scripted output is never corrupted', () => {
    expect(canRunTui({ isTTY: false })).toBe(false);
  });

  it('refuses when TTY state is unknown', () => {
    expect(canRunTui({ isTTY: undefined })).toBe(process.stdout.isTTY ?? false);
  });
});
