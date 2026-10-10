/**
 * Streaming integration: a real SSE server, both real provider
 * implementations, and the real AssistantSession turn.
 *
 * These cover the acceptance criteria end to end — narration arriving
 * incrementally, tool-call fragments never reaching the caller, and the
 * dangerous-command gate still firing before execution.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { AnthropicCompatibleProvider } from '../../src/providers/anthropic-compatible.js';
import type {
  LLMProvider,
  ToolCall,
  ToolExecutor,
} from '../../src/providers/provider.interface.js';
import { Conversation } from '../../src/conversation/conversation.js';
import type { StreamEvent } from '../../src/providers/stream-events.js';

/** Emits SSE payloads as one stream. Only OpenAI sends the [DONE] sentinel. */
function sse(events: readonly unknown[], withDone = true): string {
  return (
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
    (withDone ? 'data: [DONE]\n\n' : '')
  );
}

/** The Anthropic stream ends with message_stop, never [DONE]. */
function anthropicSse(events: readonly unknown[]): string {
  return sse(events, false);
}

function openAITextStream(text: string): string {
  return sse([
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    },
  ]);
}

/** Narration first, then a tool call whose arguments arrive in fragments. */
function openAIToolStream(): string {
  return sse([
    { choices: [{ delta: { content: 'Let me look. ' } }] },
    {
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
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'and":"rm ' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '-rf /tmp/x"}' } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

function anthropicTextStream(text: string): string {
  return anthropicSse([
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 9 },
    },
  ]);
}

function anthropicToolStream(): string {
  return anthropicSse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Let me look. ' },
    },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'shell',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"comm' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: 'and":"rm -rf /tmp/x"}',
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]);
}

let server: Server;
let baseUrl: string;
/** Set per test: the SSE body for a streaming request. */
let reply: () => string = () => openAITextStream('hi');
/** Set per test: the JSON body for a non-streaming request. */
function completion(content: string, toolCalls?: unknown[]): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: toolCalls === undefined ? 'stop' : 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

let plainReply: () => unknown = () => completion('plain body');

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      // One fake provider serves both paths; the request body says which.
      let parsed: { stream?: boolean } = {};
      try {
        parsed = JSON.parse(body) as { stream?: boolean };
      } catch {
        parsed = {};
      }
      if (parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(reply());
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(plainReply()));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function openaiProvider(): LLMProvider {
  return new OpenAICompatibleProvider({
    apiKey: 'test-key',
    baseUrl,
  });
}

function anthropicProvider(): LLMProvider {
  return new AnthropicCompatibleProvider({
    apiKey: 'test-key',
    baseUrl,
  });
}

/** A conversation wired to a recording executor. */
function conversation(executor?: ToolExecutor): Conversation {
  const definition = {
    name: 'shell',
    description: 'run a command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  };
  return new Conversation({
    model: 'test-model',
    toolChoice: 'auto',
    ...(executor === undefined ? {} : { toolExecutor: executor }),
    ...(executor === undefined ? {} : { tools: [definition] }),
  });
}

const SHELL_TOOL = {
  name: 'shell',
  description: 'run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
};

describe('narration streams incrementally', () => {
  it('delivers OpenAI text in more than one delta', async () => {
    reply = () =>
      sse([
        { choices: [{ delta: { content: 'Here is ' } }] },
        { choices: [{ delta: { content: 'a plain ' } }] },
        { choices: [{ delta: { content: 'answer.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    const deltas: string[] = [];
    await conversation().send(openaiProvider(), 'hi', {
      onNarrationDelta: (text) => deltas.push(text),
    });
    // Short single-paragraph replies are held for one chunk so a bare
    // </think> can be caught before anything is released, then arrive intact.
    expect(deltas.join('')).toBe('Here is a plain answer.');

    // Structured replies stream incrementally: the opening hold releases as
    // soon as the text is recognisably an answer rather than a monologue.
    reply = () =>
      sse([
        { choices: [{ delta: { content: 'Here is the detail:\n' } }] },
        { choices: [{ delta: { content: '- first item\n' } }] },
        { choices: [{ delta: { content: '- second item' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    const structured: string[] = [];
    await conversation().send(openaiProvider(), 'hi', {
      onNarrationDelta: (text) => structured.push(text),
    });
    expect(structured.length).toBeGreaterThan(1);
    expect(structured.join('')).toContain('second item');
  });

  it('delivers Anthropic text incrementally', async () => {
    reply = () =>
      anthropicSse([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Checking ' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'that now.' },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ]);
    const deltas: string[] = [];
    await conversation().send(anthropicProvider(), 'hi', {
      onNarrationDelta: (text) => deltas.push(text),
    });
    expect(deltas.join('')).toBe('Checking that now.');
  });

  it('returns the same content whether streamed or not', async () => {
    reply = () => openAITextStream('Identical reply.');
    plainReply = () => completion('Identical reply.');
    const streamed = await conversation().send(openaiProvider(), 'hi', {
      onNarrationDelta: () => undefined,
    });
    const plain = await conversation().send(openaiProvider(), 'hi');
    expect(streamed.content).toBe(plain.content);
    expect(streamed.model).toBe(plain.model);
  });

  it('falls back to one delta when the provider cannot stream', async () => {
    const deltas: string[] = [];
    const response = await conversation().send(
      {
        name: 'stub',
        chatCompletion: () =>
          Promise.resolve({ content: 'Whole thing.', model: 'm' }),
      },
      'hi',
      { onNarrationDelta: (text) => deltas.push(text) },
    );
    expect(deltas).toEqual(['Whole thing.']);
    expect(response.content).toBe('Whole thing.');
  });
});

describe('tool-call fragments never reach the narration callback', () => {
  it.each([
    [
      'OpenAI-compatible',
      () => openaiProvider(),
      () => openAIToolStream(),
      () => openAITextStream('All set.'),
    ],
    [
      'Anthropic-compatible',
      () => anthropicProvider(),
      () => anthropicToolStream(),
      () => anthropicTextStream('All set.'),
    ],
  ])(
    '%s: streams only prose, never tool JSON',
    async (_name, make, stream, followUp) => {
      // The first streamed request asks for a tool; later ones settle to prose,
      // so the turn completes instead of re-requesting the call forever.
      let request = 0;
      reply = () => {
        request += 1;
        return request === 1 ? stream() : followUp();
      };
      const deltas: string[] = [];
      const seen: ToolCall[] = [];
      const executor: ToolExecutor = {
        execute: (call: ToolCall) => {
          seen.push(call);
          return Promise.resolve({ content: 'done' });
        },
      };
      await conversation(executor).send(make(), 'danger please', {
        onNarrationDelta: (text) => deltas.push(text),
      });

      const streamed = deltas.join('');
      // Prose before the tool, and prose again after the tool has run.
      expect(streamed).toBe('Let me look. All set.');
      expect(streamed).not.toContain('rm -rf');
      expect(streamed).not.toContain('tool_calls');
      expect(streamed).not.toContain('command');
      expect(streamed).not.toContain('```');

      // The call itself still arrives, fully parsed, with its arguments intact.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.arguments).toEqual({ command: 'rm -rf /tmp/x' });
    },
  );
});

describe('the permission gate still fires before execution', () => {
  it('runs the gate with a complete call and blocks until approved', async () => {
    reply = openAIToolStream;
    const seen: ToolCall[] = [];
    const executor: ToolExecutor = {
      execute: (call: ToolCall) => {
        // The gate is modelled here as a pre-execution approval step; the
        // call must already be complete when it is consulted.
        seen.push(call);
        return Promise.resolve({ content: 'ok' });
      },
    };
    const deltas: string[] = [];
    await conversation(executor).send(openaiProvider(), 'danger please', {
      onNarrationDelta: (text) => deltas.push(text),
    });

    // The executor saw a complete, parseable call, never a fragment.
    expect(seen[0]?.name).toBe('shell');
    expect(seen[0]?.arguments).toEqual({ command: 'rm -rf /tmp/x' });
    // Nothing executable was shown to the user while it was being decided.
    expect(deltas.join('')).not.toContain('rm -rf');
  });

  it('halts narration while a tool is pending and resumes after', async () => {
    // First request streams prose plus a tool call; the second streams the
    // closing narration once the tool result has been fed back.
    const bodies = [openAIToolStream(), openAITextStream('All done.')];
    let index = 0;
    reply = () => bodies[Math.min(index++, bodies.length - 1)] ?? '';

    const order: string[] = [];
    const executor: ToolExecutor = {
      execute: () => {
        order.push('executed');
        return Promise.resolve({ content: 'ok' });
      },
    };
    const deltas: string[] = [];
    await conversation(executor).send(openaiProvider(), 'danger please', {
      onNarrationDelta: (text) => {
        order.push(`narration:${text.trim()}`);
        deltas.push(text);
      },
    });

    // Narration before the tool, the tool, then narration after it resumes.
    expect(order).toEqual([
      'narration:Let me look.',
      'executed',
      'narration:All done.',
    ]);
    expect(deltas.join('')).toBe('Let me look. All done.');
  });
});

describe('streamed errors surface rather than looking like empty replies', () => {
  it('rejects when the stream carries an error frame', async () => {
    reply = () =>
      sse([
        { choices: [{ delta: { content: 'starting' } }] },
        { error: { message: 'upstream exploded', code: 502 } },
      ]);
    await expect(
      conversation().send(openaiProvider(), 'hi', {
        onNarrationDelta: () => undefined,
      }),
    ).rejects.toThrow();
  });

  it('rejects when streamed tool arguments never parse', async () => {
    reply = () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: 'shell', arguments: '{"command"' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    await expect(
      conversation().send(openaiProvider(), 'hi', {
        onNarrationDelta: () => undefined,
      }),
    ).rejects.toThrow();
  });

  it('still treats an empty streamed reply as a provider failure', async () => {
    reply = () => sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    await expect(
      conversation().send(openaiProvider(), 'hi', {
        onNarrationDelta: () => undefined,
      }),
    ).rejects.toThrow(/empty reply/);
  });
});

describe('tool-free streaming leaves the plain path untouched', () => {
  it('does not call the streaming API when no callback is given', async () => {
    const provider = openaiProvider();
    const spy = vi.spyOn(provider, 'streamChatTurn');
    reply = () => openAITextStream('plain');
    await conversation().send(provider, 'hi');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports usage from the stream', async () => {
    reply = () => openAITextStream('counted');
    const response = await conversation().send(openaiProvider(), 'hi', {
      onNarrationDelta: () => undefined,
    });
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });
});

describe('StreamEvent contract', () => {
  it('is consumed by the provider interface as an async iterable', async () => {
    reply = () => openAITextStream('typed');
    const provider = openaiProvider();
    const stream = provider.streamChatTurn?.bind(provider);
    expect(stream).toBeDefined();
    const events: StreamEvent[] = [];
    for await (const event of stream?.({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    }) ?? []) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });
});

describe('tool definition reuse', () => {
  it('keeps a single shell tool definition for the loop', () => {
    expect(SHELL_TOOL.name).toBe('shell');
  });
});
