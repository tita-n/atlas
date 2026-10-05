/**
 * Streaming turn events, and the per-provider assemblers that produce them.
 *
 * The two provider wire formats are genuinely different, and are handled as
 * such rather than forced into a shared assumption:
 *
 * OpenAI-compatible sends one chunk per choice. Tool calls arrive as
 * `delta.tool_calls` entries identified by a stable `index`, whose `function`
 * pieces (name once, then `arguments` as JSON *fragments*) must be concatenated
 * in index order. There is no explicit "block finished" signal; a call is
 * complete only when the stream ends.
 *
 * Anthropic-compatible sends a sequence of typed events instead. A tool call
 * opens with `content_block_start` carrying the id, name, and an empty input,
 * accumulates `input_json_delta` fragments under `content_block_stop`, and the
 * whole message closes with `message_delta`/`message_stop`.
 *
 * Tool-call content is never surfaced as text: assemblers emit `text` events
 * only for genuine narration, and hold every tool fragment back until a
 * complete, parseable call exists. That is what keeps a half-received
 * `{"command":"rm -rf` from ever reaching the screen.
 */

import { ProviderResponseError } from '../errors.js';
import { decodeToolArguments, validateToolInput } from './tool-arguments.js';
import type { CompletionUsage, ToolCall } from './provider.interface.js';

/** One step of a streaming turn. */
export type StreamEvent =
  /** A chunk of conversational narration, safe to display immediately. */
  | { readonly type: 'text'; readonly text: string }
  /** Complete tool calls, emitted only once every argument parses. */
  | { readonly type: 'tool_calls'; readonly toolCalls: readonly ToolCall[] }
  | {
      readonly type: 'done';
      readonly finishReason?: string;
      readonly usage?: CompletionUsage;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/* ------------------------------------------------------------------ *
 * OpenAI-compatible
 * ------------------------------------------------------------------ */

interface OpenAIToolAccumulator {
  id: string;
  name: string;
  arguments: string;
  /** Set once the provider has given this call an identity. */
  sawCall: boolean;
}

/**
 * Assembles OpenAI-compatible SSE chunks.
 *
 * Stateless with respect to narration: each text delta is emitted as it
 * arrives, while tool calls accumulate in index order.
 */
export class OpenAIStreamAssembler {
  readonly #provider: string;
  readonly #tools = new Map<number, OpenAIToolAccumulator>();
  #finishReason: string | undefined;
  #inputTokens: number | undefined;
  #outputTokens: number | undefined;

  public constructor(provider: string) {
    this.#provider = provider;
  }

  /**
   * Token counts, when the stream reported any.
   *
   * A stream may report only one side, so the missing side is reported as 0
   * rather than dropping the whole record. A usage event with neither side
   * reported is omitted entirely rather than reported as all zeros.
   */
  public get usage(): CompletionUsage | undefined {
    if (this.#inputTokens === undefined && this.#outputTokens === undefined) {
      return undefined;
    }
    return {
      inputTokens: this.#inputTokens ?? 0,
      outputTokens: this.#outputTokens ?? 0,
    };
  }

  /** Feeds one parsed SSE payload, returning the events it produced. */
  public push(payload: unknown): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (!isRecord(payload)) return events;

    if (isRecord(payload.usage)) {
      if (typeof payload.usage.prompt_tokens === 'number') {
        this.#inputTokens = payload.usage.prompt_tokens;
      }
      if (typeof payload.usage.completion_tokens === 'number') {
        this.#outputTokens = payload.usage.completion_tokens;
      }
    }

    const choices = payload.choices;
    if (!Array.isArray(choices)) return events;

    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      if (typeof choice.finish_reason === 'string') {
        this.#finishReason = choice.finish_reason;
      }
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (delta === undefined) continue;

      // Narration only. Tool fragments never pass through here.
      if (typeof delta.content === 'string' && delta.content !== '') {
        events.push({ type: 'text', text: delta.content });
      }

      const calls = delta.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!isRecord(call)) continue;
        this.#accumulate(call);
      }
    }
    return events;
  }

  #accumulate(call: Record<string, unknown>): void {
    const index = typeof call.index === 'number' ? call.index : 0;
    let entry = this.#tools.get(index);
    if (entry === undefined) {
      entry = { id: '', name: '', arguments: '', sawCall: false };
      this.#tools.set(index, entry);
    }
    if (typeof call.id === 'string' && call.id !== '') entry.id = call.id;
    entry.sawCall = true;
    const fn = isRecord(call.function) ? call.function : undefined;
    if (fn === undefined) return;
    if (typeof fn.name === 'string' && fn.name !== '') entry.name = fn.name;
    // Arguments arrive as JSON fragments; order matters, so append only.
    if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
  }

  /**
   * Finishes the stream and emits the terminal event.
   *
   * Tool calls are decoded here, which is the earliest point at which their
   * arguments can possibly be complete JSON.
   */
  public finish(): StreamEvent[] {
    const toolCalls: ToolCall[] = [];
    // Ascending index order, so multi-call turns keep the provider's order.
    for (const index of [...this.#tools.keys()].sort((a, b) => a - b)) {
      const entry = this.#tools.get(index);
      if (entry?.sawCall !== true) continue;
      if (entry.name === '') {
        throw new ProviderResponseError(
          this.#provider,
          'streamed tool call is missing its function name',
        );
      }
      toolCalls.push({
        id: entry.id === '' ? `call_${index}` : entry.id,
        name: entry.name,
        arguments: decodeToolArguments(entry.arguments, this.#provider),
      });
    }

    const events: StreamEvent[] = [];
    if (toolCalls.length > 0) events.push({ type: 'tool_calls', toolCalls });
    const usage = this.usage;
    events.push({
      type: 'done',
      ...(this.#finishReason === undefined
        ? {}
        : { finishReason: this.#finishReason }),
      ...(usage === undefined ? {} : { usage }),
    });
    return events;
  }
}

/* ------------------------------------------------------------------ *
 * Anthropic-compatible
 * ------------------------------------------------------------------ */

interface AnthropicBlockAccumulator {
  kind: 'text' | 'tool' | 'unknown';
  id: string;
  name: string;
  /** JSON fragments for a tool block; unused for text blocks. */
  partialJson: string;
  /** Some servers inline the full input at block start instead of streaming it. */
  inlineInput: unknown;
}

/**
 * Assembles Anthropic-compatible SSE events.
 *
 * Unlike the OpenAI format this one does have explicit block boundaries, so a
 * tool call can be completed at `content_block_stop` rather than at the end of
 * the stream.
 */
export class AnthropicStreamAssembler {
  readonly #provider: string;
  readonly #blocks = new Map<number, AnthropicBlockAccumulator>();
  #finishReason: string | undefined;
  #inputTokens: number | undefined;
  #outputTokens: number | undefined;
  /** Tool calls already emitted, so a block is never emitted twice. */
  readonly #emitted = new Set<number>();

  public constructor(provider: string) {
    this.#provider = provider;
  }

  /** See {@link OpenAIStreamAssembler.usage} for the missing-side rule. */
  public get usage(): CompletionUsage | undefined {
    if (this.#inputTokens === undefined && this.#outputTokens === undefined) {
      return undefined;
    }
    return {
      inputTokens: this.#inputTokens ?? 0,
      outputTokens: this.#outputTokens ?? 0,
    };
  }

  public push(payload: unknown): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (!isRecord(payload)) return events;
    const type = typeof payload.type === 'string' ? payload.type : '';

    if (type === 'content_block_start') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const block = isRecord(payload.content_block)
        ? payload.content_block
        : undefined;
      const blockType =
        block !== undefined && typeof block.type === 'string'
          ? block.type
          : 'unknown';
      this.#blocks.set(index, {
        kind:
          blockType === 'text'
            ? 'text'
            : blockType === 'tool_use'
              ? 'tool'
              : 'unknown',
        id: block !== undefined && typeof block.id === 'string' ? block.id : '',
        name:
          block !== undefined && typeof block.name === 'string'
            ? block.name
            : '',
        partialJson: '',
        inlineInput: block === undefined ? undefined : block.input,
      });
      // A text block may legitimately start with its opening text inline.
      if (
        block !== undefined &&
        blockType === 'text' &&
        typeof block.text === 'string' &&
        block.text !== ''
      ) {
        events.push({ type: 'text', text: block.text });
      }
      return events;
    }

    if (type === 'content_block_delta') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      if (delta === undefined) return events;
      const entry = this.#blocks.get(index);
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (delta.text !== '') events.push({ type: 'text', text: delta.text });
        return events;
      }
      if (delta.type === 'input_json_delta') {
        const partial = delta.partial_json;
        if (typeof partial === 'string' && partial !== '') {
          if (entry !== undefined) entry.partialJson += partial;
          else {
            this.#blocks.set(index, {
              kind: 'tool',
              id: '',
              name: '',
              partialJson: partial,
              inlineInput: undefined,
            });
          }
        }
      }
      return events;
    }

    if (type === 'content_block_stop') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const event = this.#completeBlock(index);
      if (event !== undefined) events.push(event);
      return events;
    }

    if (type === 'message_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      if (delta !== undefined && typeof delta.stop_reason === 'string') {
        this.#finishReason = delta.stop_reason;
      }
      const usage = isRecord(payload.usage) ? payload.usage : undefined;
      if (usage !== undefined) {
        if (typeof usage.input_tokens === 'number') {
          this.#inputTokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === 'number') {
          this.#outputTokens = usage.output_tokens;
        }
      }
      return events;
    }

    if (type === 'message_start') {
      const message = isRecord(payload.message) ? payload.message : undefined;
      const usage =
        message !== undefined && isRecord(message.usage)
          ? message.usage
          : undefined;
      if (usage !== undefined && typeof usage.input_tokens === 'number') {
        this.#inputTokens = usage.input_tokens;
      }
    }

    return events;
  }

  /** Builds the tool call for a finished block, or undefined if not a tool. */
  #completeBlock(index: number): StreamEvent | undefined {
    if (this.#emitted.has(index)) return undefined;
    const entry = this.#blocks.get(index);
    if (entry?.kind !== 'tool') return undefined;
    this.#emitted.add(index);
    if (entry.name === '') {
      throw new ProviderResponseError(
        this.#provider,
        'streamed tool use is missing its name',
      );
    }
    // Prefer streamed fragments; fall back to an inlined input object.
    const args =
      entry.partialJson.trim() === ''
        ? validateToolInput(entry.inlineInput ?? {}, this.#provider)
        : decodeToolArguments(entry.partialJson, this.#provider);
    return {
      type: 'tool_calls',
      toolCalls: [
        {
          id: entry.id === '' ? `toolu_${index}` : entry.id,
          name: entry.name,
          arguments: args,
        },
      ],
    };
  }

  public finish(): StreamEvent[] {
    const events: StreamEvent[] = [];
    // A stream that ended without content_block_stop still has complete
    // arguments; recover them rather than silently dropping the call.
    for (const index of [...this.#blocks.keys()].sort((a, b) => a - b)) {
      const event = this.#completeBlock(index);
      if (event !== undefined) events.push(event);
    }
    const usage = this.usage;
    events.push({
      type: 'done',
      ...(this.#finishReason === undefined
        ? {}
        : { finishReason: this.#finishReason }),
      ...(usage === undefined ? {} : { usage }),
    });
    return events;
  }
}
