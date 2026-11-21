import { describe, expect, it } from 'vitest';

import { ProviderAPIError } from '../../src/errors.js';
import {
  classifyProviderFailure,
  embeddedErrorToApiError,
  embeddedProviderError,
  providerApiError,
  PROVIDER_AUTH_FAILED_MESSAGE,
  PROVIDER_NO_BALANCE_MESSAGE,
} from '../../src/providers/error-response.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('provider failure classification', () => {
  it('distinguishes auth from balance failures across provider status conventions', () => {
    expect(classifyProviderFailure(401, 'unauthorized', undefined)).toBe(
      'auth',
    );
    expect(
      classifyProviderFailure(429, 'You exceeded quota', 'insufficient_quota'),
    ).toBe('billing');
    expect(
      classifyProviderFailure(400, 'credit balance is too low', undefined),
    ).toBe('billing');
    expect(
      classifyProviderFailure(
        403,
        'Billing account disabled',
        'PERMISSION_DENIED',
      ),
    ).toBe('billing');
    expect(classifyProviderFailure(403, 'permission denied', undefined)).toBe(
      'other',
    );
  });

  it('does not call a generic 403 an authentication failure', async () => {
    const error = await providerApiError(
      response(403, { error: { message: 'permission denied' } }),
      'test-provider',
      '',
    );
    expect(error).toBeInstanceOf(ProviderAPIError);
    expect(error.message).not.toContain(PROVIDER_AUTH_FAILED_MESSAGE);
  });

  it('maps quota and balance failures to top-up guidance, not auth failure', async () => {
    for (const [status, body] of [
      [429, { error: { code: 'insufficient_quota', message: 'quota empty' } }],
      [400, { error: { message: 'credit balance is too low' } }],
      [403, { error: { message: 'billing account disabled' } }],
    ] as const) {
      const error = await providerApiError(
        response(status, body),
        'test-provider',
        '',
      );
      expect(error.message).toContain(PROVIDER_NO_BALANCE_MESSAGE);
      expect(error.message).not.toContain(PROVIDER_AUTH_FAILED_MESSAGE);
    }
  });

  it('keeps a 401 as an authentication failure and redacts the key', async () => {
    const key = 'test-secret-key-value';
    const error = await providerApiError(
      response(401, { error: { message: `invalid key ${key}` } }),
      'test-provider',
      key,
    );
    expect(error.message).toContain(PROVIDER_AUTH_FAILED_MESSAGE);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain('[REDACTED]');
  });

  it('extracts codes from provider error bodies', async () => {
    const error = await providerApiError(
      response(429, {
        error: { type: 'insufficient_quota', message: 'quota empty' },
      }),
      'test-provider',
      '',
    );
    expect(error.message).toContain(PROVIDER_NO_BALANCE_MESSAGE);
  });

  it('classifies embedded provider errors without losing redaction', () => {
    const embedded = embeddedProviderError(
      {
        error: { message: 'credit balance too low; key test-secret-key-value' },
      },
      'test-secret-key-value',
    );
    expect(embedded?.message).not.toContain('test-secret-key-value');
    expect(embedded?.message).toContain('[REDACTED]');
    if (embedded === undefined) throw new Error('expected embedded error');
    expect(
      embeddedErrorToApiError(embedded, 'test-provider').message,
    ).toContain('credit balance too low');
  });
});
