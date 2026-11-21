import { describe, expect, it, vi } from 'vitest';

import { validateApiKey } from '../../src/providers/key-validation.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const input = {
  provider: 'openai-compatible' as const,
  apiKey: 'test-secret-key',
  baseUrl: 'https://api.example.test/v1',
  model: 'example-chat-model',
};

describe('validateApiKey', () => {
  it('accepts a key from the free models-list probe without making a completion', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(200, { data: [{ id: 'example-chat-model' }] }),
      );

    await expect(validateApiKey({ ...input, fetchImpl })).resolves.toEqual({
      status: 'accepted',
      probe: 'models',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret-key' },
      }),
    );
  });

  it('rejects an invalid key from the models endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(401, {
        error: { code: 'invalid_api_key', message: 'bad key' },
      }),
    );

    const result = await validateApiKey({ ...input, fetchImpl });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('authentication failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to one minimal completion when models is unsupported', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(404, { error: { message: 'not found' } }))
      .mockResolvedValueOnce(response(200, { choices: [] }));

    await expect(validateApiKey({ ...input, fetchImpl })).resolves.toEqual({
      status: 'accepted',
      probe: 'completion',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.example.test/v1/chat/completions',
    );
    const request = fetchImpl.mock.calls[1]?.[1];
    const requestBody = request?.body;
    expect(typeof requestBody).toBe('string');
    expect(JSON.parse(requestBody as string)).toMatchObject({
      model: input.model,
      max_tokens: 1,
    });
  });

  it('accepts a valid key without balance on OpenAI insufficient_quota', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(
        response(429, {
          error: {
            code: 'insufficient_quota',
            message: 'You exceeded your current quota.',
          },
        }),
      );

    const result = await validateApiKey({ ...input, fetchImpl });
    expect(result.status).toBe('accepted-no-balance');
    expect(result.message).toContain('Top up');
  });

  it('accepts a valid key without balance on Anthropic credit exhaustion', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(
        response(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Your credit balance is too low to access the Anthropic API.',
          },
        }),
      );

    const result = await validateApiKey({
      ...input,
      provider: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test',
      fetchImpl,
    });
    expect(result.status).toBe('accepted-no-balance');
    expect(result.probe).toBe('completion');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: {
          'x-api-key': input.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }),
    );
  });

  it('treats explicit invalid-key codes as rejection even on HTTP 403', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(403, {
        error: { code: 'API_KEY_INVALID', message: 'key rejected' },
      }),
    );

    const result = await validateApiKey({ ...input, fetchImpl });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('authentication failed');
  });

  it('treats a billing-flavoured 403 as accepted-no-balance', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(403, {
        error: {
          status: 'PERMISSION_DENIED',
          message: 'Billing account is disabled for this free tier.',
        },
      }),
    );

    const result = await validateApiKey({ ...input, fetchImpl });
    expect(result.status).toBe('accepted-no-balance');
    expect(result.probe).toBe('models');
  });

  it('reports transport failure as unverifiable, not as a bad key', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('network offline'));

    const result = await validateApiKey({ ...input, fetchImpl });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('Could not reach');
    expect(result.message).toContain('network offline');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
