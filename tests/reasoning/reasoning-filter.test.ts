/**
 * Reasoning separation.
 *
 * The three tag shapes are tested separately because the reported bug came
 * from the two that naive handling misses, and streaming is tested chunk by
 * chunk because tags genuinely straddle chunk boundaries in practice.
 */
import { describe, expect, it } from 'vitest';

import {
  LEADING_HOLD_CHARS,
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

/** Feeds an explicit chunk list, as a stream would. */
function pushed(chunks: string[]): {
  narration: string;
  reasoning: string;
  producedAnswer: boolean;
  deltas: string[];
} {
  const filter = new ReasoningFilter();
  const deltas = chunks.map((chunk) => filter.push(chunk));
  deltas.push(filter.finish());
  return {
    narration: deltas.join(''),
    reasoning: filter.reasoning,
    producedAnswer: filter.producedAnswer,
    deltas,
  };
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

describe('tag spelling variants', () => {
  // A reasoner that spells its own tag differently still wrote reasoning, and
  // reasoning reaching narration is the one failure that cannot be undone.
  it('strips an UPPERCASE block', () => {
    const r = splitReasoning('<THINK>secret trace</THINK>The answer.');
    expect(r.narration).toBe('The answer.');
    expect(r.reasoning).toBe('secret trace');
  });

  it('strips a MIXED CASE block', () => {
    const r = splitReasoning('<Think>secret trace</Think>The answer.');
    expect(r.narration).toBe('The answer.');
    expect(r.reasoning).toBe('secret trace');
  });

  it('strips reasoning ended by an UPPERCASE closer', () => {
    const r = splitReasoning('secret trace</THINK>The answer.');
    expect(r.narration).toBe('The answer.');
    expect(r.reasoning).toBe('secret trace');
    expect(r.sawBareCloser).toBe(true);
  });

  it('strips a tag carrying inner whitespace', () => {
    const r = splitReasoning('<think >secret trace</think >The answer.');
    expect(r.narration).toBe('The answer.');
    expect(r.reasoning).toBe('secret trace');
  });

  it('strips an unterminated tag carrying inner whitespace', () => {
    const r = splitReasoning('<think >secret trace that never ends');
    expect(r.narration).toBe('');
    expect(r.insideReasoning).toBe(true);
  });

  it('strips an uppercase block split across chunks', () => {
    const r = pushed(['<TH', 'INK>trace</TH', 'INK>Answer']);
    expect(r.narration).toBe('Answer');
    expect(r.reasoning).toBe('trace');
  });

  it('strips a whitespace-padded tag split across chunks', () => {
    const r = pushed(['<THINK ', '>trace</think', ' >Answer']);
    expect(r.narration).toBe('Answer');
    expect(r.reasoning).toBe('trace');
  });

  it('still leaves a longer tag name alone', () => {
    // Anchoring is what keeps `<thinking>` prose from being eaten.
    for (const text of [
      'Use the <thinking> tag for plans.',
      'The <Thinker> class parses it.',
    ]) {
      expect(splitReasoning(text).narration).toBe(text);
    }
  });
});

describe('answer text is never lost', () => {
  it('captures text sitting between two stray closers', () => {
    // Regression: this text was dropped from narration AND reasoning, because
    // the branch that handles a closer with no opener only looked at a buffer
    // that is never written to once narration has been released.
    const r = splitReasoning('<think>r</think>ans</think>tail');
    expect(r.narration).toBe('tail');
    expect(r.reasoning).toBe('rans');
  });

  it('captures that text identically when it arrives in two pushes', () => {
    const r = pushed(['<think>r</think>', 'ans</think>tail']);
    expect(r.narration).toBe('tail');
    expect(r.reasoning).toBe('rans');
  });

  it('keeps text buffered before a stray closer once narration was released', () => {
    // The leading hold had already released this reply, so it cannot be
    // retracted; the part still buffered must at least reach reasoning.
    const r = pushed(['- a\n- b\n- c', ' more answer text</think> tail']);
    expect(r.narration).toBe('- a\n- b\n- c tail');
    expect(r.reasoning).toBe(' more answer text');
  });

  it('leaves a code block intact', () => {
    const answer = 'Here is the patch:\n```ts\nconst x = 1;\n```\nDone.';
    expect(splitReasoning(answer).narration).toBe(answer);
    expect(streamed(answer, 7).narration).toBe(answer);
  });

  it('leaves JSON intact', () => {
    const answer = '{"tool":"read","path":"src/a.ts","note":"a think b"}';
    expect(splitReasoning(answer).narration).toBe(answer);
    expect(streamed(answer, 5).narration).toBe(answer);
  });

  it('leaves ordinary prose containing the word think intact', () => {
    const answer =
      'I think the fastest route is a two-step one. Re-think it after the test.';
    expect(splitReasoning(answer).narration).toBe(answer);
    expect(streamed(answer, 3).narration).toBe(answer);
  });

  it('does not hold a trailing whitespace run past the end of the stream', () => {
    expect(pushed(['Answer', '   ']).narration).toBe('Answer   ');
  });
});

describe('every split point of every shape', () => {
  const shapes: [string, string][] = [
    ['complete', '<think>reasoning trace</think>The answer is yes.'],
    ['unterminated', '<think>reasoning trace that never ends'],
    ['bare closer', 'quiet reasoning trace</think>The answer is yes.'],
    ['two complete blocks', '<think>a</think>One. <think>b</think>Two.'],
  ];

  for (const [name, text] of shapes) {
    it(`gives the same result for ${name} at every split point`, () => {
      const whole = streamed(text, text.length);
      for (let split = 1; split < text.length; split += 1) {
        const got = pushed([text.slice(0, split), text.slice(split)]);
        expect(got.narration).toBe(whole.narration);
        expect(got.reasoning).toBe(whole.reasoning);
      }
      const perCharacter = pushed(text.split(''));
      expect(perCharacter.narration).toBe(whole.narration);
      expect(perCharacter.reasoning).toBe(whole.reasoning);
    });
  }
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

  it('reports an answer for a bare-closer stream that did continue', () => {
    expect(pushed(['only reasoning</think>', 'Answer']).producedAnswer).toBe(
      true,
    );
  });

  it('reports no answer for an unterminated block delivered char by char', () => {
    expect(pushed('<think>cut off here'.split('')).producedAnswer).toBe(false);
  });

  it('reports no answer for whitespace-only narration', () => {
    expect(pushed(['   ']).producedAnswer).toBe(false);
  });
});

describe('state does not leak between responses', () => {
  it('keeps one instance for two pushes reading as a single stream', () => {
    // This is what streaming looks like in production: several text events for
    // one model turn, so the second must not restart the split.
    const r = pushed(['The answer is ', '42.</think>oops']);
    expect(r.narration).toBe('oops');
    expect(r.reasoning).toBe('The answer is 42.');
  });

  it('keeps two instances independent', () => {
    const first = new ReasoningFilter();
    first.push('<think>first trace that never ends');
    const second = new ReasoningFilter();
    const released = second.push('<think>second trace</think>Second answer.');

    expect(first.reasoning).toBe('first trace that never ends');
    expect(first.finish()).toBe('');
    expect(first.producedAnswer).toBe(false);

    expect(second.reasoning).toBe('second trace');
    expect(released + second.finish()).toBe('Second answer.');
    expect(second.producedAnswer).toBe(true);
  });

  it('does not let one response suppress another response thinking tags', () => {
    const unterminated = new ReasoningFilter();
    unterminated.push('<think>dangling');
    const complete = new ReasoningFilter();
    complete.push('<think>r</think>Answer');
    expect(complete.reasoning).toBe('r');
    expect(unterminated.reasoning).toBe('dangling');
  });
});

describe('latency of the leading hold', () => {
  it('bounds how long the opening is held', () => {
    // The bound is the whole safety argument for the bare-closer shape, so it
    // must stay a small, explicit number rather than drift upward.
    expect(LEADING_HOLD_CHARS).toBeGreaterThan(0);
    expect(LEADING_HOLD_CHARS).toBeLessThanOrEqual(256);
  });

  it('releases structured prose on the first delta', () => {
    const filter = new ReasoningFilter();
    const released = filter.push('Here is the plan:\n\n1. Read the config.');
    expect(released).not.toBe('');
    expect(filter.finish()).toBe('');
  });

  it('streams a response longer than the bound instead of one blob', () => {
    const answer = 'Sentence number n carries a little more weight. '.repeat(8);
    expect(answer.length).toBeGreaterThan(LEADING_HOLD_CHARS);
    const filter = new ReasoningFilter();
    const deltas: string[] = [];
    for (let i = 0; i < answer.length; i += 20) {
      deltas.push(filter.push(answer.slice(i, i + 20)));
    }
    deltas.push(filter.finish());
    const nonEmpty = deltas.filter((delta) => delta !== '');
    expect(nonEmpty.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(answer);
  });

  it('holds a short shapeless opening until it is decided', () => {
    // Bounded, and the deliberate cost: a reply with no shape signal is held
    // for at most LEADING_HOLD_CHARS characters.
    const short = 'One short sentence with no structure at all.';
    expect(short.length).toBeLessThan(LEADING_HOLD_CHARS);
    const filter = new ReasoningFilter();
    expect(filter.push(short)).toBe('');
    expect(filter.finish()).toBe(short);
  });
});

describe('documented limits', () => {
  it('releases text a later stray closer would have reclassified', () => {
    // Same root cause as the leading-hold trade below: once a delta is out it
    // cannot be taken back, so how the same response is chunked decides
    // whether text between two stray closers reads as narration.
    const text = '<think>r</think>ans</think>tail';
    expect(splitReasoning(text).narration).toBe('tail');
    expect(pushed([text]).narration).toBe('tail');
    expect(pushed(['<think>r</think>ans', '</think>tail']).narration).toBe(
      'anstail',
    );
  });

  it('leaks a bare-closer trace longer than the bound when it is chunked', () => {
    // The known trade, pinned rather than hidden: past LEADING_HOLD_CHARS the
    // opening is released, and released text cannot be retracted. Delivered in
    // one piece the same response is clean, so chunking decides whether a long
    // unclosed trace leaks. Raising the bound trades this for latency.
    const trace = 'reasoning '.repeat(20);
    const text = `${trace}</think>The answer.`;
    expect(trace.length).toBeGreaterThan(LEADING_HOLD_CHARS);
    expect(splitReasoning(text).narration).toBe('The answer.');
    expect(streamed(text, 40).narration).toContain(trace);
  });

  it('is not split-invariant for nested tags', () => {
    // Nested openers are not a shape reasoners emit. The inner closer ends the
    // block early, so the rest depends on how much was already released.
    const text = '<think>a<think>b</think>c</think>Ans';
    expect(splitReasoning(text).narration).toBe('Ans');
    expect(streamed(text, text.length).narration).toBe('Ans');
    expect(streamed(text, 1).narration).toBe('cAns');
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
