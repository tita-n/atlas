import { describe, expect, it } from 'vitest';

import { NarrationStreamGuard } from '../../src/conversation/narration-guard.js';

/** Feeds text in fixed-size pieces, as a stream would. */
function streamed(text: string, size: number): string {
  const guard = new NarrationStreamGuard();
  let shown = '';
  for (let i = 0; i < text.length; i += size) {
    shown += guard.push(text.slice(i, i + size));
  }
  return shown + guard.flush();
}

describe('narration stream guard', () => {
  it('shows ordinary prose as it arrives', () => {
    const guard = new NarrationStreamGuard();
    expect(guard.push('Here is ')).toBe('Here is ');
    expect(guard.push('a plain answer.')).toBe('a plain answer.');
  });

  it('holds back an inline tool payload from its opening brace', () => {
    const guard = new NarrationStreamGuard();
    // The braces mean nothing may be shown yet.
    expect(
      guard.push('Let me check {"tool_calls": [{"command": "rm -rf /tmp/x"}]}'),
    ).toBe('Let me check ');
  });

  it('never shows a partial JSON payload, character by character', () => {
    const payload =
      '{"tool_calls":[{"name":"shell","arguments":{"command":"rm -rf /"}}]}';
    const shown = streamed(`Sure. ${payload} Done.`, 3);
    expect(shown).not.toContain('rm -rf');
    expect(shown).not.toContain('tool_calls');
    // The prose around it still arrives.
    expect(shown).toContain('Sure.');
    expect(shown).toContain('Done.');
  });

  it('holds back text inside an unterminated fence', () => {
    const guard = new NarrationStreamGuard();
    expect(guard.push('Here:\n```json\n{"a":1}\n')).toBe('Here:\n');
    expect(guard.push('more fenced content\n')).toBe('');
  });

  it('never shows fenced tool payloads while streaming', () => {
    const text = 'Before\n```tool_call\n{"command":"rm -rf /"}\n```\nAfter';
    const shown = streamed(text, 4);
    expect(shown).not.toContain('rm -rf');
    expect(shown).toContain('Before');
    expect(shown).toContain('After');
  });

  it('keeps holding after a fence, then releases on flush', () => {
    const guard = new NarrationStreamGuard();
    // Text before the fence is safe and shown at once.
    expect(guard.push('a\n```\nhidden\n```\nb')).toBe('a\n');
    // Cap-and-hold: nothing further is shown live, even after the fence closes.
    expect(guard.push('more')).toBe('');
    // The whole-text rules at flush recover the text that followed the fence.
    expect(guard.flush()).toBe('bmore');
  });

  it('streams ordinary prose containing the word reasoning', () => {
    // Reasoning headers cannot be withheld incrementally without retracting
    // already-shown text, so they are removed by the final whole-text strip
    // rather than by this guard. Plain prose must not be held back for them.
    const guard = new NarrationStreamGuard();
    expect(guard.push('I was reasoning about it.')).toBe(
      'I was reasoning about it.',
    );
  });

  it('does not withhold ordinary prose that merely mentions reasoning', () => {
    const guard = new NarrationStreamGuard();
    expect(guard.push('I was reasoning about it.')).toBe(
      'I was reasoning about it.',
    );
  });

  it('emits nothing when the very first chunk opens a payload', () => {
    const guard = new NarrationStreamGuard();
    expect(guard.push('{"command":')).toBe('');
    expect(guard.push('"ls"}')).toBe('');
  });

  it('reassembles to the same text a whole-text strip would produce', () => {
    const cases = [
      'Just a normal reply.',
      'Here is code:\n```sh\nls -la\n```\nThat was it.',
      'Prefix {"tool_calls": []} suffix.',
      'Multi\nline\nreply\nwith\nnewlines.',
      'Curly braces in prose: {not json',
    ];
    for (const text of cases) {
      for (const size of [1, 2, 3, 7, 50]) {
        const shown = streamed(text, size);
        // Nothing withheld may vanish entirely from a safe reply.
        if (!text.includes('{') && !text.includes('```')) {
          expect(shown.replace(/\s+/g, ' ').trim()).toBe(
            text.replace(/\s+/g, ' ').trim(),
          );
        }
        // No payload text ever leaks.
        expect(shown).not.toContain('"command"');
      }
    }
  });

  it('drops an unterminated fence entirely on flush', () => {
    const guard = new NarrationStreamGuard();
    const shown =
      guard.push('Visible. Then ') + guard.push('```json\n{"secret":true}');
    const out = shown + guard.flush();
    expect(out).not.toContain('secret');
    expect(out).toContain('Visible.');
  });

  it('is reusable after a flush', () => {
    const guard = new NarrationStreamGuard();
    // Safe text is emitted immediately, so nothing is left for flush.
    expect(guard.push('one ')).toBe('one ');
    expect(guard.flush()).toBe('');
    expect(guard.push('two')).toBe('two');
  });

  it('handles an empty stream', () => {
    const guard = new NarrationStreamGuard();
    expect(guard.push('')).toBe('');
    expect(guard.flush()).toBe('');
  });
});
