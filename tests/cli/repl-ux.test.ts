import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import {
  createActivity,
  describeActivity,
  type ActivityStream,
} from '../../src/cli/activity.js';
import {
  REPL_COMMANDS,
  looksLikeCommand,
  parseSlashCommand,
  renderHelp,
} from '../../src/cli/repl-commands.js';

function fakeStream(isTTY: boolean): {
  stream: ActivityStream;
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  (stream as unknown as { isTTY: boolean }).isTTY = isTTY;
  return { stream, text: () => chunks.join('') };
}

describe('activity indicator', () => {
  it('writes a single status line when output is not a terminal', () => {
    const { stream, text } = fakeStream(false);
    const activity = createActivity({ output: stream, enabled: false });

    activity.start('Thinking');
    activity.stop();

    expect(text()).toBe('… Thinking\n');
  });

  it('reports elapsed time on a terminal', () => {
    vi.useFakeTimers();
    try {
      const { stream, text } = fakeStream(true);
      const activity = createActivity({
        output: stream,
        enabled: true,
        intervalMs: 10,
      });

      activity.start('Thinking');
      vi.advanceTimersByTime(3_000);
      activity.stop();

      expect(text()).toContain('Thinking');
      expect(text()).toMatch(/\(3s\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the message without restarting the timer', () => {
    const { stream, text } = fakeStream(true);
    const activity = createActivity({ output: stream, enabled: true });

    activity.start('Thinking');
    activity.update('Running ls -la');
    activity.stop();

    expect(text()).toContain('Running ls -la');
  });

  it('clears the line on stop and leaves the cursor tidy', () => {
    const { stream, text } = fakeStream(true);
    const activity = createActivity({ output: stream, enabled: true });

    activity.start('Thinking');
    activity.stop();

    expect(text().endsWith('\r[2K')).toBe(true);
    expect(activity.active).toBe(false);
  });

  it('is safe to stop when nothing is running', () => {
    const { stream } = fakeStream(true);
    const activity = createActivity({ output: stream, enabled: true });
    expect(() => {
      activity.stop();
      activity.stop('done');
    }).not.toThrow();
  });

  it('prints a final message when one is given', () => {
    const { stream, text } = fakeStream(false);
    const activity = createActivity({ output: stream, enabled: false });
    activity.start('Thinking');
    activity.stop('all done');
    expect(text()).toBe('… Thinking\nall done\n');
  });
});

describe('describeActivity', () => {
  it('collapses whitespace so the line stays short', () => {
    expect(describeActivity('cat   /a/b\nfile')).toBe('cat /a/b file');
  });

  it('truncates long commands with an ellipsis', () => {
    const long = describeActivity('echo '.repeat(40), 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('slash commands', () => {
  it('parses a command with an argument', () => {
    expect(parseSlashCommand('/audit 25')).toEqual({
      name: 'audit',
      argument: '25',
    });
  });

  it('is case insensitive on the name', () => {
    expect(parseSlashCommand('/HELP')?.name).toBe('help');
  });

  it('ignores ordinary prose', () => {
    expect(parseSlashCommand('what is 2 + 2')).toBeUndefined();
    expect(looksLikeCommand('find the agora folder')).toBe(false);
  });

  it('does not treat a bare slash as a command', () => {
    expect(parseSlashCommand('/')).toBeUndefined();
  });

  it('lists every command in the help output', () => {
    const help = renderHelp();
    for (const command of REPL_COMMANDS) {
      expect(help).toContain(`/${command.name}`);
    }
  });

  it('explains that everything else goes to the model', () => {
    expect(renderHelp()).toMatch(/sent to the model/);
  });
});
