import type { ProviderNetworkError } from '../errors.js';

/** Default number of retries after the initial provider request. */
export const DEFAULT_PROVIDER_MAX_RETRIES = 2;

/** Default base delay for transient provider retries. */
export const DEFAULT_PROVIDER_RETRY_DELAY_MS = 500;

const RETRYABLE_STATUS_CODES = new Set([408, 429]);

/** Returns whether a transport failure is safe to retry for a replayable JSON request. */
export function isRetryableNetworkError(error: ProviderNetworkError): boolean {
  return (
    error.kind === 'timeout' ||
    error.kind === 'connection' ||
    error.kind === 'dns' ||
    error.kind === 'unknown'
  );
}

/**
 * Returns whether an HTTP response represents a transient provider failure.
 *
 * Every 5xx counts as transient because the request is a replayable JSON POST.
 * That covers codes outside the fixed set which providers really do return,
 * notably 529 (Anthropic's overloaded_error) and the 52x family.
 */
export function isRetryableProviderStatus(statusCode: number): boolean {
  return RETRYABLE_STATUS_CODES.has(statusCode) || statusCode >= 500;
}

/** Computes bounded exponential backoff, honoring a short Retry-After hint. */
export function providerRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  retryAfter: string | null,
): number {
  const exponentialDelay = baseDelayMs * 2 ** Math.max(0, attempt);
  const parsedRetryAfter =
    retryAfter === null ? Number.NaN : Number(retryAfter);
  const retryAfterDelay = Number.isFinite(parsedRetryAfter)
    ? parsedRetryAfter * 1000
    : 0;
  return Math.min(5000, Math.max(exponentialDelay, retryAfterDelay));
}

/** Waits for a retry delay without blocking unrelated work. */
export function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
