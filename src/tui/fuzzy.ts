/**
 * Fuzzy matching for the provider and model pickers.
 *
 * The established harnesses that do this well (Qwen Code's provider-scoped
 * picker, Telekinesis's type-to-search across configured providers, agent86's
 * filtered live catalogue) all match more than the display name: a user
 * searching a model wants to hit it whether they type the bare model id, the
 * provider name, or `provider/model`. So a candidate carries several searchable
 * forms and matches if any of them do.
 *
 * Matching is subsequence-based, so `gpt4o` finds `gpt-4o` and `cl35` finds
 * `claude-3-5`. Text is normalised first — NFKC, smart quotes, unicode dashes —
 * so a query typed with a curly apostrophe still matches.
 *
 * Pure and dependency-free: ranking is the part worth testing, and testing it
 * through a TUI would be slow and fragile.
 */

/** Folds the differences people actually hit when typing. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00A0/g, ' ');
}

/** Everything a candidate can be found by. */
export interface Searchable {
  /** The label shown to the user. */
  readonly label: string;
  /** Optional provider name, so "openai" finds OpenAI's models. */
  readonly provider?: string | undefined;
  /** The bare id, so "gpt-4o" matches without the provider prefix. */
  readonly id?: string | undefined;
}

/** A match with its rank; higher is better. */
export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  /** Characters of `label` that matched, for highlighting. */
  readonly positions: readonly number[];
}

const NO_MATCH = Number.POSITIVE_INFINITY;

function isSeparator(char: string): boolean {
  return /[^a-z0-9]/.test(char);
}

/**
 * Scores a subsequence match, rewarding matches that land on word boundaries.
 *
 * Returns `undefined` when the query is not a subsequence at all. A prefix match
 * outranks a mid-word one, because typing the start of a name is the strongest
 * signal of intent a short query gives.
 */
export function scoreMatch(
  candidate: string,
  query: string,
): { score: number; positions: readonly number[] } | undefined {
  const haystack = normalizeForSearch(candidate).toLowerCase();
  const needle = normalizeForSearch(query).toLowerCase().trim();
  if (needle === '') return { score: 0, positions: [] };
  if (needle.length > haystack.length) return undefined;

  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -1;

  for (const char of needle) {
    if (char === ' ') {
      // A space in the query just means "somewhere after here".
      cursor += 1;
      continue;
    }
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return undefined;

    positions.push(found);
    // Word-boundary and consecutive hits are worth much more than a stray
    // character match inside a long word.
    if (found === 0) score += 12;
    else if (isSeparator(haystack[found - 1] ?? 'a')) score += 9;
    else if (found === previous + 1) score += 6;
    else score += 1;
    // A gap costs, so "gpt4" prefers "gpt-4o" over "gpt-mini-4o-long".
    score -= Math.min(4, found - cursor - 1);
    previous = found;
    cursor = found + 1;
  }

  return { score, positions };
}

/**
 * Ranks candidates against a query, best first.
 *
 * A candidate matches on any of its searchable forms, and the best form wins.
 * An empty query keeps the caller's original order rather than re-sorting, so
 * an unfiltered list still reads in the order it was built.
 */
export function fuzzyFilter<T extends Searchable>(
  items: readonly T[],
  query: string,
): readonly Ranked<T>[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }

  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const forms = [item.label];
    if (item.id !== undefined) forms.push(item.id);
    if (item.provider !== undefined) {
      forms.push(`${item.provider}/${item.label}`);
      if (item.id !== undefined) forms.push(`${item.provider}/${item.id}`);
    }

    let best: { score: number; positions: readonly number[] } | undefined;
    for (const form of forms) {
      const result = scoreMatch(form, trimmed);
      if (result === undefined) continue;
      // Matching the label directly is a stronger signal than matching a
      // decorated `provider/model` form.
      const isLabel = form === item.label;
      const adjusted = isLabel ? result.score : result.score + 4;
      if (best === undefined || adjusted < best.score) {
        best = { score: adjusted, positions: result.positions };
      }
    }

    if (best !== undefined && best.score !== NO_MATCH) {
      ranked.push({ item, score: best.score, positions: best.positions });
    }
  }

  // Best score first; among equally good matches prefer the shorter name,
  // which is what makes "gpt" put gpt-5 above gpt-4.1-mini. Ties beyond that
  // keep their original order so the list does not jump as the user types.
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (b.entry.score !== a.entry.score) return b.entry.score - a.entry.score;
      const byLength = a.entry.item.label.length - b.entry.item.label.length;
      return byLength !== 0 ? byLength : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** Index positions of `query` within `label`, for highlighting. */
export function highlightPositions(
  label: string,
  query: string,
): readonly number[] {
  return scoreMatch(label, query)?.positions ?? [];
}
