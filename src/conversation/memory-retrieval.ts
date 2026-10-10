/**
 * Per-turn memory retrieval.
 *
 * Injecting every stored fact every turn does not scale, and most of it is
 * irrelevant to what is being asked. This scores durable facts by keyword
 * overlap with the current message plus recency, so a short focused prompt
 * carries only what it needs. Semantic retrieval can replace this later
 * without changing the callers.
 */
import type { MemoryFact } from '../memory/facts-repository.js';
import {
  deriveTriggerTerms,
  type AssistantCorrection,
} from '../memory/corrections-repository.js';

/** One memory selected for injection. */
export interface RetrievedMemory {
  readonly kind: 'fact' | 'correction';
  readonly text: string;
  readonly score: number;
}

/** Tuning for the retrieval pass. */
export interface RetrievalOptions {
  /** Maximum memories injected per turn. */
  readonly limit?: number;
  /** Score above which a memory is considered relevant. */
  readonly minScore?: number;
  /** Half-life in days for the recency term. */
  readonly recencyHalfLifeDays?: number;
  /** Always include recent facts even with no keyword overlap. */
  readonly alwaysRecent?: number;
}

const DEFAULTS: Required<RetrievalOptions> = {
  limit: 8,
  minScore: 1,
  recencyHalfLifeDays: 14,
  alwaysRecent: 3,
};

function recencyScore(iso: string, now: number, halfLifeDays: number): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  const ageDays = Math.max(0, (now - then) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Scores facts against a message.
 *
 * A keyword hit is worth one point; recency contributes up to one more, so a
 * slightly older but clearly relevant fact still beats a fresh unrelated one.
 */
export function rankFacts(
  message: string,
  facts: readonly MemoryFact[],
  options: RetrievalOptions = {},
  now: number = Date.now(),
): RetrievedMemory[] {
  const settings = { ...DEFAULTS, ...options };
  const terms = new Set(deriveTriggerTerms(message, 60));

  const scored = facts.map((fact) => {
    const factTerms = deriveTriggerTerms(fact.content, 40);
    const overlap = factTerms.filter((term) => terms.has(term)).length;
    const recency = recencyScore(
      fact.updatedAt,
      now,
      settings.recencyHalfLifeDays,
    );
    return {
      fact,
      score: overlap + recency,
      overlap,
    };
  });

  const matched = scored
    .filter((entry) => entry.overlap > 0 && entry.score >= settings.minScore)
    .sort((left, right) => right.score - left.score);

  // Even with no keyword hit, the most recent facts are usually worth having.
  const recent = scored
    .filter((entry) => entry.overlap === 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, settings.alwaysRecent);

  return [...matched, ...recent].slice(0, settings.limit).map((entry) => ({
    kind: 'fact' as const,
    text: entry.fact.content,
    score: Number(entry.score.toFixed(3)),
  }));
}

/** Scores standing corrections against a message; corrections outrank facts. */
export function rankCorrections(
  message: string,
  corrections: readonly AssistantCorrection[],
  options: RetrievalOptions = {},
): RetrievedMemory[] {
  const settings = { ...DEFAULTS, ...options };
  const terms = new Set(deriveTriggerTerms(message, 60));

  return (
    corrections
      .map((correction) => {
        const overlap = correction.triggerTerms.filter((term) =>
          terms.has(term),
        ).length;
        return { correction, score: overlap };
      })
      .filter((entry) => entry.score > 0)
      // More shared terms means more clearly relevant.
      .sort((left, right) => right.score - left.score)
      .slice(0, settings.limit)
      .map((entry) => ({
        kind: 'correction' as const,
        text: entry.correction.instruction,
        score: Number((entry.score + 1).toFixed(3)),
      }))
  );
}

/** Merges facts and corrections, de-duplicating on text. */
export function mergeMemories(
  groups: readonly (readonly RetrievedMemory[])[],
  limit: number,
): RetrievedMemory[] {
  const seen = new Set<string>();
  const out: RetrievedMemory[] = [];
  for (const memory of groups.flat()) {
    const key = memory.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(memory);
    if (out.length >= limit) break;
  }
  return out;
}
