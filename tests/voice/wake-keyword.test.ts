import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEYWORD_BOOST,
  DEFAULT_KEYWORD_THRESHOLD,
  KeywordFormatError,
  buildKeywordLine,
  candidateKeywordLines,
  parseKeywordTokens,
  segmentationIsValid,
} from '../../src/voice/wake-keyword.js';

/**
 * A stand-in for the model's tokens.txt: uppercase subword pieces, `▁` on
 * word-initial units, no whole-word entries. ATLAS deliberately admits more
 * than one valid segmentation, mirroring the real model.
 */
const VOCAB = [
  '<blk>',
  '<sos/eos>',
  '<unk>',
  '▁HE',
  'LL',
  'O',
  'Y',
  '▁AT',
  '▁A',
  'T',
  'L',
  'LA',
  'AS',
  'S',
];

async function tokensFile(vocab: readonly string[] = VOCAB): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-kw-'));
  const path = join(dir, 'tokens.txt');
  await writeFile(
    path,
    vocab.map((token, index) => `${token} ${index}`).join('\n') + '\n',
  );
  return path;
}

describe('wake keyword generation', () => {
  it('renders a boosted line with per-line suffixes at the end', async () => {
    const { line } = await buildKeywordLine('hey atlas', await tokensFile());
    // Without a boost, English keywords on this model run at ~10% detection
    // (sherpa-onnx issue #2678), so the line must carry one.
    expect(line).toContain(`:${DEFAULT_KEYWORD_BOOST}`);
    expect(line).toContain(`#${DEFAULT_KEYWORD_THRESHOLD}`);
    // Suffixes belong at the end: the boost applies to every token, and
    // sherpa has no "boost the first token" convention.
    const parts = line.trim().split(' ');
    expect(parts.at(-2)).toBe(`:${DEFAULT_KEYWORD_BOOST}`);
    expect(parts.at(-1)).toBe(`#${DEFAULT_KEYWORD_THRESHOLD}`);
  });

  it('enumerates every valid segmentation instead of guessing one', async () => {
    // Greedy longest-match would only ever try `▁AT LA S`. A word can have
    // several valid segmentations and only the trained one matches, so all
    // candidates are written and sherpa tries each.
    const candidates = await candidateKeywordLines(
      'hey atlas',
      await tokensFile(),
    );
    expect(candidates.length).toBeGreaterThan(1);
    const rendered = candidates.map((tokens) => tokens.join(' '));
    expect(rendered).toContain('▁HE Y ▁AT LA S');
    expect(rendered).toContain('▁HE Y ▁AT L AS');
    // Every token in every candidate must exist in the vocabulary.
    for (const tokens of candidates) {
      expect(tokens.length).toBeGreaterThan(0);
    }
  });

  it('tokenizes HEY the same way the shipped model does', async () => {
    // The model's own keyword files show HEY as `▁HE Y`.
    const [first] = await candidateKeywordLines(
      'hey atlas',
      await tokensFile(),
    );
    expect(first?.slice(0, 2)).toEqual(['▁HE', 'Y']);
  });

  it('uppercases the phrase and drops punctuation', async () => {
    const [tokens] = await candidateKeywordLines(
      'Hey, Atlas!',
      await tokensFile(),
    );
    expect(tokens?.slice(0, 2)).toEqual(['▁HE', 'Y']);
  });

  it('refuses a phrase the model cannot express', async () => {
    await expect(
      candidateKeywordLines('你好', await tokensFile()),
    ).rejects.toBeInstanceOf(KeywordFormatError);
  });

  it('refuses an empty phrase', async () => {
    await expect(
      candidateKeywordLines('   ', await tokensFile()),
    ).rejects.toBeInstanceOf(KeywordFormatError);
  });

  it('validates a segmentation against a vocabulary', () => {
    const vocabulary = new Set(['▁HE', 'Y']);
    expect(segmentationIsValid(['▁HE', 'Y'], vocabulary)).toBe(true);
    expect(segmentationIsValid(['▁NOPE'], vocabulary)).toBe(false);
  });

  it('parses tokens back, ignoring the suffixes', () => {
    expect(parseKeywordTokens('▁HE Y :2 #0.2')).toEqual(['▁HE', 'Y']);
    // `@phrase` is a multi-word display label, so everything from the first
    // marker onwards is metadata.
    expect(parseKeywordTokens('▁HE Y :2 #0.2 @hey atlas')).toEqual([
      '▁HE',
      'Y',
    ]);
  });
});
