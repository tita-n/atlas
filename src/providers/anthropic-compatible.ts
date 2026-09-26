import { z } from 'zod';
import {
  ProviderNetworkError,
  ProviderRequestError,
  ProviderResponseError,
} from '../errors.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProvider,
  ProviderDependencies,
} from './provider.interface.js';
import {
  embeddedErrorToApiError,
  embeddedProviderError,
  providerApiError,
} from './error-response.js';
import { providerSchemaError } from './schema-error.js';
import { validateToolInput } from './tool-arguments.js';
import {
  DEFAULT_PROVIDER_MAX_RETRIES,
  DEFAULT_PROVIDER_RETRY_DELAY_MS,
  isRetryableNetworkError,
  isRetryableProviderStatus,
  providerRetryDelayMs,
  waitForRetry,
} from './retry.js';
import { readSseData } from './sse.js';

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const anthropicResponseSchema = z.object({
  model: z.string().min(1),
  content: z
    .array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
          id: z.string().optional(),
          name: z.string().optional(),
          input: z.record(z.unknown()).optional(),
        })
        .passthrough(),
    )
    .min(1),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

const anthropicChunkSchema = z
  .object({
    type: z.string(),
    delta: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const DEFAULT_TIMEOUT_MS = 60_000;

/** One extra request when the provider returns a structurally invalid body. */
const SCHEMA_RETRY_ATTEMPTS = 1;
const DEFAULT_MAX_TOKENS = 4_096;
const ANTHROPIC_VERSION = '2023-06-01';

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/messages`;
}

/** Anthropic Messages adapter suitable for Anthropic-compatible endpoints. */
export class AnthropicCompatibleProvider implements LLMProvider {
  public readonly name = 'anthropic-compatible';

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;

  public constructor(options: {
    /** Anthropic-compatible API key. */
    apiKey: string;
    /** API root, including `/v1` when required by the endpoint. */
    baseUrl: string;
    /** Optional network dependencies. */
    dependencies?: ProviderDependencies | undefined;
  }) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.dependencies?.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.dependencies?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries =
      options.dependencies?.maxRetries ?? DEFAULT_PROVIDER_MAX_RETRIES;
    this.#retryDelayMs =
      options.dependencies?.retryDelayMs ?? DEFAULT_PROVIDER_RETRY_DELAY_MS;
  }

  async #post(
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const serializedBody = JSON.stringify(body);
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, signal]);
    const isCancelled = (): boolean => signal?.aborted === true;
    let attempt = 0;

    while (true) {
      try {
        const response = await this.#fetch(endpoint(this.#baseUrl), {
          method: 'POST',
          headers: {
            'x-api-key': this.#apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: serializedBody,
          signal: requestSignal,
        });
        if (
          attempt < this.#maxRetries &&
          isRetryableProviderStatus(response.status)
        ) {
          await response.body?.cancel().catch(() => undefined);
          await waitForRetry(
            providerRetryDelayMs(
              attempt,
              this.#retryDelayMs,
              response.headers.get('retry-after'),
            ),
          );
          attempt += 1;
          continue;
        }
        return response;
      } catch (error) {
        const networkError =
          error instanceof ProviderNetworkError
            ? error
            : new ProviderNetworkError(this.name, { cause: error });
        // A user cancellation is deliberate, so it must not be retried.
        if (isCancelled()) {
          throw networkError;
        }
        if (
          attempt >= this.#maxRetries ||
          !isRetryableNetworkError(networkError)
        ) {
          throw networkError;
        }
        await waitForRetry(
          providerRetryDelayMs(attempt, this.#retryDelayMs, null),
        );
        attempt += 1;
      }
    }
  }

  #requestBody(
    request: ChatCompletionRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'tool') {
          if (message.toolCallId === undefined) {
            throw new ProviderRequestError(
              this.name,
              'Tool result messages require a toolCallId.',
            );
          }
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                content: message.content,
                ...(message.isError === true ? { is_error: true } : {}),
              },
            ],
          } satisfies Record<string, unknown>;
        }
        if (message.role === 'assistant' && message.toolCalls?.length) {
          return {
            role: 'assistant',
            content: [
              ...(message.content === ''
                ? []
                : [{ type: 'text', text: message.content }]),
              ...message.toolCalls.map((toolCall) => ({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.arguments,
              })),
            ],
          } satisfies Record<string, unknown>;
        }
        return {
          role: message.role,
          content: message.content,
        } satisfies Record<string, string>;
      });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream,
    };

    if (system !== '') body.system = system;
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
      body.tool_choice = { type: request.toolChoice ?? 'auto' };
    }
    return body;
  }

  /** Sends a non-streaming request using the Anthropic Messages shape. */
  public async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    if (request.stream === true) {
      throw new ProviderRequestError(
        this.name,
        'Use streamChatCompletion() when streaming is requested.',
      );
    }

    const body = this.#requestBody(request, false);
    let schemaError: ProviderResponseError | undefined;

    for (let attempt = 0; attempt <= SCHEMA_RETRY_ATTEMPTS; attempt += 1) {
      const response = await this.#post(body, request.signal);
      if (!response.ok) {
        throw await providerApiError(response, this.name, this.#apiKey);
      }

      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch (error) {
        throw new ProviderResponseError(
          this.name,
          'response body is not JSON',
          {
            cause: error,
          },
        );
      }

      // A 200 can still carry a failure. Report the real cause and retry it
      // when it is a transient upstream fault.
      const embedded = embeddedProviderError(payload, this.#apiKey);
      if (embedded !== undefined) {
        const apiError = embeddedErrorToApiError(embedded, this.name);
        if (
          attempt < SCHEMA_RETRY_ATTEMPTS &&
          isRetryableProviderStatus(apiError.statusCode)
        ) {
          await waitForRetry(
            providerRetryDelayMs(attempt, this.#retryDelayMs, null),
          );
          continue;
        }
        throw apiError;
      }

      const parsed = anthropicResponseSchema.safeParse(payload);
      if (parsed.success) {
        return this.#toChatCompletionResponse(parsed.data);
      }

      schemaError = providerSchemaError(
        this.name,
        'response does not match the Anthropic messages schema',
        parsed.error,
      );
      if (attempt < SCHEMA_RETRY_ATTEMPTS) {
        await waitForRetry(
          providerRetryDelayMs(attempt, this.#retryDelayMs, null),
        );
      }
    }

    throw schemaError ?? new ProviderResponseError(this.name, 'empty response');
  }

  /** Maps a validated Anthropic payload onto the provider-neutral shape. */
  #toChatCompletionResponse(
    data: z.infer<typeof anthropicResponseSchema>,
  ): ChatCompletionResponse {
    const textBlocks = data.content.filter(
      (block) => block.type === 'text' && block.text !== undefined,
    );
    const toolUses: AnthropicToolUse[] = [];
    for (const block of data.content) {
      if (
        block.type === 'tool_use' &&
        block.id !== undefined &&
        block.name !== undefined &&
        block.input !== undefined
      ) {
        toolUses.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    const content = textBlocks.map((block) => block.text ?? '').join('');

    const responseBody: ChatCompletionResponse = {
      content,
      model: data.model,
    };

    if (toolUses.length > 0) {
      responseBody.toolCalls = toolUses.map((toolUse) => ({
        id: toolUse.id,
        name: toolUse.name,
        arguments: validateToolInput(toolUse.input, this.name),
      }));
    }

    if (data.usage !== undefined) {
      responseBody.usage = {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      };
    }
    if (data.stop_reason !== null && data.stop_reason !== undefined) {
      responseBody.stopReason = data.stop_reason;
    }

    return responseBody;
  }

  /** Streams assistant text from an Anthropic-compatible SSE response. */
  public async *streamChatCompletion(
    request: ChatCompletionRequest,
  ): AsyncGenerator<string> {
    if (request.tools !== undefined && request.tools.length > 0) {
      throw new ProviderRequestError(
        this.name,
        'Tool calls require a non-streaming request.',
      );
    }
    const response = await this.#post(
      this.#requestBody(request, true),
      request.signal,
    );
    if (!response.ok) {
      throw await providerApiError(response, this.name, this.#apiKey);
    }

    for await (const data of readSseData(response.body, this.name)) {
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch (error) {
        throw new ProviderResponseError(
          this.name,
          'stream contains invalid JSON',
          {
            cause: error,
          },
        );
      }

      const parsed = anthropicChunkSchema.safeParse(payload);
      if (!parsed.success) {
        throw providerSchemaError(
          this.name,
          'stream event does not match the Anthropic schema',
          parsed.error,
        );
      }

      if (parsed.data.type === 'error') {
        // Route through the same detection and redaction as every other
        // provider error path. Raw JSON here would print the API key when a
        // gateway echoes it back inside an error frame.
        const embedded = embeddedProviderError(
          { error: parsed.data.error },
          this.#apiKey,
        );
        if (embedded !== undefined) {
          throw embeddedErrorToApiError(embedded, this.name);
        }
        throw providerSchemaError(
          this.name,
          'stream reported an error event',
          new z.ZodError([
            {
              code: z.ZodIssueCode.custom,
              path: ['type'],
              message: 'stream reported an error event',
            },
          ]),
        );
      }

      if (
        parsed.data.type === 'content_block_delta' &&
        parsed.data.delta?.type === 'text_delta' &&
        parsed.data.delta.text !== undefined
      ) {
        yield parsed.data.delta.text;
      }
    }
  }
}
