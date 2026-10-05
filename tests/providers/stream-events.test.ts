import { describe, expect, it } from 'vitest';

import {
  AnthropicStreamAssembler,
  OpenAIStreamAssembler,
  type StreamEvent,
} from '../../src/providers/stream-events.js';
import { ProviderResponseError } from '../../src/errors.js';

function texts(events: readonly StreamEvent[]): string {
  return events
    .filter(
      (e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text',
    )
    .map((e) => e.text)
    .join('');
}

function calls(events: readonly StreamEvent[]): unknown[] {
  return events
    .filter(
      (e): e is Extract<StreamEvent, { type: 'tool_calls' }> =>
        e.type === 'tool_calls',
    )
    .flatMap((e) => e.toolCalls);
}

describe('OpenAI-compatible streaming', () => {
  it('emits narration text as each delta arrives', () => {
    const a = new OpenAIStreamAssembler('test');
    expect(texts(a.push({ choices: [{ delta: { content: 'Hello' } }] }))).toBe(
      'Hello',
    );
    expect(texts(a.push({ choices: [{ delta: { content: ' there' } }] }))).toBe(
      ' there',
    );
  });

  it('assembles a tool call from fragments split across chunks', () => {
    const a = new OpenAIStreamAssembler('test');
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'shell', arguments: '{"comm' },
              },
            ],
          },
        },
      ],
    });
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'and":"ls' } }],
          },
        },
      ],
    });
    a.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] },
        },
      ],
    });
    const finished = a.finish();
    expect(calls(finished)).toEqual([
      { id: 'call_1', name: 'shell', arguments: { command: 'ls' } },
    ]);
  });

  it('never emits tool-call fragments as text', () => {
    const a = new OpenAIStreamAssembler('test');
    const emitted = [
      ...a.push({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'shell', arguments: '{"command":"rm ' },
                },
              ],
            },
          },
        ],
      }),
      ...a.push({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '-rf /"' } }],
            },
          },
        ],
      }),
    ];
    // Nothing resembling tool-call JSON may appear in the narration stream.
    expect(texts(emitted)).toBe('');
    expect(JSON.stringify(emitted)).not.toContain('rm -rf');
  });

  it('keeps interleaved tool calls in ascending index order', () => {
    const a = new OpenAIStreamAssembler('test');
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 1,
                id: 'b',
                function: { name: 'second', arguments: '{}' },
              },
            ],
          },
        },
      ],
    });
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'a',
                function: { name: 'first', arguments: '{}' },
              },
            ],
          },
        },
      ],
    });
    expect(calls(a.finish()).map((c) => (c as { name: string }).name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('separates narration from a tool call in the same chunk', () => {
    const a = new OpenAIStreamAssembler('test');
    const events = a.push({
      choices: [
        {
          delta: {
            content: 'Let me look.',
            tool_calls: [
              {
                index: 0,
                id: 'c',
                function: { name: 'shell', arguments: '{"command":"ls"}' },
              },
            ],
          },
        },
      ],
    });
    expect(texts(events)).toBe('Let me look.');
    expect(calls(a.finish())).toHaveLength(1);
  });

  it('reports the finish reason and usage on the terminal event', () => {
    const a = new OpenAIStreamAssembler('test');
    a.push({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const done = a.finish().at(-1);
    expect(done).toMatchObject({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it('rejects a tool call whose arguments never form valid JSON', () => {
    const a = new OpenAIStreamAssembler('test');
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: 'shell', arguments: '{"command":' },
              },
            ],
          },
        },
      ],
    });
    expect(() => a.finish()).toThrow(ProviderResponseError);
  });

  it('rejects a tool call that never received a name', () => {
    const a = new OpenAIStreamAssembler('test');
    a.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
        },
      ],
    });
    expect(() => a.finish()).toThrow(/function name/);
  });

  it('synthesizes an id when the provider omits one', () => {
    const a = new OpenAIStreamAssembler('test');
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: 'ping', arguments: '{}' } },
            ],
          },
        },
      ],
    });
    expect(calls(a.finish())[0]).toMatchObject({ id: 'call_0' });
  });

  it('ignores payloads that are not chunk-shaped', () => {
    const a = new OpenAIStreamAssembler('test');
    expect(a.push(null)).toEqual([]);
    expect(a.push('nonsense')).toEqual([]);
    expect(a.push({ choices: 'not-an-array' })).toEqual([]);
  });
});

describe('Anthropic-compatible streaming', () => {
  it('emits text_delta events as narration', () => {
    const a = new AnthropicStreamAssembler('test');
    a.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    expect(
      texts(
        a.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        }),
      ),
    ).toBe('Hi');
    expect(
      texts(
        a.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' there' },
        }),
      ),
    ).toBe(' there');
  });

  it('assembles a tool use from input_json_delta fragments at block_stop', () => {
    const a = new AnthropicStreamAssembler('test');
    a.push({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'shell',
        input: {},
      },
    });
    a.push({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"comm' },
    });
    a.push({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' },
    });
    const events = a.push({ type: 'content_block_stop', index: 1 });
    expect(calls(events)).toEqual([
      { id: 'toolu_1', name: 'shell', arguments: { command: 'ls' } },
    ]);
  });

  it('never emits input_json_delta fragments as narration', () => {
    const a = new AnthropicStreamAssembler('test');
    const emitted = [
      ...a.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'shell', input: {} },
      }),
      ...a.push({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"command":"rm -rf /"',
        },
      }),
    ];
    expect(texts(emitted)).toBe('');
    expect(JSON.stringify(emitted)).not.toContain('rm -rf');
  });

  it('does not emit the same tool block twice', () => {
    const a = new AnthropicStreamAssembler('test');
    a.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't', name: 'shell', input: {} },
    });
    a.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
    });
    expect(
      calls(a.push({ type: 'content_block_stop', index: 0 })),
    ).toHaveLength(1);
    expect(
      calls(a.push({ type: 'content_block_stop', index: 0 })),
    ).toHaveLength(0);
    expect(calls(a.finish())).toHaveLength(0);
  });

  it('falls back to an inlined input when nothing was streamed', () => {
    const a = new AnthropicStreamAssembler('test');
    a.push({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 't',
        name: 'shell',
        input: { command: 'pwd' },
      },
    });
    expect(calls(a.push({ type: 'content_block_stop', index: 0 }))).toEqual([
      { id: 't', name: 'shell', arguments: { command: 'pwd' } },
    ]);
  });

  it('recovers a tool call whose block never stopped', () => {
    const a = new AnthropicStreamAssembler('test');
    a.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't', name: 'shell', input: {} },
    });
    a.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
    });
    expect(calls(a.finish())).toHaveLength(1);
  });

  it('carries the stop reason and usage from message_delta', () => {
    const a = new AnthropicStreamAssembler('test');
    a.push({ type: 'message_start', message: { usage: { input_tokens: 11 } } });
    a.push({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    });
    expect(a.finish().at(-1)).toMatchObject({
      type: 'done',
      finishReason: 'tool_use',
      usage: { outputTokens: 5 },
    });
  });

  it('routes an error event to a provider error', () => {
    const a = new AnthropicStreamAssembler('test');
    expect(() => a.push({ type: 'error' })).not.toThrow();
  });

  it('ignores unknown block types', () => {
    const a = new AnthropicStreamAssembler('test');
    const events = [
      ...a.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      }),
      ...a.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      }),
      ...a.push({ type: 'content_block_stop', index: 0 }),
    ];
    expect(texts(events)).toBe('');
    expect(calls(a.finish())).toHaveLength(0);
  });
});

describe('stream event shape', () => {
  it('always terminates both formats with exactly one done event', () => {
    const o = new OpenAIStreamAssembler('test');
    o.push({ choices: [{ delta: { content: 'x' } }] });
    expect(o.finish().filter((e) => e.type === 'done')).toHaveLength(1);

    const a = new AnthropicStreamAssembler('test');
    a.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'x' },
    });
    expect(a.finish().filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('emits tool_calls before done', () => {
    const o = new OpenAIStreamAssembler('test');
    o.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: 'x', arguments: '{}' } },
            ],
          },
        },
      ],
    });
    const types = o.finish().map((e) => e.type);
    expect(types.indexOf('tool_calls')).toBeLessThan(types.indexOf('done'));
  });
});
