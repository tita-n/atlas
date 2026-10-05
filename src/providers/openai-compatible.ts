import { z } from 'zod';
import {
  ProviderNetworkError,
  ProviderRequestError,
  ProviderResponseError,
} from '../errors.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  LLMProvider,
  ProviderDependencies,
} from './provider.interface.js';
import {
  embeddedErrorToApiError,
  embeddedProviderError,
  providerApiError,
} from './error-response.js';
import { providerSchemaError } from './schema-error.js';
import { decodeToolArguments } from './tool-arguments.js';
import {
  DEFAULT_PROVIDER_MAX_RETRIES,
  DEFAULT_PROVIDER_RETRY_DELAY_MS,
  isRetryableNetworkError,
  isRetryableProviderStatus,
  providerRetryDelayMs,
  waitForRetry,
} from './retry.js';
import { readSseData } from './sse.js';
import { OpenAIStreamAssembler } from './stream-events.js';
import type { StreamEvent } from './stream-events.js';

const openAIToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const openAIResponseSchema = z.object({
  model: z.string().min(1),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().nullable().optional(),
          /**
           * Reasoning models emit their thinking here. It is accepted so the
           * rest of the pipeline can see that the model did answer, instead of
           * silently treating the turn as empty.
           */
          reasoning_content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(openAIToolCallSchema).nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});

const openAIChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
          })
          .passthrough(),
      }),
    )
    .optional(),
});

const DEFAULT_TIMEOUT_MS = 60_000;

/** One extra request when the provider returns a structurally invalid body. */
const SCHEMA_RETRY_ATTEMPTS = 1;

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** OpenAI Chat Completions adapter suitable for OpenAI-compatible endpoints. */
export class OpenAICompatibleProvider implements LLMProvider {
  public readonly name = 'openai-compatible';

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;

  public constructor(options: {
    /** OpenAI-compatible API key. */
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
    // Caller cancellation and the request timeout are independent, so both
    // are combined instead of one replacing the other.
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, signal]);
    // Read through a helper so TypeScript does not narrow `aborted` to false
    // after the first guard and flag the later check as unreachable.
    const isCancelled = (): boolean => signal?.aborted === true;
    let attempt = 0;

    while (true) {
      if (isCancelled()) {
        throw new ProviderNetworkError(this.name, {
          cause: new DOMException('The request was cancelled.', 'AbortError'),
        });
      }
      try {
        const response = await this.#fetch(endpoint(this.#baseUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
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
        // A user cancellation is a deliberate stop, never a transient fault,
        // so it must not consume the retry budget.
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
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message: ChatMessage) => {
        if (message.role === 'tool') {
          if (message.toolCallId === undefined) {
            throw new ProviderRequestError(
              this.name,
              'Tool result messages require a toolCallId.',
            );
          }
          return {
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: message.content,
          } satisfies Record<string, string>;
        }
        if (message.role === 'assistant' && message.toolCalls?.length) {
          return {
            role: 'assistant',
            content: message.content === '' ? null : message.content,
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            })),
          } satisfies Record<string, unknown>;
        }
        return {
          role: message.role,
          content: message.content,
        } satisfies Record<string, string>;
      }),
      stream,
    };

    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    return body;
  }

  /** Sends a non-streaming request using the OpenAI Chat Completions shape. */
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
          { cause: error },
        );
      }

      // A 200 can still carry a failure, for example a gateway returning
      // {"error":{"code":502}}. Treating that as a schema problem hides the
      // real cause and skips the retry it deserves.
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

      const parsed = openAIResponseSchema.safeParse(payload);
      if (parsed.success) {
        return this.#toChatCompletionResponse(parsed.data);
      }

      schemaError = providerSchemaError(
        this.name,
        'response does not match the OpenAI chat completions schema',
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

  /** Maps a validated OpenAI payload onto the provider-neutral shape. */
  #toChatCompletionResponse(
    data: z.infer<typeof openAIResponseSchema>,
  ): ChatCompletionResponse {
    const choice = data.choices[0];
    if (choice === undefined) {
      throw new ProviderResponseError(
        this.name,
        'response contains no choices',
      );
    }

    const hasContent =
      typeof choice.message.content === 'string' &&
      choice.message.content.trim() !== '';
    const responseBody: ChatCompletionResponse = {
      content: choice.message.content ?? '',
      model: data.model,
      // An empty turn with no tool calls is a provider quirk, not silence.
      // Recording why stops "Atlas said nothing" from being unexplainable.
      ...(hasContent || choice.message.tool_calls?.length
        ? {}
        : {
            emptyReason:
              choice.finish_reason === 'tool_calls'
                ? 'the model asked for a tool that was not offered'
                : (choice.message.refusal ?? 'the model returned no content'),
          }),
    };

    if (choice.message.tool_calls?.length) {
      responseBody.toolCalls = choice.message.tool_calls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: decodeToolArguments(toolCall.function.arguments, this.name),
      }));
    }

    if (data.usage !== null && data.usage !== undefined) {
      responseBody.usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      };
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      responseBody.stopReason = choice.finish_reason;
    }

    return responseBody;
  }

  /** Streams assistant text from an OpenAI-compatible SSE response. */
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
      if (data === '[DONE]') return;

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

      // A gateway can inject an error frame mid-stream. The chunk schema is
      // deliberately permissive, so without this check the frame parses fine,
      // contributes nothing, and the stream ends as if it completed cleanly.
      const embedded = embeddedProviderError(payload, this.#apiKey);
      if (embedded !== undefined) {
        throw embeddedErrorToApiError(embedded, this.name);
      }

      const parsed = openAIChunkSchema.safeParse(payload);
      if (!parsed.success) {
        throw providerSchemaError(
          this.name,
          'stream chunk does not match the OpenAI schema',
          parsed.error,
        );
      }

      for (const choice of parsed.data.choices ?? []) {
        const content = choice.delta.content;
        if (content !== null && content !== undefined && content !== '') {
          yield content;
        }
      }
    }
  }
  /**
   * Streams a full turn, including tool calls.
   *
   * Unlike `streamChatCompletion`, tools are allowed: tool-call fragments are
   * assembled and emitted only once complete, so no partial tool content is
   * ever mistaken for narration.
   */
  public async *streamChatTurn(
    request: ChatCompletionRequest,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const response = await this.#post(
      this.#requestBody(request, true),
      request.signal,
    );
    if (!response.ok) {
      throw await providerApiError(response, this.name, this.#apiKey);
    }

    const assembler = new OpenAIStreamAssembler(this.name);
    for await (const data of readSseData(response.body, this.name)) {
      if (data === '[DONE]') break;

      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch (error) {
        throw new ProviderResponseError(
          this.name,
          'stream contains invalid JSON',
          { cause: error },
        );
      }

      // A gateway can inject an error frame mid-stream, mid-turn. Checking it
      // before assembly means a failed stream never looks like a clean finish.
      const embedded = embeddedProviderError(payload, this.#apiKey);
      if (embedded !== undefined) {
        throw embeddedErrorToApiError(embedded, this.name);
      }

      for (const event of assembler.push(payload)) yield event;
    }

    for (const event of assembler.finish()) yield event;
  }
}
