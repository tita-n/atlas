/**
 * Base class for errors deliberately exposed by Atlas.
 */
export class AtlasError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Indicates that interactive CLI input is missing or invalid. */
export class CliInputError extends AtlasError {}

/**
 * Indicates that user or environment configuration is missing or invalid.
 */
export class ConfigValidationError extends AtlasError {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid Atlas configuration:\n- ${issues.join('\n- ')}`);
    this.issues = issues;
  }
}

/**
 * Indicates that no configuration file or complete environment configuration exists.
 */
export class ConfigNotFoundError extends AtlasError {
  public constructor(configPath: string) {
    super(
      `No Atlas configuration was found at ${configPath}. ` +
        'Run "atlas config init" or set the ATLAS_* environment variables.',
    );
  }
}

/** Indicates that the local memory database could not be opened or migrated. */
export class MemoryError extends AtlasError {}

/** Indicates that a conversation or fact operation could not be completed. */
export class MemoryOperationError extends AtlasError {}

/** Indicates that the configuration file could not be read or written. */
export class ConfigFileError extends AtlasError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Classification for a failed provider transport request. */
export type ProviderNetworkErrorKind =
  'timeout' | 'aborted' | 'dns' | 'connection' | 'tls' | 'proxy' | 'unknown';

/** One safe-to-display entry in an error cause chain. */
export interface ErrorChainEntry {
  /** JavaScript error name. */
  name: string;
  /** Error message. */
  message: string;
  /** Underlying platform error code, when available. */
  code?: string;
}

/** Returns a bounded, typed view of an error and its nested causes. */
export function getErrorChain(error: unknown, maxDepth = 8): ErrorChainEntry[] {
  const entries: ErrorChainEntry[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();

  while (pending.length > 0 && entries.length < maxDepth) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    const code =
      'code' in current && typeof current.code === 'string'
        ? current.code
        : undefined;
    entries.push({
      name: current.name,
      message: current.message,
      ...(code === undefined ? {} : { code }),
    });
    pending.push(current.cause);
    const nestedErrors: unknown =
      'errors' in current ? current.errors : undefined;
    if (Array.isArray(nestedErrors)) {
      for (const nestedError of nestedErrors as unknown[]) {
        pending.push(nestedError);
      }
    }
  }

  return entries;
}

function classifyNetworkError(error: unknown): ProviderNetworkErrorKind {
  const entries = getErrorChain(error);
  for (const entry of entries) {
    const text =
      `${entry.name} ${entry.message} ${entry.code ?? ''}`.toLowerCase();
    const code = entry.code?.toUpperCase() ?? '';

    // Timeouts are checked first. AbortSignal.timeout() rejects with a
    // DOMException whose message contains the word "aborted", so testing for
    // abort first classified every real timeout as a deliberate cancellation
    // and silently disabled its retry.
    if (
      entry.name === 'TimeoutError' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      text.includes('timeout')
    ) {
      return 'timeout';
    }
    if (
      entry.name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'UND_ERR_ABORTED' ||
      text.includes('abort')
    ) {
      return 'aborted';
    }
    if (
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      text.includes('dns') ||
      text.includes('getaddrinfo')
    ) {
      return 'dns';
    }
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'EPIPE' ||
      code === 'ECONNABORTED' ||
      code === 'UND_ERR_SOCKET' ||
      text.includes('socket hang up')
    ) {
      return 'connection';
    }
    if (
      code.includes('CERT') ||
      code.includes('EPROTO') ||
      code === 'ERR_TLS' ||
      text.includes('tls') ||
      text.includes('certificate')
    ) {
      return 'tls';
    }
    if (text.includes('proxy')) return 'proxy';
  }

  return 'unknown';
}

/** Indicates that a provider request could not reach its HTTP endpoint. */
export class ProviderNetworkError extends AtlasError {
  public readonly kind: ProviderNetworkErrorKind;

  public constructor(
    public readonly providerName: string,
    options?: ErrorOptions & { kind?: ProviderNetworkErrorKind },
  ) {
    const kind = options?.kind ?? classifyNetworkError(options?.cause);
    const code = getErrorChain(options?.cause)
      .map((entry) => entry.code)
      .find((value): value is string => value !== undefined);
    const detail = code === undefined ? kind : `${kind}: ${code}`;
    super(`Could not reach the ${providerName} provider (${detail}).`, options);
    this.kind = kind;
  }
}

/** Indicates that the model requested a tool Atlas cannot safely execute. */
export class ToolExecutionError extends AtlasError {}

/** Indicates that the persistent shell session could not execute a command. */
export class ShellSessionError extends AtlasError {}

/** Indicates that permission setup or evaluation failed. */
export class PermissionError extends AtlasError {}

/** Indicates that a provider request is invalid before it is sent. */
export class ProviderRequestError extends AtlasError {
  public constructor(
    public readonly providerName: string,
    message: string,
  ) {
    super(`Invalid ${providerName} request: ${message}`);
  }
}

/**
 * Indicates that a provider returned a non-successful HTTP response.
 */
export class ProviderAPIError extends AtlasError {
  public constructor(
    public readonly providerName: string,
    public readonly statusCode: number,
    public readonly statusText: string,
    message?: string,
  ) {
    super(
      message ??
        `The ${providerName} provider rejected the request ` +
          `(HTTP ${statusCode}).`,
    );
  }
}

/** Indicates that a successful provider response did not match its wire contract. */
export class ProviderResponseError extends AtlasError {
  public constructor(
    public readonly providerName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `The ${providerName} provider returned an invalid response: ${message}`,
      options,
    );
  }
}
