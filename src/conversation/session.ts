/**
 * The assistant session: one continuous conversation across restarts.
 *
 * Orchestrates retrieval, generation, tool execution, narration, and durable
 * writes so the CLI only has to hand over a line of text. Nothing here is
 * voice-specific; the voice layer can feed the same `handleInput`.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';

import type { AssistantConfig } from '../config/assistant-config.js';
import { textConfirmNoticePath } from '../config/assistant-config.js';
import { AtlasError } from '../errors.js';
import {
  FactsRepository,
  type MemoryFact,
} from '../memory/facts-repository.js';
import { ConversationRepository } from '../memory/conversation-repository.js';
import { CorrectionsRepository } from '../memory/corrections-repository.js';
import {
  Conversation,
  type CompletedTurn,
} from '../conversation/conversation.js';
import type {
  ChatCompletionResponse,
  LLMProvider,
  ToolDefinition,
  ToolExecutor,
} from '../providers/provider.interface.js';
import {
  mergeMemories,
  rankCorrections,
  rankFacts,
} from './memory-retrieval.js';
import {
  ExecutionLedger,
  stripExecutionLeakage,
  type ExecutionRecord,
} from './narration.js';
import { loadPersonality, defaultPersonalityPath } from './personality.js';
import { buildTurnPrompt } from './system-prompt.js';

/** Everything the caller needs to render one turn. */
export interface TurnResult {
  /** The conversational narration, with execution detail removed. */
  readonly narration: string;
  /** The separated execution detail block, empty when nothing ran. */
  readonly detail: string;
  /** Memories that were injected for this turn. */
  readonly memoriesUsed: readonly string[];
  /** Corrections that were injected for this turn. */
  readonly correctionsApplied: readonly string[];
  /** Whether a shell command ran during this turn. */
  readonly executed: boolean;
}

/** Ledger-aware tool executor that records what ran. */
export class RecordingToolExecutor implements ToolExecutor {
  readonly #inner: ToolExecutor;
  readonly #ledger: ExecutionLedger;
  readonly #onRecord: ((record: ExecutionRecord) => void) | undefined;

  public constructor(
    inner: ToolExecutor,
    ledger: ExecutionLedger,
    onRecord?: (record: ExecutionRecord) => void,
  ) {
    this.#inner = inner;
    this.#ledger = ledger;
    this.#onRecord = onRecord;
  }

  public async execute(toolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: string; isError?: boolean }> {
    const started = Date.now();
    const command =
      typeof toolCall.arguments.command === 'string'
        ? toolCall.arguments.command
        : JSON.stringify(toolCall.arguments);
    try {
      const result = await this.#inner.execute(toolCall);
      const record: ExecutionRecord = {
        toolName: toolCall.name,
        command,
        ok: result.isError !== true,
        summary:
          result.isError === true
            ? 'That command failed.'
            : 'Command finished.',
        detail: result.content,
        durationMs: Date.now() - started,
      };
      this.#ledger.add(record);
      this.#onRecord?.(record);
      return result;
    } catch (error) {
      const record: ExecutionRecord = {
        toolName: toolCall.name,
        command,
        ok: false,
        summary: 'That command failed.',
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
      this.#ledger.add(record);
      this.#onRecord?.(record);
      return {
        content: `Shell execution failed: ${record.detail}`,
        isError: true,
      };
    }
  }
}

/** Everything needed to build a session and its conversation together. */
export interface CreateSessionOptions {
  readonly config: AssistantConfig;
  readonly provider: LLMProvider;
  readonly model: string;
  readonly conversationRepository: ConversationRepository;
  readonly conversationId?: string | undefined;
  readonly facts: FactsRepository;
  readonly corrections: CorrectionsRepository;
  readonly toolExecutor: ToolExecutor | undefined;
  readonly tools: readonly ToolDefinition[];
  readonly buildSystemPrompt: () => string;
  /** Generation limits, previously accepted by config init but silently dropped. */
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  /** Runs after every completed turn to persist facts and corrections. */
  readonly onTurnComplete?:
    ((turn: CompletedTurn) => void | Promise<void>) | undefined;
  readonly onPersonalityNotice?: ((message: string) => void) | undefined;
  readonly onConfirmNotice?: ((message: string) => void) | undefined;
  readonly onTimeoutNotice?: ((message: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface AssistantSessionOptions {
  readonly config: AssistantConfig;
  readonly conversation: Conversation;
  readonly provider: LLMProvider;
  readonly model: string;
  readonly facts: FactsRepository;
  readonly conversations: ConversationRepository;
  readonly corrections: CorrectionsRepository;
  readonly toolExecutor: ToolExecutor | undefined;
  readonly onTurnComplete?:
    ((turn: CompletedTurn) => void | Promise<void>) | undefined;
  readonly onPersonalityNotice?: ((message: string) => void) | undefined;
  readonly onConfirmNotice?: ((message: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly onTimeoutNotice?: ((message: string) => void) | undefined;
}

/** One assistant, persistent across restarts. */
export class AssistantSession {
  readonly #options: AssistantSessionOptions;
  readonly #ledger = new ExecutionLedger();
  /** Names of the tools wired for this session. */
  #availableTools: readonly string[] = [];
  #onTimeoutNotice: ((message: string) => void) | undefined;
  #personality: string | undefined;

  public constructor(options: AssistantSessionOptions) {
    this.#options = options;
    this.#onTimeoutNotice = options.onTimeoutNotice;
  }

  /** Records the tool names wired for this session. */
  public setAvailableTools(names: readonly string[]): void {
    this.#availableTools = names;
  }

  /** Uses a ledger created by the factory so both share one instance. */
  public adopt(ledger: ExecutionLedger): void {
    this.#sharedLedger = ledger;
  }

  #sharedLedger: ExecutionLedger | undefined;
  /** Memories and corrections selected for the turn now in flight. */
  public lastContext: { memories: string[]; corrections: string[] } = {
    memories: [],
    corrections: [],
  };

  /** The personality block in use. */
  public get personality(): string {
    return this.#personality ?? '';
  }

  /** Loads the editable personality block, writing a default on first run. */
  public async loadPersonality(): Promise<string> {
    this.#personality = await loadPersonality(
      defaultPersonalityPath(this.#options.config.homeDirectory),
      this.#options.onPersonalityNotice,
    );
    return this.#personality;
  }

  /**
   * Shows the one-time notice that the dangerous-command gate is weaker than
   * the original voice-paired design. Never silently downgraded.
   */
  public async maybeWarnTextConfirm(): Promise<void> {
    if (this.#options.config.textConfirmMode !== 'safe-word') return;
    const marker = textConfirmNoticePath(this.#options.config.homeDirectory);
    try {
      await access(marker);
      return; // already warned in a previous session
    } catch {
      // not yet warned
    }
    await mkdir(this.#options.config.homeDirectory, { recursive: true }).catch(
      () => undefined,
    );
    await writeFile(marker, new Date().toISOString(), 'utf8').catch(
      () => undefined,
    );
    this.#options.onConfirmNotice?.(
      'Heads up: voice pairing is paused, so a dangerous command in text mode is ' +
        'confirmed by the typed safe word alone. This is weaker than the ' +
        'original design and is temporary. Set ATLAS_TEXT_CONFIRM_MODE=block to ' +
        'refuse dangerous commands until voice returns.',
    );
  }

  /** Selects the memories and corrections relevant to this message. */
  public selectContext(message: string): {
    memories: string[];
    corrections: string[];
  } {
    const facts = this.#options.facts.getAllFacts();
    const corrections = this.#options.corrections.relevant(
      message,
      this.#options.config.memoryLimit,
    );
    const rankedFacts = rankFacts(
      message,
      facts,
      {
        limit: this.#options.config.memoryLimit,
        minScore: this.#options.config.memoryMinScore,
        recencyHalfLifeDays: this.#options.config.memoryHalfLifeDays,
      },
      this.#options.now?.() ?? Date.now(),
    );
    const rankedCorrections = rankCorrections(message, corrections, {
      limit: this.#options.config.memoryLimit,
    });
    const merged = mergeMemories(
      [rankedCorrections, rankedFacts],
      this.#options.config.memoryLimit,
    );
    return {
      corrections: rankedCorrections.map((entry) => entry.text),
      memories: merged
        .filter((entry) => entry.kind === 'fact')
        .map((entry) => entry.text),
    };
  }

  /**
   * Handles one line of user input and returns the narration plus any separated
   * execution detail.
   */
  public async handleInput(text: string): Promise<TurnResult> {
    return this.#runTurn(text, undefined);
  }

  /**
   * Runs a turn, delivering narration as it is generated.
   *
   * Returns exactly the same {@link TurnResult} as `handleInput` — streaming
   * is an additional live view, never a different outcome. Tool calls, the
   * permission gate, memory writes, and the execution ledger are untouched:
   * the callback only changes how narration is delivered.
   *
   * With a provider that cannot stream, the callback fires once with the
   * finished narration, so a caller never needs to branch on support.
   */
  public async handleInputStreaming(
    text: string,
    onNarration: (delta: string) => void,
  ): Promise<TurnResult> {
    return this.#runTurn(text, onNarration);
  }

  async #runTurn(
    text: string,
    onNarration: ((delta: string) => void) | undefined,
  ): Promise<TurnResult> {
    const message = text.trim();
    this.ledger.reset();
    if (message === '') {
      return {
        narration: '',
        detail: '',
        memoriesUsed: [],
        correctionsApplied: [],
        executed: false,
      };
    }

    const context = this.selectContext(message);
    this.lastContext = context;
    // Each turn carries only the memory and corrections relevant to it.
    this.#options.conversation.setSystemPrompt(
      buildTurnPrompt({
        personality: this.personality,
        corrections: context.corrections,
        facts: context.memories,
        availableTools: this.#availableTools,
      }),
    );

    const response = await this.#options.conversation.send(
      this.#options.provider,
      message,
      onNarration === undefined ? {} : { onNarrationDelta: onNarration },
    );

    const raw = response.content ?? '';
    const narration = stripExecutionLeakage(raw);
    return {
      narration,
      detail: this.#options.config.showExecutionDetail
        ? this.ledger.detailBlock()
        : '',
      memoriesUsed: context.memories,
      correctionsApplied: context.corrections,
      executed: this.ledger.hasWork,
    };
  }

  /**
   * Waits for pending turn-completion work, such as fact and correction
   * extraction.
   *
   * This must be awaited before exiting, otherwise the process can terminate
   * before a fact or correction is written, which is exactly the failure mode
   * where a correction is lost at the end of a session.
   */
  public async flush(timeoutMs = 30_000): Promise<void> {
    // Extraction uses the model, which can be slow. Exiting must not hang
    // indefinitely waiting for it, but it must be given a real chance so a
    // correction is not lost on the way out.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        this.#options.conversation.flush().then(() => 'done' as const),
        deadline,
      ]);
      if (outcome === 'timeout') {
        this.#onTimeoutNotice?.(
          'Atlas still had background memory work running, so it was not ' +
            'waited for. Anything learned in the last few seconds may not be saved.',
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The ledger for the current turn. */
  public get ledger(): ExecutionLedger {
    return this.#sharedLedger ?? this.#ledger;
  }
}

/**
 * Builds a session and its conversation together.
 *
 * The recording executor has to be handed to the Conversation at construction,
 * which is why this is a factory rather than something `handleInput` can fix
 * later.
 */
export async function createAssistantSession(
  options: CreateSessionOptions,
): Promise<AssistantSession> {
  const ledger = new ExecutionLedger();
  const executor =
    options.toolExecutor === undefined
      ? undefined
      : new RecordingToolExecutor(options.toolExecutor, ledger);
  const conversation = new Conversation({
    model: options.model,
    ...(options.maxTokens === undefined
      ? {}
      : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    conversationRepository: options.conversationRepository,
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
    historyLimit: options.config.historyLimit,
    maxToolIterations: options.config.maxToolIterations,
    toolChoice: 'auto',
    ...(executor === undefined ? {} : { toolExecutor: executor }),
    ...(options.tools.length === 0 ? {} : { tools: options.tools }),
    ...(options.onTurnComplete === undefined
      ? {}
      : { onTurnComplete: options.onTurnComplete }),
  });
  const session = new AssistantSession({
    config: options.config,
    conversation,
    provider: options.provider,
    model: options.model,
    facts: options.facts,
    conversations: options.conversationRepository,
    corrections: options.corrections,
    toolExecutor: options.toolExecutor,
    ...(options.onTurnComplete === undefined
      ? {}
      : { onTurnComplete: options.onTurnComplete }),
    ...(options.onPersonalityNotice === undefined
      ? {}
      : { onPersonalityNotice: options.onPersonalityNotice }),
    ...(options.onConfirmNotice === undefined
      ? {}
      : { onConfirmNotice: options.onConfirmNotice }),
    ...(options.onTimeoutNotice === undefined
      ? {}
      : { onTimeoutNotice: options.onTimeoutNotice }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  session.adopt(ledger);
  session.setAvailableTools(options.tools.map((tool) => tool.name));
  await session.loadPersonality();
  await session.maybeWarnTextConfirm();
  return session;
}

/** Narration and detail are separate outputs; neither is empty by default. */
export function splitForVoice(turn: TurnResult): {
  speak: string;
  show: string;
} {
  return { speak: turn.narration, show: turn.detail };
}

/** Facts repository type re-export so callers need one import. */
export type { MemoryFact, ChatCompletionResponse, AtlasError };
