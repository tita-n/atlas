import { z } from 'zod';
import type {
  ChatCompletionResponse,
  LLMProvider,
} from '../providers/provider.interface.js';
import { MemoryOperationError } from '../errors.js';
import type { FactsRepository, MemoryFact } from './facts-repository.js';

const extractedFactsSchema = z.object({
  facts: z
    .array(
      z.object({
        content: z.string().trim().min(1).max(500),
        category: z.string().trim().min(1).max(80).nullable().optional(),
        quote: z.string().trim().max(600).optional(),
      }),
    )
    .max(10),
});

/** User and assistant text from one completed exchange. */
export interface FactExtractionExchange {
  /** The user's message. */
  userContent: string;
  /** The assistant's response, included for context only. */
  assistantContent: string;
  /** Persisted user message ID used as the fact source. */
  sourceMessageId?: number | null | undefined;
}

/** One fact returned by the extraction model. */
export interface ExtractedFact {
  /** Standalone durable fact. */
  content: string;
  /** Optional flexible category. */
  category: string | null;
  /**
   * Verbatim span of the user message that supports this fact.
   *
   * Absent or non-matching quotes mean the fact is rejected rather than stored.
   */
  quote: string;
}

/** Dependencies for the asynchronous fact extractor. */
export interface FactExtractorOptions {
  /** Existing provider abstraction used for the extraction call. */
  provider: LLMProvider;
  /** Repository where accepted facts are stored. */
  factsRepository: FactsRepository;
  /** Model used for the lightweight extraction request. */
  model: string;
  /** Optional extraction output limit. */
  maxTokens?: number | undefined;
}

function jsonObjectFromText(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses the extractor's deliberately narrow JSON response format. */
export function parseFactExtraction(text: string): ExtractedFact[] {
  const payload = jsonObjectFromText(text);
  if (payload === undefined) return [];
  const parsed = extractedFactsSchema.safeParse(payload);
  if (!parsed.success) return [];

  return parsed.data.facts.map((fact) => {
    const category = fact.category?.trim();
    return {
      content: fact.content.trim(),
      category: category === undefined || category === '' ? null : category,
      quote: typeof fact.quote === 'string' ? fact.quote.trim() : '',
    };
  });
}

/**
 * Whether a quoted span genuinely occurs in what the user actually said.
 *
 * Whitespace is collapsed on both sides so a model that reformats the quote
 * slightly still matches, but the words themselves must be present. An empty or
 * absent quote fails: a fact that cannot cite its own evidence is not stored.
 */
export function isSupportedByUserText(
  quote: string,
  userText: string,
): boolean {
  const normalize = (value: string): string =>
    value.replace(/\s+/g, ' ').trim().toLowerCase();
  const cited = normalize(quote);
  if (cited === '') return false;
  return normalize(userText).includes(cited);
}

/** Performs conservative, non-blocking durable-fact extraction. */
export class FactExtractor {
  readonly #provider: LLMProvider;
  readonly #factsRepository: FactsRepository;
  readonly #model: string;
  readonly #maxTokens: number;

  public constructor(options: FactExtractorOptions) {
    this.#provider = options.provider;
    this.#factsRepository = options.factsRepository;
    this.#model = options.model;
    // Reasoning models spend the first part of the budget thinking, so a
    // small cap truncates before any JSON is emitted.
    this.#maxTokens = options.maxTokens ?? 1_200;
  }

  /** Extracts and stores only new, durable user facts from one exchange. */
  public async extractAndStore(
    exchange: FactExtractionExchange,
  ): Promise<MemoryFact[]> {
    if (exchange.userContent.trim() === '') return [];

    let response: ChatCompletionResponse;
    try {
      response = await this.#provider.chatCompletion({
        model: this.#model,
        maxTokens: this.#maxTokens,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Extract durable facts about the user from the exchange. ' +
              'Only store facts explicitly stated by the user, such as identity, ' +
              'stable preferences, ongoing projects, or corrections. ' +
              'Do not store opinions, one-off task details, assistant statements, ' +
              'or guesses. ' +
              'For EVERY fact you must also give "quote": the exact, verbatim ' +
              'span of the USER message that states it, copied character for ' +
              'character. If you cannot quote supporting text, do not report ' +
              'the fact at all. A fact that cannot be quoted is invented. ' +
              'Return JSON only in the form ' +
              '{"facts":[{"content":"standalone fact","category":"optional tag",' +
              '"quote":"exact words from the user message"}]}. ' +
              'Return {"facts":[]} when nothing qualifies.' +
              ' Output ONLY a JSON object as plain text. Do not call any tools. Do not write anything other than the JSON.',
          },
          {
            role: 'user',
            content:
              `User message:\n"""\n${exchange.userContent}\n"""\n\n` +
              `Assistant response for context:\n"""\n${exchange.assistantContent}\n"""`,
          },
        ],
      });
    } catch (error) {
      // Swallowing this made memory look broken with no clue why.
      throw new MemoryOperationError('Fact extraction request failed.', {
        cause: error,
      });
    }

    // A truncated reply contains no JSON at all. Reasoning models burn the
    // budget before answering, so retry with more room rather than storing
    // nothing and losing a fact.
    if (response.content.trim() === '') {
      response = await this.#provider.chatCompletion({
        model: this.#model,
        maxTokens: this.#maxTokens * 3,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Extract durable facts about the user from the exchange. ' +
              'Reply with JSON only: {"facts":[{"content":"...","category":"..."}]}. ' +
              'Return {"facts":[]} when nothing qualifies. ' +
              'Output ONLY a JSON object as plain text. Do not call any tools.',
          },
          {
            role: 'user',
            content: exchange.userContent.slice(0, 800),
          },
        ],
      });
    }

    const userText = exchange.userContent;
    // A claimed fact is only real if the model can point at the words in the
    // user's own message that say so. Without this check the extractor writes
    // whatever the model invents into durable memory, and every later turn
    // receives it as authoritative.
    const extracted = parseFactExtraction(response.content).filter((fact) =>
      isSupportedByUserText(fact.quote, userText),
    );
    const existing = new Set(
      this.#factsRepository
        .getAllFacts()
        .map((fact) => fact.content.trim().toLowerCase()),
    );
    const stored: MemoryFact[] = [];

    for (const fact of extracted) {
      const key = fact.content.toLowerCase();
      if (existing.has(key)) continue;
      const saved = this.#factsRepository.addFact(
        fact.content,
        fact.category,
        exchange.sourceMessageId ?? null,
      );
      existing.add(key);
      stored.push(saved);
    }

    return stored;
  }
}
