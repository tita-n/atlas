import { describe, expect, it } from 'vitest';
import { isRetryableProviderStatus } from '../../src/providers/retry.js';

describe('retryable provider statuses', () => {
  it('retries the codes providers actually return', () => {
    for (const code of [
      408,
      429,
      500,
      502,
      503,
      504,
      520,
      521,
      522,
      523,
      524,
      525,
      527,
      529, // Anthropic overloaded_error
    ]) {
      expect(isRetryableProviderStatus(code), String(code)).toBe(true);
    }
  });

  it('does not retry client-side mistakes', () => {
    for (const code of [200, 201, 204, 400, 401, 403, 404, 409, 413, 422]) {
      expect(isRetryableProviderStatus(code), String(code)).toBe(false);
    }
  });
});
