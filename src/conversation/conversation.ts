import { ToolExecutionError } from '../errors.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  LLMProvider,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
} from '../providers/provider.interface.js';
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

  /** Clears working history without deleting persisted rows. */
  public clear(): void {
    this.#messages.length = 0;
  }

  /** Sends a user message and completes any structured tool-call loop. */
  public async send(
    provider: LLMProvider,
    userContent: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatCompletionResponse> {
    const userMessage: ChatMessage = { role: 'user', content: userContent };
    const userMessageId = this.#persistMessage(userMessage);
    this.#messages.push(userMessage);
    const maxIterations = this.#options.maxToolIterations ?? 8;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      const response = await provider.chatCompletion({
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
      });
      const toolCalls = response.toolCalls ?? [];
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
