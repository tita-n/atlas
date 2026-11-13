/**
 * Catalogue and windowing logic for the /model picker.
 *
 * Pure functions on purpose: the picker's whole regression history is "the
 * list was not there" or "the list flooded the terminal", and both failure
 * modes are checkable without rendering a TUI.
 */
import { describe, expect, it } from 'vitest';

import { parseRegistry } from '../../src/providers/model-registry.js';
import {
  catalogueGroups,
  toModelChoice,
} from '../../src/tui/model-catalogue.js';
import { windowStart } from '../../src/tui/components/ModelPicker.js';

function providers(): ReturnType<typeof parseRegistry> {
  return parseRegistry({
    acme: {
      id: 'acme',
      name: 'Acme',
      api: 'https://api.acme.test/v1',
      env: [],
      models: {
        big: { id: 'big', name: 'Big', limit: { context: 200_000 } },
        small: { id: 'small', name: 'Small', limit: { context: 8_000 } },
        // No context window: dropped by the parser, never rendered as a guess.
        ghost: { id: 'ghost', name: 'Ghost', limit: {} },
      },
    },
    other: {
      id: 'other',
      name: 'Other',
      api: 'https://api.other.test/v1',
      env: [],
      models: {
        'gpt-4o-mini': {
          id: 'gpt-4o-mini',
          name: 'Mini',
          limit: { context: 128_000 },
        },
      },
    },
  });
}

describe('the default catalogue view', () => {
  it('lists every provider so the list is there before anything is typed', () => {
    const groups = catalogueGroups(providers(), '', '');
    expect(groups.map((group) => group.provider)).toEqual(['Acme', 'Other']);
    expect(groups[0]?.models.map((m) => m.model)).toEqual(['big', 'small']);
    expect(groups[1]?.models.map((m) => m.model)).toEqual(['gpt-4o-mini']);
  });

  it('keeps the configured model inside a capped vendor group', () => {
    const many = parseRegistry({
      acme: {
        id: 'acme',
        name: 'Acme',
        api: 'https://api.acme.test/v1',
        env: [],
        models: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [
            `m${i}`,
            { id: `m${i}`, name: `M${i}`, limit: { context: 8_000 + i } },
          ]),
        ),
      },
    });
    const [group] = catalogueGroups(many, '', '');
    expect(group?.models).toHaveLength(12);
    const active = catalogueGroups(many, '', 'm39');
    expect(active[0]?.models[0]?.model).toBe('m39');
  });
});

describe('searching the catalogue', () => {
  it('finds a model by id and groups it under its provider', () => {
    const groups = catalogueGroups(providers(), 'gpt', '');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe('Other');
    expect(groups[0]?.models[0]?.model).toBe('gpt-4o-mini');
  });

  it('finds a provider by name', () => {
    const groups = catalogueGroups(providers(), 'acme', '');
    expect(groups.map((group) => group.provider)).toContain('Acme');
  });

  it('returns nothing rather than the whole dataset when nothing matches', () => {
    expect(catalogueGroups(providers(), 'zzz-no-such-thing', '')).toEqual([]);
  });
});

describe('projecting models into picker rows', () => {
  it('carries the context window and the real price', () => {
    const choice = toModelChoice({
      id: 'm',
      context: 200_000,
      pricing: { input: 1, output: 5 },
    });
    expect(choice.contextWindow).toBe(200_000);
    expect(choice.note).toContain('$1/$5');
  });

  it('omits the context window rather than inventing one', () => {
    expect(
      toModelChoice({ id: 'm', context: 0 }).contextWindow,
    ).toBeUndefined();
  });
});

describe('windowing a list longer than the screen', () => {
  it('centres the selection when there is room on both sides', () => {
    expect(windowStart(10, 100, 14)).toBe(3);
  });

  it('clamps to the top', () => {
    expect(windowStart(0, 100, 14)).toBe(0);
    expect(windowStart(2, 100, 14)).toBe(0);
  });

  it('clamps to the bottom', () => {
    expect(windowStart(99, 100, 14)).toBe(86);
  });

  it('shows everything when the list fits', () => {
    expect(windowStart(5, 10, 14)).toBe(0);
  });
});
