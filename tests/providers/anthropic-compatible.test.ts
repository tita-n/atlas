import { describe, expect, it, vi } from 'vitest';
import { AnthropicCompatibleProvider } from '../../src/providers/anthropic-compatible.js';
import {
  ProviderAPIError,
  ProviderNetworkError,
  ProviderResponseError,
} from '../../src/errors.js';

describe('AnthropicCompatibleProvider', () => {
  it('moves system prompts to the top-level field and maps the response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'claude-test',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' from Anthropic' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://proxy.example/v1/',
      dependencies: { fetch: fetchMock },
    });

    const result = await provider.chatCompletion({
      model: 'claude-test',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'system', content: 'Be concise.' },
      ],
      temperature: 0.1,
    });

    expect(result).toEqual({
      content: 'Hello from Anthropic',
      model: 'claude-test',
      stopReason: 'end_turn',
      usage: { inputTokens: 7, outputTokens: 4 },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://proxy.example/v1/messages');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe('secret');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 4096,
      stream: false,
      system: 'Be concise.',
      temperature: 0.1,
    });
  });

  it('translates structured tool calls and tool results', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'claude-test',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'shell',
              input: { command: 'pwd' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock },
    });
    const result = await provider.chatCompletion({
      model: 'claude-test',
      messages: [
        { role: 'user', content: 'Where am I?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } },
          ],
        },
        { role: 'tool', toolCallId: 'tool-1', content: '/tmp' },
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
      { id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } },
    ]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        name: 'shell',
        description: 'Run a command',
        input_schema: { type: 'object' },
      },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'Where am I?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'shell',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: '/tmp',
          },
        ],
      },
    ]);
  });

  it('includes redacted provider details for HTTP errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'secret model rejected' } }),
        {
          status: 400,
          statusText: 'Bad Request',
        },
      ),
    );
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock },
    });

    const error = await provider
      .chatCompletion({ model: 'bad', messages: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAPIError);
    if (error instanceof ProviderAPIError) {
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain('[REDACTED] model rejected');
      expect(error.message).not.toContain('secret');
    }
  });

  it('wraps transport failures', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('offline'));
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'model', messages: [] }),
    ).rejects.toBeInstanceOf(ProviderNetworkError);
  });

  it('rejects malformed successful responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ model: 'model', content: [] }), {
        status: 200,
      }),
    );
    const provider = new AnthropicCompatibleProvider({
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
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const provider = new AnthropicCompatibleProvider({
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

    expect(chunks).toEqual(['Hi']);
  });
});
