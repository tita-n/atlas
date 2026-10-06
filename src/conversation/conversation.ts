import { ProviderResponseError, ToolExecutionError } from '../errors.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ChatCompletionRequest,
  CompletionUsage,
  LLMProvider,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
} from '../providers/provider.interface.js';
import { NarrationStreamGuard } from './narration-guard.js';
import { ReasoningFilter } from '../reasoning/reasoning-filter.js';
import type { ConversationRepository } from '../memory/conversation-repository.js';

/** Options controlling requests made by a Conversation instance. */
export interface ConversationOptions {
  /** Model identifier sent with every request. */
  model: string;
  /** Optional generation token limit. */
  maxTokens?: number;
  /** Optional sampling temperature. */
  temperature?: number;
  /** Optional repository used to persist this conversation. */
  conversationRepository?: ConversationRepository;
  /** Existing conversation to resume, or undefined to create a new one. */
  conversationId?: string;
  /** Number of recent messages to load when resuming. */
  historyLimit?: number;
  /** Optional preloaded working history, primarily useful for tests and adapters. */
  initialMessages?: readonly ChatMessage[] | undefined;
  /** Optional base system prompt when no dynamic builder is supplied. */
  systemPrompt?: string;
  /** Optional function invoked to build a fresh system prompt for every turn. */
  buildSystemPrompt?: (() => string) | undefined;
  /** Optional callback scheduled after a completed assistant turn. */
  onTurnComplete?: ((turn: CompletedTurn) => void | Promise<void>) | undefined;
  /** Structured tools exposed to the provider. */
  tools?: readonly ToolDefinition[] | undefined;
  /** Harness-owned executor for structured tool calls. */
  toolExecutor?: ToolExecutor | undefined;
  /** Provider tool-selection behavior when tools are exposed. */
  toolChoice?: 'auto' | 'none' | undefined;
  /** Maximum provider/tool round trips for one user message. */
  maxToolIterations?: number | undefined;
}

/** Data passed to asynchronous post-turn processing. */
export interface CompletedTurn {
  /** User message that started the exchange. */
  userMessage: ChatMessage;
  /** Final assistant response to the exchange. */
  assistantMessage: ChatMessage;
  /** Persisted user message ID, when persistence is enabled. */
  userMessageId?: number | undefined;
  /** Persisted final assistant message ID, when persistence is enabled. */
  assistantMessageId?: number | undefined;
}

/** In-memory and optionally persistent provider-neutral conversation history. */
export class Conversation {
  readonly #messages: ChatMessage[] = [];
  readonly #options: ConversationOptions;
  readonly #repository: ConversationRepository | undefined;
  readonly #conversationId: string | undefined;
  readonly #pendingTasks = new Set<Promise<void>>();

  public constructor(options: ConversationOptions) {
    this.#options = { ...options };
    this.#repository = options.conversationRepository;
    this.#conversationId =
      options.conversationId ??
      options.conversationRepository?.createConversation().id;

    if (options.initialMessages !== undefined) {
      this.#messages.push(
        ...options.initialMessages.map((message) => ({ ...message })),
      );
    } else if (
      this.#repository !== undefined &&
      this.#conversationId !== undefined
    ) {
      this.#messages.push(
        ...this.#repository
          .getRecentChatMessages(
            this.#conversationId,
            options.historyLimit ?? 20,
          )
          .map((message) => ({ ...message })),
      );
    }
  }

  /** Returns the stable persisted conversation ID, when enabled. */
  public get id(): string | undefined {
    return this.#conversationId;
  }

  /** Returns a defensive copy of the current working message history. */
  public get messages(): ChatMessage[] {
    return this.#messages.map((message) => ({
      ...message,
      ...(message.toolCalls === undefined
        ? {}
        : {
            toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
          }),
    }));
  }

  /**
   * Overrides the system prompt for subsequent turns.
   *
   * The assistant session uses this so each turn carries only the memory and
   * corrections relevant to that turn.
   */
  public setSystemPrompt(prompt: string): void {
    this.#options.systemPrompt = prompt;
    this.#options.buildSystemPrompt = undefined;
  }

  /**
   * Switches the model used for subsequent requests.
   *
   * Applies from the next request onward; an in-flight turn keeps the model it
   * started with, so a switch can never split one turn across two models.
   */
  public setModel(model: string): void {
    this.#options.model = model;
  }

  /** The model currently used for requests. */
  public get model(): string {
    return this.#options.model;
  }

  /** Clears working history without deleting persisted rows. */
  public clear(): void {
    this.#messages.length = 0;
  }

  /** Sends a user message and completes any structured tool-call loop. */
  public async send(
    provider: LLMProvider,
    userContent: string,
    options: {
      signal?: AbortSignal;
      /**
       * Receives narration as it is generated.
       *
       * Streaming is best-effort: a provider without streaming support simply
       * calls this once with the finished text, so a caller never has to care
       * whether the turn was streamed.
       */
      onNarrationDelta?: ((text: string) => void) | undefined;
    } = {},
  ): Promise<ChatCompletionResponse> {
    const userMessage: ChatMessage = { role: 'user', content: userContent };
    const userMessageId = this.#persistMessage(userMessage);
    this.#messages.push(userMessage);
    const maxIterations = this.#options.maxToolIterations ?? 8;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      // One call shape for both paths. Streaming only changes how the reply
      // is delivered, never the request or the tool orchestration around it.
      const response = await this.#complete(
        provider,
        {
          messages: this.#requestMessages(),
          model: this.#options.model,
          ...(this.#options.maxTokens === undefined
            ? {}
            : { maxTokens: this.#options.maxTokens }),
          ...(this.#options.temperature === undefined
            ? {}
            : { temperature: this.#options.temperature }),
          ...(this.#options.tools === undefined ||
          this.#options.tools.length === 0
            ? {}
            : { tools: [...this.#options.tools] }),
          ...(this.#options.tools === undefined ||
          this.#options.tools.length === 0
            ? {}
            : { toolChoice: this.#options.toolChoice ?? 'auto' }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        options,
      );
      const toolCalls = response.toolCalls ?? [];
      // An empty turn is a provider failure, not a real message. Persisting
      // it would replay a blank reply on every resume.
      if (
        (response.content ?? '').trim() === '' &&
        (response.toolCalls ?? []).length === 0
      ) {
        throw new ProviderResponseError(
          this.#options.model,
          `the provider returned an empty reply${
            response.emptyReason === undefined
              ? ''
              : ` (${response.emptyReason})`
          }`,
        );
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      };
      this.#messages.push(assistantMessage);
      const assistantMessageId = this.#persistMessage(assistantMessage, {
        tokenCount: response.usage?.outputTokens ?? null,
      });

      if (toolCalls.length === 0) {
        this.#scheduleTurnCompletion({
          userMessage,
          assistantMessage,
          ...(userMessageId === undefined ? {} : { userMessageId }),
          ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
        });
        return response;
      }

      if (this.#options.toolExecutor === undefined) {
        throw new ToolExecutionError(
          'The model requested a tool, but no harness tool executor is configured.',
        );
      }
      if (iteration === maxIterations) {
        // Running out of iterations is not a crash. The model usually has
        // plenty of useful material, so ask it to summarize with tools taken
        // away rather than throwing away the whole turn.
        return await this.#finalizeWithoutTools(
          provider,
          userMessage,
          userMessageId,
          maxIterations,
          options.signal,
        );
      }

      for (const toolCall of toolCalls) {
        const toolResult = await this.#executeTool(toolCall);
        const toolMessage: ChatMessage = {
          role: 'tool',
          content: toolResult.content,
          toolCallId: toolCall.id,
          ...(toolResult.isError ? { isError: true } : {}),
        };
        this.#messages.push(toolMessage);
        this.#persistMessage(toolMessage);
      }
    }

    return await this.#finalizeWithoutTools(
      provider,
      userMessage,
      userMessageId,
      maxIterations,
      options.signal,
    );
  }

  /**
   * Performs one provider call, streaming narration when that was asked for.
   *
   * Falls back to a single non-streaming call whenever live delivery is not
   * available, so every existing caller keeps working unchanged.
   */
  async #complete(
    provider: LLMProvider,
    request: ChatCompletionRequest,
    options: { onNarrationDelta?: ((text: string) => void) | undefined },
  ): Promise<ChatCompletionResponse> {
    if (options.onNarrationDelta === undefined) {
      return provider.chatCompletion(request);
    }
    if (provider.streamChatTurn === undefined) {
      // No streaming support: deliver the finished reply through the same
      // callback so the caller sees a consistent shape either way.
      const response = await provider.chatCompletion(request);
      if ((response.content ?? '') !== '') {
        options.onNarrationDelta(response.content ?? '');
      }
      return response;
    }
    return this.#streamTurn(provider, request, options.onNarrationDelta);
  }

  /**
   * Consumes a streamed turn and rebuilds the normal completion response.
   *
   * Tool calls are only ever seen here as complete calls, which is why the
   * permission gate downstream fires at exactly the same point it always did:
   * after a complete call exists, before it runs.
   */
  async #streamTurn(
    provider: LLMProvider,
    request: ChatCompletionRequest,
    onNarrationDelta: (text: string) => void,
  ): Promise<ChatCompletionResponse> {
    const guard = new NarrationStreamGuard();
    // Reasoning is separated live, before the leakage guard ever sees it, so
    // an inline <think> block cannot reach the display even mid-tag.
    const reasoningFilter = new ReasoningFilter();
    let content = '';
    let toolCalls: ToolCall[] = [];
    let usage: CompletionUsage | undefined;
    let stopReason: string | undefined;
    // Bound explicitly: the method is invoked detached from the provider.
    const streamTurn = provider.streamChatTurn?.bind(provider);
    // Presence is guaranteed by the caller, which checks before calling this.
    if (streamTurn === undefined) {
      throw new Error('streamChatTurn must exist to stream a turn');
    }

    for await (const event of streamTurn(request)) {
      if (event.type === 'text') {
        // Reasoning is separated before the leakage guard ever sees it, so an
        // inline <think> block cannot reach the display even mid-tag.
        const narrationText = reasoningFilter.push(event.text);
        content += narrationText;
        if (narrationText !== '') {
          // Only the guard-approved prefix is shown; a suspected payload is
          // withheld rather than displayed and retracted later.
          const safe = guard.push(narrationText);
          if (safe !== '') onNarrationDelta(safe);
        }
        continue;
      }
      if (event.type === 'tool_calls') {
        toolCalls = [...toolCalls, ...event.toolCalls];
        continue;
      }
      if (event.usage !== undefined) usage = event.usage;
      if (event.finishReason !== undefined) stopReason = event.finishReason;
    }

    // End of stream: flush both filters, then reject an answer-less generation
    // rather than presenting a dangling fragment as a reply.
    const remaining = reasoningFilter.finish();
    content += remaining;
    const tail = guard.push(remaining) + guard.flush();
    if (tail !== '') onNarrationDelta(tail);
    const reasoning = reasoningFilter.reasoning;
    // Only when reasoning was actually seen. An empty stream with no reasoning
    // is the pre-existing empty-reply case and keeps its own error.
    if (content.trim() === '' && reasoning !== '') {
      throw new ProviderResponseError(
        this.#options.model,
        'the model produced only reasoning and no answer' +
          (reasoning === ''
            ? ''
            : ' (it appears to have run out of output while still reasoning)'),
      );
    }

    return {
      content,
      // Reasoning is carried separately and never merged into content.
      ...(reasoning === '' ? {} : { reasoning }),
      // Streamed responses carry no model echo; the requested one is correct.
      model: request.model,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(usage === undefined ? {} : { usage }),
      ...(stopReason === undefined ? {} : { stopReason }),
    };
  }

  /**
   * Asks the model to report what it found, with tools disabled.
   *
   * Used when the tool budget is exhausted so the user still receives the
   * findings instead of an error. Falls back to the last assistant text when
   * that final call cannot be made.
   */
  async #finalizeWithoutTools(
    provider: LLMProvider,
    userMessage: ChatMessage,
    userMessageId: number | undefined,
    maxIterations: number,
    signal: AbortSignal | undefined,
  ): Promise<ChatCompletionResponse> {
    const lastAssistant = [...this.#messages]
      .reverse()
      .find(
        (message) => message.role === 'assistant' && message.content !== '',
      );

    let response: ChatCompletionResponse;
    try {
      response = await provider.chatCompletion({
        messages: [
          ...this.#requestMessages(),
          {
            role: 'user',
            content:
              'Stop using tools and summarize what you have already found for ' +
              'the user now. If part of the task is unfinished, say plainly ' +
              'what is missing and what command you would need next.',
          },
        ],
        model: this.#options.model,
        ...(this.#options.maxTokens === undefined
          ? {}
          : { maxTokens: this.#options.maxTokens }),
        ...(this.#options.temperature === undefined
          ? {}
          : { temperature: this.#options.temperature }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // A cancelled turn must not be answered with text no model produced.
      if (signal?.aborted === true) throw error;
      const fallback = lastAssistant?.content ?? '';
      return {
        content:
          fallback === ''
            ? `I used all ${maxIterations} tool steps without finishing. Ask me to continue and I will pick up where I stopped.`
            : `${fallback}\n\n(I stopped after ${maxIterations} tool steps. Ask me to continue for the rest.)`,
        model: this.#options.model,
      };
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: response.content,
    };
    this.#messages.push(assistantMessage);
    this.#scheduleTurnCompletion({
      userMessage,
      assistantMessage,
      ...(userMessageId === undefined ? {} : { userMessageId }),
    });
    return response;
  }

  /** Waits for scheduled post-turn callbacks, useful during graceful shutdown. */
  public async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.#pendingTasks.size > 0) {
      await Promise.all([...this.#pendingTasks]);
    }
  }

  async #executeTool(
    toolCall: ToolCall,
  ): Promise<{ content: string; isError: boolean }> {
    const executor = this.#options.toolExecutor;
    if (executor === undefined) {
      return {
        content: 'Tool execution is unavailable.',
        isError: true,
      };
    }
    try {
      const result = await executor.execute(toolCall);
      return {
        content: result.content,
        isError: result.isError ?? false,
      };
    } catch (error) {
      return {
        content:
          error instanceof Error ? error.message : 'Tool execution failed.',
        isError: true,
      };
    }
  }

  #persistMessage(
    message: ChatMessage,
    options: { tokenCount?: number | null } = {},
  ): number | undefined {
    if (this.#repository === undefined || this.#conversationId === undefined) {
      return undefined;
    }
    return this.#repository.appendMessage(this.#conversationId, {
      role: message.role,
      content: message.content,
      ...(options.tokenCount === undefined
        ? {}
        : { tokenCount: options.tokenCount }),
      ...(message.toolCalls === undefined
        ? {}
        : { toolCalls: message.toolCalls }),
      ...(message.toolCallId === undefined
        ? {}
        : { toolCallId: message.toolCallId }),
      ...(message.isError === undefined ? {} : { isError: message.isError }),
    }).id;
  }

  #requestMessages(): ChatMessage[] {
    const context =
      this.#options.buildSystemPrompt?.() ?? this.#options.systemPrompt ?? '';
    const workingMessages = this.messages;
    if (context.trim() === '') return workingMessages;
    return [{ role: 'system', content: context }, ...workingMessages];
  }

  #scheduleTurnCompletion(turn: CompletedTurn): void {
    const callback = this.#options.onTurnComplete;
    if (callback === undefined) return;

    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          void Promise.resolve(callback(turn)).then(
            () => {
              resolve();
            },
            () => {
              resolve();
            },
          );
        } catch {
          resolve();
        }
      });
    });
    this.#pendingTasks.add(task);
    void task.then(() => this.#pendingTasks.delete(task));
  }
}
