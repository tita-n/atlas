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

/** Message for a key the provider did not recognise. */
export const PROVIDER_AUTH_FAILED_MESSAGE =
  'Provider authentication failed. Check the configured API key.';

/**
 * Message for a key the provider recognised but cannot bill against.
 *
 * Deliberately separate from auth: a zero-balance account is a working key,
 * and telling the user to "check the API key" sends them to rotate a key that
 * was never wrong.
 */
export const PROVIDER_NO_BALANCE_MESSAGE =
  'Provider account has no available credit. Top up the account or use a free model.';

/**
 * Why a provider refused, as far as the response can say.
 *
 * The classes exist so callers can tell "wrong key" from "right key, no
 * money" from "wrong request" instead of collapsing everything into one
 * authentication-shaped message.
 */
export type ProviderFailureClass =
  | 'auth'
  | 'billing'
  | 'rate-limit'
  | 'invalid-request'
  | 'not-found'
  | 'timeout'
  | 'server'
  | 'other';

/** Explicit billing/credit language, in a code field or the message text. */
const BILLING_SIGNALS = [
  'insufficient_quota',
  'credit balance',
  'credit_balance',
  'billing',
  'payment required',
  'payment_required',
  'out of credit',
  'free tier',
] as const;

/** Explicit wrong-key language, in a code field or the message text. */
const AUTH_SIGNALS = [
  'api_key_invalid',
  'invalid api key',
  'invalid api_key',
  'invalid x-api-key',
  'invalid x_api_key',
  'unauthenticated',
  'authentication_error',
] as const;

function containsAny(text: string, signals: readonly string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

/**
 * Classifies a provider failure from its HTTP status plus whatever code and
 * message text it carried.
 *
 * Status first for the unambiguous cases (401 is auth, 402 is billing), then
 * the text signals, because the interesting real-world answers do not follow
 * the textbook: OpenAI reports an empty balance as 429 `insufficient_quota`,
 * Anthropic as 400 "credit balance is too low", Gemini as 403
 * `PERMISSION_DENIED` mentioning billing. A plain 403 with none of those
 * signals stays `other` — it is a permission refusal, not a key verdict.
 */
export function classifyProviderFailure(
  status: number,
  detail: string | undefined,
  code: string | undefined,
): ProviderFailureClass {
  const text = `${code ?? ''} ${detail ?? ''}`.toLowerCase();
  if (status === 401) return 'auth';
  if (status === 402) return 'billing';
  if (containsAny(text, BILLING_SIGNALS)) return 'billing';
  if (containsAny(text, AUTH_SIGNALS)) return 'auth';
  if (status === 403) return 'other';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 422) return 'invalid-request';
  if (status === 404 || status === 405) return 'not-found';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  if (status >= 400) return 'other';
  return 'other';
}

/** The error code/type a provider body carried, when it had one. */
function extractProviderCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    const errorValue = parsed.error;
    if (isRecord(errorValue)) {
      if (typeof errorValue.code === 'string') return errorValue.code;
      if (typeof errorValue.type === 'string') return errorValue.type;
      return undefined;
    }
    if (typeof parsed.code === 'string') return parsed.code;
    if (typeof parsed.type === 'string') return parsed.type;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parses a provider error body into redacted detail plus code, for
 * classification by callers that do not need a full `ProviderAPIError`.
 */
export function parseProviderError(
  body: string,
  apiKey: string,
): { detail?: string; code?: string } {
  const detail = extractProviderMessage(body, apiKey);
  const code = extractProviderCode(body);
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(code === undefined ? {} : { code }),
  };
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
  const { detail, code } = parseProviderError(body, apiKey);
  const failureClass = classifyProviderFailure(response.status, detail, code);
  let message: string;

  switch (failureClass) {
    case 'billing':
      message = PROVIDER_NO_BALANCE_MESSAGE;
      break;
    case 'auth':
      message = PROVIDER_AUTH_FAILED_MESSAGE;
      break;
    case 'invalid-request':
      message =
        'Provider rejected the request. Check the model and request parameters.';
      break;
    case 'not-found':
      message =
        'Provider endpoint or model not found. Check the base URL and model.';
      break;
    case 'rate-limit':
      message = 'Provider rate limit reached. Wait before trying again.';
      break;
    case 'timeout':
      message = 'Provider request timed out or is temporarily unavailable.';
      break;
    case 'server':
      message = 'Provider service is temporarily unavailable.';
      break;
    case 'other':
      message = 'Provider rejected the request.';
      break;
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
