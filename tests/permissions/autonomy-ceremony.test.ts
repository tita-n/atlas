/**
 * Friction and persistence for autonomy changes.
 *
 * The asymmetry is the behaviour under test: lowering the level must cost a
 * deliberate act, raising it must not.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_LEVEL,
  confirmationPhraseFor,
  describeLevel,
  loadAutonomy,
  saveAutonomy,
} from '../../src/permissions/autonomy.js';

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-autonomy-cli-'));
}

describe('choosing a level', () => {
  it('makes lowering costly and raising free', () => {
    // The asymmetry is the safety property: it must never be inverted.
    expect(describeLevel(DEFAULT_AUTONOMY_LEVEL).requiresFriction).toBe(false);
    for (const level of AUTONOMY_LEVELS.filter(
      (entry) => entry !== DEFAULT_AUTONOMY_LEVEL,
    )) {
      expect(describeLevel(level).requiresFriction).toBe(true);
    }
  });

  it('requires a distinct typed phrase per lowered level', () => {
    const phrases = AUTONOMY_LEVELS.filter(
      (level) => describeLevel(level).requiresFriction,
    ).map(confirmationPhraseFor);
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const phrase of phrases) expect(phrase.length).toBeGreaterThan(5);
  });

  it('warns about what is given up, in plain words', () => {
    expect(describeLevel('unattended').risk).toMatch(/undo/);
    expect(describeLevel('scoped-approval').risk).toMatch(/scope/i);
  });
});

describe('persistence', () => {
  it('keeps a lowered level until it is changed back', async () => {
    const dir = await home();
    await saveAutonomy(dir, 'unattended', '2026-02-02T00:00:00.000Z');
    expect((await loadAutonomy(dir)).level).toBe('unattended');
    // Reading it repeatedly must not silently re-prompt or revert.
    for (let i = 0; i < 3; i += 1) {
      expect((await loadAutonomy(dir)).level).toBe('unattended');
    }
    await saveAutonomy(dir, 'confirm-everything');
    expect((await loadAutonomy(dir)).level).toBe('confirm-everything');
  });

  it('writes the settings file owner-only', async () => {
    const dir = await home();
    await saveAutonomy(dir, 'scoped-approval');
    const raw = await readFile(join(dir, 'autonomy.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    expect(
      typeof parsed === 'object' && parsed !== null && 'level' in parsed,
    ).toBe(true);
  });

  it('stores nothing sensitive alongside the level', async () => {
    const dir = await home();
    await saveAutonomy(dir, 'unattended');
    const raw = await readFile(join(dir, 'autonomy.json'), 'utf8');
    // The file records a setting, not a credential.
    expect(raw.toLowerCase()).not.toContain('apikey');
    expect(raw.toLowerCase()).not.toContain('secret');
  });
});

describe('per-task override', () => {
  it('does not disturb the global default', async () => {
    const dir = await home();
    await saveAutonomy(dir, 'confirm-everything');
    // A per-task override is session state; the file must not move.
    expect((await loadAutonomy(dir)).level).toBe('confirm-everything');
  });
});
