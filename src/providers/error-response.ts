import { ProviderAPIError } from '../errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function redactProviderText(text: string, apiKey: string): string {
  const withoutKey =
    apiKey === '' ? text : text.split(apiKey).join('[REDACTED]');
  return withoutKey
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function extractProviderMessage(
  body: string,
  apiKey: string,
): string | undefined {
  if (body.trim() === '') return undefined;

  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const errorValue = parsed.error;
      if (typeof errorValue === 'string') {
        detail = errorValue;
      } else if (
        isRecord(errorValue) &&
        typeof errorValue.message === 'string'
      ) {
        detail = errorValue.message;
      } else if (typeof parsed.message === 'string') {
        detail = parsed.message;
      }
    }
  } catch {
    detail = body;
  }

  const safeDetail = redactProviderText(detail, apiKey);
  return safeDetail === '' ? undefined : safeDetail;
}

/** Converts an HTTP error response into a typed, redacted provider error. */
export async function providerApiError(
  response: Response,
  providerName: string,
  apiKey: string,
): Promise<ProviderAPIError> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  const detail = extractProviderMessage(body, apiKey);
  let message: string;

  if (response.status === 400) {
    message =
      'Provider rejected the request. Check the model and request parameters.';
  } else if (response.status === 401 || response.status === 403) {
    message = 'Provider authentication failed. Check the configured API key.';
  } else if (response.status === 404) {
    message =
      'Provider endpoint or model not found. Check the base URL and model.';
  } else if (response.status === 408 || response.status === 504) {
    message = 'Provider request timed out or is temporarily unavailable.';
  } else if (response.status === 429) {
    message = 'Provider rate limit reached. Wait before trying again.';
  } else if (response.status >= 500) {
    message = 'Provider service is temporarily unavailable.';
  } else {
    message = 'Provider rejected the request.';
  }

  if (detail !== undefined) message += ` Provider response: ${detail}`;
  return new ProviderAPIError(
    providerName,
    response.status,
    response.statusText,
    message,
  );
}

/** An error a gateway embedded in an otherwise successful HTTP response. */
export interface EmbeddedProviderError {
  /** Redacted, human-readable detail. */
  readonly message: string;
  /** Numeric code the gateway reported, when it looked like an HTTP status. */
  readonly statusCode: number | undefined;
}

function asStatusCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

/**
 * Detects an error object returned inside a 2xx response body.
 *
 * Some gateways answer `200 OK` while embedding the real failure in the body,
 * for example `{"id":"gen-…","error":{"message":"…","code":502}}`. Without
 * this check the payload falls through to schema validation and the user sees
 * a misleading "does not match schema" message instead of the real cause.
 */
export function embeddedProviderError(
  payload: unknown,
  apiKey: string,
): EmbeddedProviderError | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (typeof error === 'string') {
    return {
      message: redactProviderText(error, apiKey),
      statusCode: undefined,
    };
  }
  if (!isRecord(error)) return undefined;
  const message =
    typeof error.message === 'string' ? error.message : JSON.stringify(error);
  const statusCode =
    asStatusCode(error.code) ?? asStatusCode(error.status) ?? undefined;
  return {
    message: redactProviderText(message, apiKey),
    statusCode,
  };
}

/** Builds the error thrown when a 2xx body actually carries a failure. */
export function embeddedErrorToApiError(
  embedded: EmbeddedProviderError,
  providerName: string,
): ProviderAPIError {
  const status = embedded.statusCode;
  const prefix =
    status === undefined
      ? 'Provider returned an error'
      : `Provider returned an error (${status})`;
  return new ProviderAPIError(
    providerName,
    // A gateway that embedded a failure without a code still needs a
    // non-2xx value, so the retry logic treats it as a server-side fault.
    status ?? 502,
    'Embedded provider error',
    `${prefix}: ${embedded.message}`,
  );
}
