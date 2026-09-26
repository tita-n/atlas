import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import {
  ProviderAPIError,
  ProviderNetworkError,
  ProviderResponseError,
} from '../../src/errors.js';

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('translates a completion request and response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        model: 'gpt-test',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from OpenAI' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      }),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://proxy.example/v1/',
      dependencies: { fetch: fetchMock },
    });

    const result = await provider.chatCompletion({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
      maxTokens: 64,
      temperature: 0.2,
    });

    expect(result).toEqual({
      content: 'Hello from OpenAI',
      model: 'gpt-test',
      usage: { inputTokens: 8, outputTokens: 3 },
      stopReason: 'stop',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://proxy.example/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer secret',
    );
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: false,
      max_tokens: 64,
      temperature: 0.2,
    });
  });

  it('maps HTTP errors without exposing response contents', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('secret leaked by server', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock },
    });

    const error = await provider
      .chatCompletion({ model: 'bad', messages: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAPIError);
    if (error instanceof ProviderAPIError) {
      expect(error.statusCode).toBe(401);
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain('secret');
    }
  });

  it('wraps transport failures', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('offline'));
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'model', messages: [] }),
    ).rejects.toBeInstanceOf(ProviderNetworkError);
  });

  it('translates structured tool calls and tool results', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        model: 'gpt-test',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'shell',
                    arguments: '{"command":"pwd"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock },
    });
    const result = await provider.chatCompletion({
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'Where am I?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', content: '/tmp' },
      ],
      tools: [
        {
          name: 'shell',
          description: 'Run a command',
          parameters: { type: 'object' },
        },
      ],
    });

    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
    ]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'Run a command',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'Where am I?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"pwd"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '/tmp' },
    ]);
  });

  it('recovers from a transient transport failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        response({
          model: 'model',
          choices: [{ message: { role: 'assistant', content: 'recovered' } }],
        }),
      );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 1, retryDelayMs: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'model', messages: [] }),
    ).resolves.toMatchObject({ content: 'recovered' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies nested transport causes', async () => {
    const socketError = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    const aggregateError = new AggregateError(
      [socketError],
      'all connection attempts failed',
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: aggregateError }),
      );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    const error = await provider
      .chatCompletion({ model: 'model', messages: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderNetworkError);
    if (error instanceof ProviderNetworkError) {
      expect(error.kind).toBe('connection');
      expect(error.message).toContain('ECONNRESET');
    }
  });

  it('rejects malformed successful responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ model: 'model', choices: [] }));
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock },
    });

    await expect(
      provider.chatCompletion({ model: 'model', messages: [] }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('streams text deltas from SSE', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock },
    });
    const chunks: string[] = [];

    for await (const chunk of provider.streamChatCompletion?.({
      model: 'model',
      messages: [],
    }) ?? []) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hel', 'lo']);
  });

  it('retries once when the provider returns a structurally invalid body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 'truncated' }))
      .mockResolvedValueOnce(
        response({
          model: 'gpt-test',
          choices: [
            {
              message: { role: 'assistant', content: 'Recovered' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    const result = await provider.chatCompletion({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.content).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names the offending field when the response is unusable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        response({
          model: 'gpt-test',
          choices: [{ message: { role: 'assistant', content: 42 } }],
        }),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'gpt-test', messages: [] }),
    ).rejects.toThrow(/choices\.0\.message\.content/);
  });
});
