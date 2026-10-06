/**
 * Identity anchoring.
 *
 * The research result these tests encode is narrow and strong: identity holds
 * while the persona is structurally present in the system prompt every turn,
 * and breaks when a turn's context lacks it - especially on automation-style
 * turns. So the tests are about presence and independence, not about whether a
 * particular model cooperates.
 */
import { describe, expect, it } from 'vitest';

import {
  ATLAS_IDENTITY,
  identityBlock,
  identitySection,
  isIdentityQuestion,
} from '../../src/identity/identity-block.js';
import { buildTurnPrompt } from '../../src/conversation/system-prompt.js';

describe('the identity block', () => {
  it('names Atlas and does not name any model vendor', () => {
    const block = identityBlock();
    expect(block).toContain(ATLAS_IDENTITY);
    // Naming a vendor as the identity is the exact failure being fixed.
    for (const vendor of ['Claude', 'GPT', 'Gemini', 'Llama', 'ChatGPT']) {
      expect(block).not.toContain(`You are ${vendor}`);
    }
  });

  it('separates the persona from the engine doing the work', () => {
    const block = identityBlock();
    expect(block).toMatch(/harness/i);
    expect(block).toMatch(/language model/i);
  });

  it('is provider-independent, so switching models changes nothing', () => {
    // No parameters, so it cannot vary with whichever model is active.
    expect(identityBlock()).toBe(identityBlock());
  });

  it('is returned fresh rather than relying on anything carried forward', () => {
    expect(identitySection({ userMessage: 'hello' })).toBe(
      identitySection({ userMessage: 'hello' }),
    );
    expect(identitySection()).toContain(ATLAS_IDENTITY);
  });
});

describe('identity questions', () => {
  it('recognises the direct phrasings', () => {
    for (const message of [
      'who are you?',
      'Who are you exactly',
      'what are you',
      "what's your name",
      'are you an AI',
      'what model are you',
      'which model are you',
      'are you GPT?',
      'are you Claude',
    ]) {
      expect({ message, hit: isIdentityQuestion(message) }).toEqual({
        message,
        hit: true,
      });
    }
  });

  it('does not fire on ordinary work', () => {
    for (const message of [
      'rename a.ts to b.ts',
      'run the tests please',
      'what is in the config file',
      'who owns that file?',
    ]) {
      expect(isIdentityQuestion(message)).toBe(false);
    }
  });

  it('sharpens the instruction on an identity question', () => {
    const section = identitySection({ userMessage: 'who are you?' });
    expect(section).toContain('Answer as Atlas');
    expect(section.length).toBeGreaterThan(identityBlock().length);
  });

  it('leaves ordinary turns with the base block only', () => {
    expect(identitySection({ userMessage: 'run the tests' })).toBe(
      identityBlock(),
    );
  });
});

describe('automation turns', () => {
  it('restates identity, because that is where the research saw it break', () => {
    const conversational = identitySection({ userMessage: 'hi' });
    const automated = identitySection({ userMessage: 'hi', automated: true });
    expect(automated).not.toBe(conversational);
    expect(automated).toContain('automation-triggered');
    // The base block is still present, not replaced.
    expect(automated).toContain(identityBlock());
  });
});

describe('the system prompt carries identity every turn', () => {
  const base = { personality: 'You are helpful.', identity: identitySection() };

  it('is present in the built prompt', () => {
    const prompt = buildTurnPrompt(base);
    expect(prompt).toContain(ATLAS_IDENTITY);
  });

  it('is present regardless of what else the turn contains', () => {
    for (const extra of [
      { corrections: ['call it Acme'] },
      { facts: ['likes tea'] },
      { planningNote: 'state your approach first' },
      { corrections: ['a'], facts: ['b'], planningNote: 'c' },
      { automated: true },
    ]) {
      expect(buildTurnPrompt({ ...base, ...extra })).toContain(ATLAS_IDENTITY);
    }
  });

  it('leads the prompt, so an empty personality cannot displace it', () => {
    const prompt = buildTurnPrompt({ ...base, personality: '' });
    expect(prompt.trimStart().startsWith('Identity')).toBe(true);
  });

  it('is rebuilt per turn rather than appended once', () => {
    // Two consecutive turns produce two independently-built prompts; identity
    // does not depend on the previous turn being remembered.
    const first = buildTurnPrompt({ ...base, identity: identitySection() });
    const second = buildTurnPrompt({
      ...base,
      identity: identitySection({ userMessage: 'who are you?' }),
    });
    expect(first).toContain(ATLAS_IDENTITY);
    expect(second).toContain(ATLAS_IDENTITY);
    expect(second).not.toBe(first);
  });

  it('survives a persona file that says something contradictory', () => {
    // A user-editable personality must not be able to silently un-anchor
    // identity by asserting a different one.
    const prompt = buildTurnPrompt({
      ...base,
      personality: 'You are a helpful assistant made by Acme Corp.',
    });
    expect(prompt).toContain(ATLAS_IDENTITY);
    expect(prompt.indexOf('Identity')).toBeLessThan(
      prompt.indexOf('Acme Corp'),
    );
  });
});
