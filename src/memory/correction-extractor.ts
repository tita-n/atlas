/**
 * Extracts standing corrections from a completed exchange.
 *
 * Uses the same lightweight provider call as the fact extractor, so a
 * correction is recognised in the same turn it happens and written to memory
 * before the session ends. Nothing here trains a model: the result is an
 * instruction that is retrieved and injected into later prompts.
 */
import { z } from 'zod';

import type { LLMProvider } from '../providers/provider.interface.js';
import { MemoryOperationError } from '../errors.js';
import type { CorrectionsRepository } from '../memory/corrections-repository.js';

const extractedSchema = z.object({
  corrections: z
    .array(
      z.object({
        instruction: z.string().trim().min(3).max(300),
        triggerTerms: z
          .array(z.string().trim().min(2).max(40))
          .max(12)
          .optional(),
      }),
    )
    .max(3),
});

/** One correction returned by the model. */
export interface ExtractedCorrection {
  readonly instruction: string;
  readonly triggerTerms: readonly string[];
}

/** Phrases that mark a correction without needing the model at all. */
const CORRECTION_MARKERS = [
  'no, ',
  'no ',
  "that's wrong",
  'thats wrong',
  'that is wrong',
  'incorrect',
  'not what i',
  "don't do that",
  'dont do that',
  'stop doing that',
  'never do that',
  'i told you',
  'i already said',
  "that's not",
  'thats not',
];

/** Fast path: does this message plainly correct the assistant? */
export function looksLikeCorrection(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized === '') return false;
  return CORRECTION_MARKERS.some((marker) => normalized.startsWith(marker));
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

export interface CorrectionExtractorOptions {
  readonly provider: LLMProvider;
  readonly correctionsRepository: CorrectionsRepository;
  readonly model: string;
  readonly maxTokens?: number | undefined;
}

/** One exchange to inspect for corrections. */
export interface CorrectionExchange {
  userContent: string;
  assistantContent: string;
  sourceMessageId?: number | null | undefined;
}

/** Asks the model for standing corrections and stores them. */
export class CorrectionExtractor {
  readonly #options: CorrectionExtractorOptions;

  public constructor(options: CorrectionExtractorOptions) {
    this.#options = options;
  }

  /** Extracts and stores corrections; resolves to the IDs written. */
  public async extractAndStore(
    exchange: CorrectionExchange,
  ): Promise<number[]> {
    const user = exchange.userContent.trim();
    if (user === '') return [];

    const parsed = this.#parse(
      await this.#ask(user, exchange.assistantContent),
    );
    const ids: number[] = [];
    for (const correction of parsed) {
      try {
        ids.push(
          this.#options.correctionsRepository.record({
            instruction: correction.instruction,
            triggerTerms: correction.triggerTerms,
            ...(exchange.sourceMessageId === undefined
              ? {}
              : { sourceMessageId: exchange.sourceMessageId }),
          }),
        );
      } catch {
        // A failed write must not break the turn.
      }
    }
    return ids;
  }

  async #ask(user: string, assistant: string): Promise<string> {
    const first = await this.#call(
      user,
      assistant,
      this.#options.maxTokens ?? 1_200,
    );
    // A truncated response has no JSON in it; retry with more room.
    if (first.trim() === '') {
      return this.#call(user, assistant, 3_000);
    }
    return first;
  }

  async #call(
    user: string,
    assistant: string,
    maxTokens: number,
  ): Promise<string> {
    try {
      const response = await this.#options.provider.chatCompletion({
        model: this.#options.model,
        maxTokens,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You spot standing corrections a user makes to an assistant. ' +
              'Return a correction only when the user tells the assistant to ' +
              'stop, change, or always do something a particular way. ' +
              'Write each as an instruction for the assistant, in the second ' +
              'person, such as "Never abbreviate the project name agora". ' +
              'Give short trigger terms that mark when it applies. ' +
              'If the user is not correcting the assistant, return an empty list. ' +
              'Reply with JSON only: {"corrections":[{"instruction":"...",' +
              '"triggerTerms":["..."]}]}. ' +
              'Output ONLY a JSON object as plain text. Do not call any tools.',
          },
          {
            role: 'user',
            content: `Assistant said:\n${assistant.slice(0, 800)}\n\nUser then said:\n${user.slice(0, 800)}`,
          },
        ],
      });
      return response.content ?? '';
    } catch (error) {
      // Previously swallowed, so a failing provider looked like "no
      // corrections found" rather than a broken memory layer.
      throw new MemoryOperationError('Correction extraction request failed.', {
        cause: error,
      });
    }
  }

  #parse(text: string): ExtractedCorrection[] {
    const value = jsonObjectFromText(text);
    if (value === undefined) return [];
    const parsed = extractedSchema.safeParse(value);
    if (!parsed.success) return [];
    return parsed.data.corrections.map((correction) => ({
      instruction: correction.instruction,
      triggerTerms: correction.triggerTerms ?? [],
    }));
  }
}
