/**
 * Tri-state API key validation for the /init wizard.
 *
 * The old probe was one billable completion per key, aimed at whatever
 * endpoint the *current* config held rather than the vendor being set up.
 * This probe asks the picked endpoint directly and answers one of three ways:
 *
 *   - `accepted` — the endpoint recognised the key;
 *   - `accepted-no-balance` — the key is valid but the account cannot pay:
 *     the provider said so in its own words (OpenAI 429 `insufficient_quota`,
 *     Anthropic 400 "credit balance is too low", Gemini 403 billing text);
 *   - `rejected` — the endpoint did not accept the key, or could not be
 *     reached or understood well enough to prove it.
 *
 * The probe prefers `GET {baseUrl}/models`: it is free, spends no tokens, and
 * answers the auth question on every provider that exposes it. Only endpoints
 * without a models list fall back to a one-token completion.
 */
import {
  classifyProviderFailure,
  embeddedProviderError,
  parseProviderError,
  PROVIDER_AUTH_FAILED_MESSAGE,
  PROVIDER_NO_BALANCE_MESSAGE,
} from './error-response.js';
import { ANTHROPIC_VERSION } from './anthropic-compatible.js';
import type { AtlasProtocol } from './model-registry.js';

export type KeyValidationStatus =
  'accepted' | 'accepted-no-balance' | 'rejected';

export interface KeyValidationResult {
  readonly status: KeyValidationStatus;
  /** Rejection reason or no-balance warning, human-readable and redacted. */
  readonly message?: string;
  /** Which probe reached the verdict. */
  readonly probe: 'models' | 'completion';
}

export interface ValidateApiKeyInput {
  readonly provider: AtlasProtocol;
  readonly apiKey: string;
  /** The endpoint this key would be saved against — probed, not guessed. */
  readonly baseUrl: string;
  /** The model this key would be saved with. */
  readonly model: string;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** A probe should fail fast; the wizard is interactive. */
export const PROBE_TIMEOUT_MS = 20_000;

function authHeaders(
  provider: AtlasProtocol,
  apiKey: string,
): Record<string, string> {
  // Exactly the headers the real chat providers send, so a key that works
  // for chat is a key this probe accepts.
  return provider === 'anthropic-compatible'
    ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    : { authorization: `Bearer ${apiKey}` };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Common model-list envelopes used by OpenAI-compatible and Anthropic APIs. */
function isModelsList(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return Array.isArray(record.data) || Array.isArray(record.models);
}

function unreachable(baseUrl: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not reach ${baseUrl} to validate the key: ${reason}`;
}

function withDetail(message: string, detail: string | undefined): string {
  return detail === undefined || detail === ''
    ? message
    : `${message} Provider response: ${detail}`;
}

/** Maps a class that already decides the verdict; undefined = keep looking. */
function partialVerdict(
  failureClass: ReturnType<typeof classifyProviderFailure>,
  detail: string | undefined,
  probe: 'models' | 'completion',
): KeyValidationResult | undefined {
  switch (failureClass) {
    case 'billing':
      return {
        status: 'accepted-no-balance',
        probe,
        message: withDetail(PROVIDER_NO_BALANCE_MESSAGE, detail),
      };
    case 'auth':
      return {
        status: 'rejected',
        probe,
        message: withDetail(PROVIDER_AUTH_FAILED_MESSAGE, detail),
      };
    case 'rate-limit':
      // Throttled, but recognised: rate limiting happens after authentication
      // everywhere that matters, so this is a valid key.
      return { status: 'accepted', probe };
    default:
      return undefined;
  }
}

/** Terminal verdict for the completion fallback, where nothing else runs. */
function finalVerdict(
  failureClass: ReturnType<typeof classifyProviderFailure>,
  detail: string | undefined,
  probe: 'models' | 'completion',
): KeyValidationResult {
  const partial = partialVerdict(failureClass, detail, probe);
  if (partial !== undefined) return partial;
  switch (failureClass) {
    case 'not-found':
      return {
        status: 'rejected',
        probe,
        message: withDetail(
          'Provider endpoint or model not found. Check the base URL and model.',
          detail,
        ),
      };
    case 'invalid-request':
      return {
        status: 'rejected',
        probe,
        message: withDetail(
          'Provider rejected the probe request. Check the model and request parameters.',
          detail,
        ),
      };
    case 'timeout':
      return {
        status: 'rejected',
        probe,
        message: withDetail(
          'Provider request timed out or is temporarily unavailable.',
          detail,
        ),
      };
    case 'server':
      return {
        status: 'rejected',
        probe,
        message: withDetail(
          'Provider service is temporarily unavailable, so the key could not be verified.',
          detail,
        ),
      };
    default:
      return {
        status: 'rejected',
        probe,
        message: withDetail('Provider rejected the request.', detail),
      };
  }
}

/** Classifies a 2xx body that embedded its failure instead of using a status. */
function embeddedVerdict(
  payload: unknown,
  apiKey: string,
  probe: 'models' | 'completion',
): KeyValidationResult | undefined {
  const embedded = embeddedProviderError(payload, apiKey);
  if (embedded === undefined) return undefined;
  const failureClass = classifyProviderFailure(
    embedded.statusCode ?? 200,
    embedded.message,
    undefined,
  );
  if (failureClass === 'auth' || failureClass === 'billing') {
    return partialVerdict(failureClass, embedded.message, probe);
  }
  return {
    status: 'rejected',
    probe,
    message: withDetail(
      `Provider returned an error${embedded.statusCode === undefined ? '' : ` (${embedded.statusCode})`}:`,
      embedded.message,
    ),
  };
}

/**
 * Validates a key against the endpoint it would actually be saved with.
 *
 * Never throws: every failure path is a `rejected` result with a message the
 * wizard can show verbatim.
 */
export async function validateApiKey(
  input: ValidateApiKeyInput,
): Promise<KeyValidationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, '');
  const auth = authHeaders(input.provider, input.apiKey);
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);

  // 1) The models list: free, no tokens, proves the key where it exists.
  try {
    const response = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: auth,
      signal,
    });
    const body = await readBody(response);
    if (response.ok) {
      const payload = safeJson(body);
      const verdict = embeddedVerdict(payload, input.apiKey, 'models');
      if (verdict !== undefined) return verdict;
      if (isModelsList(payload)) return { status: 'accepted', probe: 'models' };
      // A 200 HTML/login page or malformed body is not proof of auth. Try the
      // actual chat endpoint once rather than silently accepting it.
    }
    const { detail, code } = parseProviderError(body, input.apiKey);
    const failureClass = classifyProviderFailure(response.status, detail, code);
    const verdict = partialVerdict(failureClass, detail, 'models');
    if (verdict !== undefined) return verdict;
    // No verdict yet (404/405/400/5xx/…): the endpoint may simply not
    // expose /models — fall through to the completion probe.
  } catch (error) {
    // Same host as the completion probe would use: if this cannot be
    // reached, neither can that. Say so instead of waiting twice.
    return {
      status: 'rejected',
      probe: 'models',
      message: unreachable(base, error),
    };
  }

  // 2) Completion fallback: one token, only reached when /models could not
  // answer (typically a 404 on an endpoint that does not list models). The
  // minimal payload has the same shape on both wire formats.
  const anthropic = input.provider === 'anthropic-compatible';
  const url = `${base}/${anthropic ? 'messages' : 'chat/completions'}`;
  const payload = {
    model: input.model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const body = await readBody(response);
    if (response.ok) {
      const verdict = embeddedVerdict(
        safeJson(body),
        input.apiKey,
        'completion',
      );
      if (verdict !== undefined) return verdict;
      return { status: 'accepted', probe: 'completion' };
    }
    const { detail, code } = parseProviderError(body, input.apiKey);
    return finalVerdict(
      classifyProviderFailure(response.status, detail, code),
      detail,
      'completion',
    );
  } catch (error) {
    return {
      status: 'rejected',
      probe: 'completion',
      message: unreachable(base, error),
    };
  }
}
