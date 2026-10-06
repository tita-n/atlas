/**
 * Reasoning separation.
 *
 * The three tag shapes are tested separately because the reported bug came
 * from the two that naive handling misses, and streaming is tested chunk by
 * chunk because tags genuinely straddle chunk boundaries in practice.
 */
import { describe, expect, it } from 'vitest';

import {
  ReasoningFilter,
  splitReasoning,
} from '../../src/reasoning/reasoning-filter.js';

/** Feeds text one chunk at a time, as a stream would. */
function streamed(
  text: string,
  size: number,
): { narration: string; reasoning: string } {
  const filter = new ReasoningFilter();
  let narration = '';
  for (let i = 0; i < text.length; i += size) {
    narration += filter.push(text.slice(i, i + size));
  }
  narration += filter.finish();
  return { narration, reasoning: filter.reasoning };
}

describe('the three tag shapes', () => {
  it('strips a complete block', () => {
    const r = splitReasoning('<think>hmm let me see</think>The answer is 42.');
    expect(r.narration).toBe('The answer is 42.');
    expect(r.reasoning).toBe('hmm let me see');
  });

  it('strips an UNTERMINATED block - the reported failure', () => {
    // The model ran out of budget mid-reasoning. A regex needing a closing tag
    // would never match, and the whole fragment would reach the user.
    const r = splitReasoning('<think>Okay, the user asked. First, I need to');
    expect(r.narration).toBe('');
    expect(r.reasoning).toContain('Okay, the user asked');
    expect(r.insideReasoning).toBe(true);
  });

  it('strips a BARE CLOSER with no opening tag', () => {
    // Nemotron / DeepSeek-R1 / Qwen3 style: reasoning runs from the start and
    // is ended by a lone </think>.
    const r = splitReasoning(
      'Let me think about this carefully.</think>I am Atlas.',
    );
    expect(r.narration).toBe('I am Atlas.');
    expect(r.reasoning).toBe('Let me think about this carefully.');
    expect(r.sawBareCloser).toBe(true);
  });

  it('leaves ordinary prose completely alone', () => {
    const r = splitReasoning('The config sets maxTokens to 4000.');
    expect(r.narration).toBe('The config sets maxTokens to 4000.');
    expect(r.reasoning).toBe('');
  });

  it('handles more than one block in a single response', () => {
    const r = splitReasoning('<think>a</think>One. <think>b</think>Two.');
    expect(r.narration).toBe('One. Two.');
    expect(r.reasoning).toBe('ab');
  });

  it('keeps literal-looking text that is not a tag', () => {
    const r = splitReasoning(
      'Use the <thinking> tag carefully. It is for plans.',
    );
    expect(r.narration).toBe(
      'Use the <thinking> tag carefully. It is for plans.',
    );
  });
});

describe('streaming across chunk boundaries', () => {
  it('never releases a partial tag', () => {
    // <th in one chunk, ink> in the next: the half tag must not be shown.
    const filter = new ReasoningFilter();
    expect(filter.push('<th')).toBe('');
    expect(filter.push('ink>secret reasoning</th')).toBe('');
    expect(filter.push('ink>Visible answer.')).toBe('Visible answer.');
    expect(filter.finish()).toBe('');
    expect(filter.reasoning).toBe('secret reasoning');
  });

  it('produces the same result regardless of chunk size', () => {
    const text = '<think>reasoning here</think>The real answer is yes.';
    const baseline = splitReasoning(text);
    for (const size of [1, 2, 3, 5, 8, 13, 40]) {
      const got = streamed(text, size);
      expect(got.narration).toBe(baseline.narration);
      expect(got.reasoning).toBe(baseline.reasoning);
    }
  });

  it('holds an unterminated block open to the very end of the stream', () => {
    const got = streamed('<think>never finished reasoning', 4);
    expect(got.narration).toBe('');
    expect(got.reasoning).toContain('never finished reasoning');
  });

  it('handles a bare closer split across chunks', () => {
    const filter = new ReasoningFilter();
    // The opening is held rather than released, because a bare closer can
    // still arrive and retroactively reclassify it as reasoning - and text
    // already shown cannot be retracted.
    expect(filter.push('quiet reasoning')).toBe('');
    expect(filter.push('</th')).toBe('');
    expect(filter.push('ink>Answer.')).toBe('');
    expect(filter.finish()).toBe('Answer.');
    expect(filter.reasoning).toBe('quiet reasoning');
    expect(filter.sawBareCloser).toBe(true);
  });

  it('releases the opening once it is clearly ordinary narration', () => {
    const filter = new ReasoningFilter();
    const long = 'Ordinary sentence about the repository. '.repeat(40);
    const released = filter.push(long);
    expect(released.length).toBeGreaterThan(0);
    expect(filter.push('More text.') + filter.finish()).toContain('More text.');
    // A very long leading block without a closer is a documented miss, not a
    // silent leak: it is reported as narration rather than hidden.
    expect(released).not.toContain('think');
  });

  it('splits a tag delivered one character at a time', () => {
    const text = '<think>r</think>Answer';
    expect(streamed(text, 1).narration).toBe('Answer');
  });
});

describe('answer-less generations', () => {
  it('reports no answer when the stream ended inside reasoning', () => {
    // Functionally the same failure class as completion fabrication: a dangling
    // fragment must not be presented as something that was actually delivered.
    const filter = new ReasoningFilter();
    filter.push('<think>and then I would');
    filter.finish();
    expect(filter.producedAnswer).toBe(false);
  });

  it('reports an answer once real content was produced', () => {
    const filter = new ReasoningFilter();
    filter.push('<think>r</think>Real content');
    filter.finish();
    expect(filter.producedAnswer).toBe(true);
  });

  it('treats a bare-closer stream as answer-less if nothing followed', () => {
    const filter = new ReasoningFilter();
    filter.push('only reasoning</think>');
    filter.finish();
    expect(filter.producedAnswer).toBe(false);
  });
});

describe('reasoning is captured, not discarded', () => {
  it('retains the reasoning text for an optional view', () => {
    const r = splitReasoning('<think>useful trace</think>Answer');
    expect(r.reasoning).toBe('useful trace');
  });

  it('never merges reasoning into narration', () => {
    for (const text of [
      '<think>leak</think>ok',
      '<think>leak',
      'leak</think>ok',
    ]) {
      const r = splitReasoning(text);
      expect(r.narration).not.toContain('leak');
    }
  });
});
