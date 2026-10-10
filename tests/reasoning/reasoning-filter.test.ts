/**
 * Reasoning separation.
 *
 * Written against the lane contract the mature harnesses use: reasoning is a
 * separate typed channel, a family of tag names is matched, tags are classified
 * three ways, and there are no character caps.
 */
import { describe, expect, it } from 'vitest';

import {
  REASONING_TAG_NAMES,
  ReasoningFilter,
  splitReasoning,
  type Delta,
} from '../../src/reasoning/reasoning-filter.js';

const text = (deltas: readonly Delta[]): string =>
  deltas
    .filter((delta) => delta.lane === 'text')
    .map((delta) => delta.text)
    .join('');

/** Feeds text in fixed-size chunks, as a stream would. */
function streamed(
  input: string,
  size: number,
  options: { expectsInlineReasoning?: boolean } = {},
): { narration: string; reasoning: string } {
  const filter = new ReasoningFilter(options);
  const collected: Delta[] = [];
  for (let i = 0; i < input.length; i += size) {
    collected.push(...filter.push(input.slice(i, i + size)));
  }
  collected.push(...filter.finish());
  // Reasoning accumulates on the filter; the text lane carries only the answer.
  return { narration: text(collected), reasoning: filter.reasoning };
}

/** Same, treating the model as one known to emit reasoning inline. */
function asReasoner(
  input: string,
  size = 1,
): { narration: string; reasoning: string } {
  return streamed(input, size, { expectsInlineReasoning: true });
}

describe('the three tag shapes', () => {
  it('strips a complete block', () => {
    const r = splitReasoning('<think>hmm let me see</think>The answer is 42.');
    expect(r.narration).toBe('The answer is 42.');
    expect(r.reasoning).toBe('hmm let me see');
  });

  it('strips an UNTERMINATED block - the reported failure', () => {
    // Output ran out mid-reasoning, so a regex needing a closing tag never
    // matched and the whole fragment reached the user.
    const r = splitReasoning('<think>Okay, the user asked. First, I need to');
    expect(r.narration).toBe('');
    expect(r.reasoning).toContain('Okay, the user asked');
    expect(r.insideReasoning).toBe(true);
  });

  it('strips a BARE CLOSER for a known reasoner', () => {
    // Nemotron / DeepSeek-R1 / Qwen3 style: reasoning runs from the start and
    // is ended by a lone </think>.
    const r = splitReasoning('Let me think carefully.</think>I am Atlas.', {
      expectsInlineReasoning: true,
    });
    expect(r.narration).toBe('I am Atlas.');
    expect(r.reasoning).toBe('Let me think carefully.');
    expect(r.sawBareCloser).toBe(true);
  });

  it('handles several blocks in one response', () => {
    const r = splitReasoning('<think>a</think>One. <think>b</think>Two.');
    expect(r.narration).toBe('One. Two.');
    expect(r.reasoning).toBe('ab');
  });

  it('leaves ordinary prose alone', () => {
    expect(splitReasoning('The config sets maxTokens to 4000.').narration).toBe(
      'The config sets maxTokens to 4000.',
    );
  });
});

describe('the tag family', () => {
  it('strips every reasoning tag name, not only think', () => {
    for (const name of REASONING_TAG_NAMES) {
      const r = splitReasoning(`<${name}>trace</${name}>Answer`);
      expect(r.narration, name).toBe('Answer');
      expect(r.reasoning, name).toBe('trace');
    }
  });

  it('tolerates casing, inner whitespace, and namespace prefixes', () => {
    for (const tag of ['<THINK>', '< think >', '<mm:think>', '<antml:think>']) {
      const closer = tag.replace('<', '</');
      expect(splitReasoning(`${tag}trace${closer}Answer`).narration, tag).toBe(
        'Answer',
      );
    }
  });

  it('does not treat an unrelated tag as reasoning', () => {
    const input = 'Use the <widget> tag carefully. It is unrelated.';
    expect(splitReasoning(input).narration).toBe(input);
  });
});

describe('code fences are not reasoning', () => {
  it('leaves a literal think tag inside a fenced block alone', () => {
    const input = 'Example:\n```html\n<think>literal</think>\n```\nDone.';
    expect(splitReasoning(input).narration).toBe(input);
  });
});

describe('streaming across chunk boundaries', () => {
  it('never releases a partial tag', () => {
    const filter = new ReasoningFilter();
    expect(text(filter.push('<th'))).toBe('');
    expect(text(filter.push('ink>secret reasoning</th'))).toBe('');
    expect(text(filter.push('ink>Visible answer.'))).toBe('Visible answer.');
    expect(text(filter.finish())).toBe('');
    expect(filter.reasoning).toBe('secret reasoning');
  });

  it('produces the same result regardless of chunk size', () => {
    const input = '<think>reasoning here</think>The real answer is yes.';
    const baseline = splitReasoning(input);
    for (const size of [1, 2, 3, 5, 8, 13, 40]) {
      expect(streamed(input, size).narration, `size ${size}`).toBe(
        baseline.narration,
      );
    }
  });

  it('holds an unterminated block open to the end of the stream', () => {
    const got = streamed('<think>never finished reasoning', 4);
    expect(got.narration).toBe('');
    expect(got.reasoning).toContain('never finished reasoning');
  });

  it('splits a tag delivered one character at a time', () => {
    expect(streamed('<think>r</think>Answer', 1).narration).toBe('Answer');
  });
});

describe('no character caps', () => {
  it('catches a bare closer however long the trace is', () => {
    // The 128-char cap that shipped released reasoning it should have held.
    const trace = 'reasoning '.repeat(20);
    const got = asReasoner(`${trace}</think>The answer.`, 40);
    expect(got.narration).toBe('The answer.');
    expect(got.reasoning).toContain('reasoning');
  });

  it('gives the same answer however the response is chunked', () => {
    // The same response must not depend on transport.
    const input = 'reasoning '.repeat(20) + '</think>The answer.';
    const baseline = asReasoner(input, input.length);
    for (const size of [1, 3, 7, 40, 200]) {
      expect(asReasoner(input, size).narration, `size ${size}`).toBe(
        baseline.narration,
      );
    }
  });

  it('streams an ordinary reply immediately for a non-reasoning model', () => {
    // No opening hold unless the model is known to reason, so ordinary replies
    // are never delayed by a problem they cannot have.
    const filter = new ReasoningFilter();
    expect(text(filter.push('The answer is straightforward.'))).toBe(
      'The answer is straightforward.',
    );
  });
});

describe('answer-less generations', () => {
  it('reports no answer when the stream ends inside reasoning', () => {
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

  it('reports no answer for a bare closer with nothing after it', () => {
    const filter = new ReasoningFilter({ expectsInlineReasoning: true });
    filter.push('only reasoning</think>');
    filter.finish();
    expect(filter.producedAnswer).toBe(false);
  });

  it('reports an answer when real content follows a bare closer', () => {
    const filter = new ReasoningFilter({ expectsInlineReasoning: true });
    filter.push('only reasoning</think>');
    filter.push('Then the answer is 7.');
    filter.finish();
    expect(filter.producedAnswer).toBe(true);
    expect(filter.reasoning).toBe('only reasoning');
  });

  it('reports an answer for ordinary prose with no tags at all', () => {
    const filter = new ReasoningFilter();
    filter.push('Plain answer.');
    filter.finish();
    expect(filter.producedAnswer).toBe(true);
  });

  it('reports no answer for an empty stream', () => {
    const filter = new ReasoningFilter();
    expect(filter.push('')).toEqual([]);
    expect(filter.finish()).toEqual([]);
    expect(filter.producedAnswer).toBe(false);
  });
});

describe('reasoning is captured, not discarded', () => {
  it('retains the reasoning text for an optional view', () => {
    expect(splitReasoning('<think>useful trace</think>Answer').reasoning).toBe(
      'useful trace',
    );
  });

  it('never merges reasoning into narration', () => {
    for (const input of [
      '<think>leak</think>ok',
      '<think>leak',
      'leak</think>ok',
    ]) {
      const r = splitReasoning(input, { expectsInlineReasoning: true });
      expect(r.narration).not.toContain('leak');
    }
  });
});

describe('leaks: reasoning never reaches narration', () => {
  it('keeps reasoning inside a nested block', () => {
    // The inner closer must not end the outer block, or everything after it -
    // still reasoning - would land on the answer lane.
    const r = splitReasoning(
      '<think>outer <think>inner</think> still reasoning</think>Answer',
    );
    expect(r.narration).toBe('Answer');
    expect(r.reasoning).toBe('outer inner still reasoning');
  });

  it('survives an opener with two closers', () => {
    const r = splitReasoning('<think>r</think></think>Answer');
    expect(r.narration).toBe('Answer');
    expect(r.reasoning).toBe('r');
  });

  it('does not release a bare closer that ends the response', () => {
    const r = splitReasoning('only reasoning</think>', {
      expectsInlineReasoning: true,
    });
    expect(r.narration).toBe('');
    expect(r.reasoning).toBe('only reasoning');
  });

  it('swallows a bare closer in the middle of an answer', () => {
    expect(splitReasoning('I think</think> the rest').narration).toBe(
      'I think the rest',
    );
  });

  it('does not release reasoning that follows a nested closer', () => {
    const got = streamed('<think>a<think>b</think>c</think>D', 1);
    expect(got.narration).toBe('D');
    expect(got.reasoning).toBe('abc');
  });

  it('strips a tag that starts mid-word', () => {
    const r = splitReasoning('skip<thinking>ok');
    expect(r.narration).toBe('skip');
    expect(r.reasoning).toBe('ok');
  });

  it('strips every tag spelling, whole or chunked', () => {
    const inputs = [
      '<THINK>secret</THINK>Answer',
      '< think >secret< / think >Answer',
      'Answer',
      '<antml:thought>secret</antml:thought>Answer',
      '<think> a="1" >secret</think>Answer',
      '<REASONING>secret</REASONING>Answer',
    ];
    for (const input of inputs) {
      expect(splitReasoning(input).narration, input).toBe('Answer');
      expect(streamed(input, 1).narration, input).toBe('Answer');
      expect(streamed(input, input.length).narration, input).toBe('Answer');
    }
  });

  it('releases no reasoning at any split offset', () => {
    const input = '<think>reasoning here</think>Visible answer.';
    for (let cut = 1; cut < input.length; cut += 1) {
      const filter = new ReasoningFilter();
      const narration =
        text(filter.push(input.slice(0, cut))) +
        text(filter.push(input.slice(cut))) +
        text(filter.finish());
      expect(narration, `cut ${cut}`).toBe('Visible answer.');
      expect(filter.reasoning, `cut ${cut}`).toBe('reasoning here');
    }
  });

  it('yields no answer when the whole response is reasoning', () => {
    for (const input of [
      '<think>the user asked about a thing and then',
      '<think>a</think><think>b</think>',
    ]) {
      const r = splitReasoning(input);
      expect(r.narration, input).toBe('');
      expect(r.reasoning, input).not.toBe('');
    }
  });
});

describe('over-stripping: ordinary text survives intact', () => {
  it('keeps prose that only mentions thinking', () => {
    const input =
      'I think we should use the internal table and rethink the approach.';
    expect(splitReasoning(input).narration).toBe(input);
    expect(streamed(input, 1).narration).toBe(input);
  });

  it('keeps JSON, including reasoning-ish keys', () => {
    const input = '{"think": true, "reasoning": "x", "value": 1}';
    expect(splitReasoning(input).narration).toBe(input);
    expect(streamed(input, 1).narration).toBe(input);
  });

  it('keeps HTML, including names that merely start like a tag name', () => {
    const inputs = [
      '<div class="internal">hi</div>',
      '<internal-link>docs</internal-link>',
      'The <thinker> element. Done.',
      '<p>Use &lt;think&gt; to reason.</p>',
    ];
    for (const input of inputs) {
      expect(splitReasoning(input).narration, input).toBe(input);
      expect(streamed(input, 1).narration, input).toBe(input);
    }
  });

  it('keeps a fenced block literal at every chunk size', () => {
    const input = 'Example:\n```html\n<think>literal</think>\n```\nDone.';
    expect(splitReasoning(input).narration).toBe(input);
    for (let size = 1; size <= input.length; size += 1) {
      expect(streamed(input, size).narration, `size ${size}`).toBe(input);
    }
  });

  it('keeps a longer fence literal, opener and closer included', () => {
    const input = '````\n<think>literal</think>\n````\nDone.';
    expect(splitReasoning(input).narration).toBe(input);
    for (let size = 1; size <= input.length; size += 1) {
      expect(streamed(input, size).narration, `size ${size}`).toBe(input);
    }
  });

  it('keeps an unterminated fence literal to the end of the stream', () => {
    const input = '```\n<think>literal</think>\nno closer here';
    expect(splitReasoning(input).narration).toBe(input);
    for (let size = 1; size <= input.length; size += 1) {
      expect(streamed(input, size).narration, `size ${size}`).toBe(input);
    }
  });

  it('keeps a fence that closes in a later chunk literal', () => {
    // The opener arrives before its closer exists, so the fence has to be state
    // rather than a scan of the current buffer.
    const filter = new ReasoningFilter();
    expect(text(filter.push('```\n<think>code sample'))).toBe(
      '```\n<think>code sample',
    );
    // The fence closes, so the tags after it are live again and are stripped.
    expect(text(filter.push('\n```\n<think>Answer'))).toBe('\n```\n');
    expect(filter.reasoning).toBe('Answer');
    expect(text(filter.finish())).toBe('');
  });

  it('keeps inline backticks as text', () => {
    const input = 'Use `code` and a `` pair inline.';
    expect(splitReasoning(input).narration).toBe(input);
    expect(streamed(input, 1).narration).toBe(input);
  });

  it('keeps comparisons and stray angle brackets', () => {
    for (const input of ['a < b', '5 < 6 and 7 > 6', 'x <', '<>']) {
      expect(splitReasoning(input).narration, input).toBe(input);
      expect(streamed(input, 1).narration, input).toBe(input);
    }
  });
});

describe('transport invariance', () => {
  const shapes: readonly {
    readonly name: string;
    readonly input: string;
    readonly options: { readonly expectsInlineReasoning?: boolean };
  }[] = [
    {
      name: 'complete block',
      input: '<think>why not</think>Because.',
      options: {},
    },
    {
      name: 'bare closer',
      input: 'Let me see the file first.</think>Because.',
      options: { expectsInlineReasoning: true },
    },
    {
      name: 'unterminated block',
      input: '<think>why not</think>',
      options: {},
    },
    {
      name: 'prose, tags and a fence together',
      input: 'a < b\n```\n<think>x</think>\n```\n<think>r</think>done',
      options: {},
    },
  ];

  for (const shape of shapes) {
    it(`agrees with the whole-string call at every size of a ${shape.name}`, () => {
      const baseline = splitReasoning(shape.input, shape.options);
      for (let size = 1; size <= shape.input.length; size += 1) {
        const got = streamed(shape.input, size, shape.options);
        expect(got.narration, `size ${size}`).toBe(baseline.narration);
        expect(got.reasoning, `size ${size}`).toBe(baseline.reasoning);
      }
    });
  }
});

describe('loop safety', () => {
  const adversarial: readonly string[] = [
    '',
    '<',
    '</',
    '<mm:',
    '<antml:',
    '<think>'.repeat(500),
    '<'.repeat(5000),
    '</'.repeat(5000),
    '`'.repeat(5000),
    '<think>' + '<'.repeat(2000),
    '<think>' + '```\n' + 'no closer '.repeat(200),
    'plain text '.repeat(500),
  ];

  it('terminates and agrees with the whole-string call', () => {
    for (const input of adversarial) {
      const baseline = splitReasoning(input);
      for (const size of [1, 3, 1024]) {
        const got = streamed(input, size);
        expect(got.narration, `len ${input.length} size ${size}`).toBe(
          baseline.narration,
        );
        expect(got.reasoning, `len ${input.length} size ${size}`).toBe(
          baseline.reasoning,
        );
      }
    }
  });

  it('never leaks reasoning behind a long run of angle brackets', () => {
    const input = '<'.repeat(50) + '<think>secret</think>visible';
    for (let size = 1; size <= 12; size += 1) {
      const got = streamed(input, size);
      expect(got.narration, `size ${size}`).not.toContain('secret');
      expect(got.reasoning, `size ${size}`).toBe('secret');
    }
  });
});

describe('instance independence', () => {
  it('does not carry state from one response into the next', () => {
    const shared = new ReasoningFilter();
    const run = (input: string): string =>
      text([...shared.push(input), ...shared.finish()]);
    expect(run('<think>first</think>One.')).toBe('One.');
    expect(run('<think>second</think>Two.')).toBe('Two.');
    expect(shared.reasoning).toBe('firstsecond');
  });

  it('keeps two filters independent', () => {
    const first = new ReasoningFilter();
    first.push('<think>first trace that never ends');
    const second = new ReasoningFilter();
    const released = second.push('<think>second trace</think>Second answer.');

    expect(first.reasoning).toBe('first trace that never ends');
    expect(text(first.finish())).toBe('');
    expect(first.producedAnswer).toBe(false);

    expect(second.reasoning).toBe('second trace');
    expect(text(released) + text(second.finish())).toBe('Second answer.');
    expect(second.producedAnswer).toBe(true);
  });
});
