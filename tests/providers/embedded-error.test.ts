import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { AnthropicCompatibleProvider } from '../../src/providers/anthropic-compatible.js';
import { ProviderAPIError } from '../../src/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A 200 response whose body carries the real failure. Gateways and providers
 * do this, and it must never be reported as a schema mismatch.
 */
const EMBEDDED_502 = {
  id: 'gen-1234',
  error: {
    message: 'JSON error injected into SSE stream',
    code: 502,
    metadata: { error_type: 'provider_unavailable' },
  },
};

describe('error embedded in a 200 response (OpenAI-compatible)', () => {
  it('reports the real cause instead of a schema mismatch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(EMBEDDED_502)));
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'm', messages: [] }),
    ).rejects.toThrow(/JSON error injected into SSE stream/);
  });

  it('never claims the payload did not match the schema', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(EMBEDDED_502)));
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'm', messages: [] }),
    ).rejects.not.toThrow(/does not match the OpenAI chat completions schema/);
  });

  it('retries a transient embedded 502 and succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(EMBEDDED_502))
      .mockResolvedValueOnce(
        jsonResponse({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'Recovered' } }],
        }),
      );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    const result = await provider.chatCompletion({ model: 'm', messages: [] });
    expect(result.content).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient embedded failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ error: { message: 'bad model', code: 400 } }),
        ),
      );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'm', messages: [] }),
    ).rejects.toBeInstanceOf(ProviderAPIError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles an error given as a plain string', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ error: 'upstream exploded' })),
      );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'm', messages: [] }),
    ).rejects.toThrow(/upstream exploded/);
  });
});

describe('error embedded in a 200 response (Anthropic-compatible)', () => {
  it('reports the real cause instead of a schema mismatch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(EMBEDDED_502)));
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.anthropic.test',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'claude', messages: [] }),
    ).rejects.toThrow(/JSON error injected into SSE stream/);
  });

  it('retries a transient embedded 502 and succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(EMBEDDED_502))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'Recovered' }],
          stop_reason: 'end_turn',
        }),
      );
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.anthropic.test',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    const result = await provider.chatCompletion({
      model: 'claude',
      messages: [],
    });
    expect(result.content).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a structurally invalid body, matching the OpenAI path', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'truncated' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'Recovered' }],
          stop_reason: 'end_turn',
        }),
      );
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.anthropic.test',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    const result = await provider.chatCompletion({
      model: 'claude',
      messages: [],
    });
    expect(result.content).toBe('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names the offending field when the body is unusable', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ id: 'x', content: 'not-a-list' })),
      );
    const provider = new AnthropicCompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.anthropic.test',
      dependencies: { fetch: fetchMock, retryDelayMs: 0 },
    });

    await expect(
      provider.chatCompletion({ model: 'claude', messages: [] }),
    ).rejects.toThrow(/content/);
  });
});
