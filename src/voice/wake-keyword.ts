/**
 * Wake-keyword helpers for sherpa-onnx keyword spotting.
 *
 * A sherpa keyword model takes a PRE-TOKENISED keyword list: every
 * whitespace-separated token is looked up verbatim in the model's
 * `tokens.txt`, and the resulting sequence becomes a hard constraint in the
 * beam-search context graph. An out-of-vocabulary token aborts the model, and
 * a valid-but-wrong segmentation (or a keyword with no boost) simply never
 * scores high enough to fire.
 *
 * Line format, per sherpa-onnx:
 *   <token> [<token> ...] [:boost] [#threshold] [@display phrase]
 * `:boost` and `#threshold` are optional PER-LINE suffixes placed at the END of
 * the line. There is no "boost the first token" convention: the boost is
 * applied to every token in the line, and longer keywords accumulate more.
 * See https://github.com/k2-fsa/sherpa-onnx/issues/2678, where an English
 * keyword on this exact model went from ~10% detection to working purely by
 * generating the tokens with `text2token` and appending `:2.0 #0.2`.
 */
import { readFile } from 'node:fs/promises';

/** Raised when a keyword cannot be expressed in the model's vocabulary. */
export class KeywordFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KeywordFormatError';
  }
}

/** Default boost and acoustic threshold, from the upstream working example. */
export const DEFAULT_KEYWORD_BOOST = 2.0;
export const DEFAULT_KEYWORD_THRESHOLD = 0.2;

/** Reads the model vocabulary from a `tokens.txt` file. */
export async function readVocabulary(tokensPath: string): Promise<Set<string>> {
  const text = await readFile(tokensPath, 'utf8');
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim().split(' ')[0])
      .filter((token): token is string => token !== '' && token !== undefined),
  );
}

/** Splits a phrase into words, uppercased, dropping punctuation. */
function words(phrase: string): string[] {
  return phrase
    .toUpperCase()
    .split(/[^A-Z0-9']+/)
    .filter((word) => word !== '');
}

/**
 * Every valid tokenization of one word, shortest-first.
 *
 * Greedy longest-match is NOT the model's tokenizer: for ATLAS the vocabulary
 * admits both `▁AT LA S` and `▁AT L AS`, and only one of them matches how the
 * model was trained. Every segmentation that resolves entirely to real tokens
 * is therefore enumerated and tried in turn.
 */
export function* segmentWord(
  word: string,
  vocabulary: ReadonlySet<string>,
): Generator<string[]> {
  const letters = Array.from(word);

  function* build(index: number, acc: string[]): Generator<string[]> {
    if (index === letters.length) {
      yield [...acc];
      return;
    }
    for (let take = letters.length - index; take >= 1; take -= 1) {
      const text = letters.slice(index, index + take).join('');
      const candidate = index === 0 ? `\u2581${text}` : text;
      if (vocabulary.has(candidate)) {
        yield* build(index + take, [...acc, candidate]);
      }
    }
  }

  const all = [...build(0, [])];
  all.sort((left, right) => left.length - right.length);
  yield* all;
}

/** All candidate token sequences for a phrase, shortest first. */
export async function candidateKeywordLines(
  phrase: string,
  tokensPath: string,
): Promise<string[][]> {
  const vocabulary = await readVocabulary(tokensPath);
  const phraseWords = words(phrase);
  if (phraseWords.length === 0) {
    throw new KeywordFormatError(
      `The wake phrase "${phrase}" contains no usable words.`,
    );
  }
  const perWord = phraseWords.map((word) => {
    const options = [...segmentWord(word, vocabulary)];
    if (options.length === 0) {
      throw new KeywordFormatError(
        `The wake phrase word "${word}" cannot be written with this model's vocabulary.`,
      );
    }
    return options;
  });
  // Cartesian product across words, each word's shortest segmentation first.
  let combinations: string[][] = [[]];
  for (const options of perWord) {
    const next: string[][] = [];
    for (const prefix of combinations) {
      for (const option of options) next.push([...prefix, ...option]);
    }
    combinations = next;
  }
  combinations.sort((a, b) => a.length - b.length);
  return combinations;
}

/** True when every token of a segmentation exists in the vocabulary. */
export function segmentationIsValid(
  tokens: readonly string[],
  vocabulary: ReadonlySet<string>,
): boolean {
  return tokens.every((token) => vocabulary.has(token));
}

/**
 * Builds a validated, boosted keyword line for a phrase.
 *
 * Throws rather than guessing when the phrase cannot be expressed, because a
 * silently wrong segmentation produces a wake word that never fires.
 */
export async function buildKeywordLine(
  phrase: string,
  tokensPath: string,
  options: { readonly boost?: number; readonly threshold?: number } = {},
): Promise<{ line: string; tokens: string[] }> {
  const vocabulary = await readVocabulary(tokensPath);
  const perWord = words(phrase).map((word) => {
    const options = [...segmentWord(word, vocabulary)];
    if (options.length === 0) {
      throw new KeywordFormatError(
        `The wake phrase word "${word}" cannot be written with this model's ` +
          'vocabulary.',
      );
    }
    const shortest = options[0];
    if (shortest === undefined) {
      throw new KeywordFormatError(
        `The wake phrase word "${word}" cannot be written with this model's vocabulary.`,
      );
    }
    return shortest;
  });
  const tokens = perWord.flat();
  if (tokens.length === 0) {
    throw new KeywordFormatError(`The wake phrase "${phrase}" has no words.`);
  }
  const boost = options.boost ?? DEFAULT_KEYWORD_BOOST;
  const threshold = options.threshold ?? DEFAULT_KEYWORD_THRESHOLD;
  // Boost and threshold are line suffixes, not per-position prefixes.
  const line = `${tokens.join(' ')} :${boost} #${threshold}`;
  return { line, tokens };
}

/** Parses a keyword line back into its tokens, ignoring the suffixes. */
export function parseKeywordTokens(line: string): string[] {
  const tokens: string[] = [];
  for (const part of line.trim().split(/\s+/)) {
    if (part === '') continue;
    // Everything from the first marker onwards is metadata. `@phrase` is a
    // multi-word display label, so filtering token by token would keep its
    // tail as though it were vocabulary.
    if (part.startsWith(':') || part.startsWith('#') || part.startsWith('@')) {
      break;
    }
    tokens.push(part);
  }
  return tokens;
}
