/**
 * Registry tests run against BOTH a hand-written fixture and the real
 * models.dev payload, because the fixture is the only way to test a schema
 * change and the real payload is the only way to catch a drift nobody wrote
 * down.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  ATLAS_PROTOCOLS,
  MODELS_DEV_URL,
  detectProviders,
  findModel,
  findProvider,
  formatPrice,
  loadRegistry,
  parseModel,
  parseRegistry,
  protocolFor,
  refreshRegistry,
  type ProviderInfo,
} from '../../src/providers/model-registry.js';

const REAL_PAYLOAD = '/tmp/models.json';
const hasRealPayload = existsSync(REAL_PAYLOAD);

function fixture(): unknown {
  return {
    acme: {
      id: 'acme',
      name: 'Acme',
      api: 'https://api.acme.test/v1',
      env: ['ACME_API_KEY'],
      doc: 'https://acme.test/docs',
      models: {
        'acme-large': {
          id: 'acme-large',
          name: 'Acme Large',
          limit: { context: 200000, input: 200000, output: 8000 },
          cost: { input: 3, output: 15, cache_read: 0.3 },
          reasoning: true,
          tool_call: true,
        },
        'acme-tiny': {
          id: 'acme-tiny',
          name: 'Tiny',
          limit: { context: 4096 },
        },
        // No stated context: must be filtered out rather than shown as broken.
        'acme-unknown': {
          id: 'acme-unknown',
          name: 'Unknown',
          limit: { context: 0 },
        },
      },
    },
    zonky: {
      id: 'zonky',
      name: 'Zonky',
      api: 'https://api.zonky.test/anthropic/v1',
      env: ['ZONKY_API_KEY'],
      models: {
        'zonky-1': {
          id: 'zonky-1',
          name: 'Zonky 1',
          limit: { context: 128000 },
        },
      },
    },
    bare: {
      id: 'bare',
      name: 'Bare Vendor',
      env: ['BARE_API_KEY'],
      models: {
        'bare-1': { id: 'bare-1', name: 'Bare 1', limit: { context: 64000 } },
      },
    },
  };
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-registry-'));
}

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

describe('parsing the dataset', () => {
  it('reads providers, base URLs, and env vars', () => {
    const providers = parseRegistry(fixture());
    expect(providers).toHaveLength(3);
    const acme = findProvider(providers, 'acme');
    expect(acme?.name).toBe('Acme');
    expect(acme?.baseUrl).toBe('https://api.acme.test/v1');
    expect(acme?.env).toEqual(['ACME_API_KEY']);
  });

  it('keeps models that state a context window and drops those that do not', () => {
    const acme = findProvider(parseRegistry(fixture()), 'acme');
    expect(acme?.models.map((m) => m.id)).toEqual(['acme-large', 'acme-tiny']);
  });

  it('orders a vendor catalogue by context size', () => {
    const acme = findProvider(parseRegistry(fixture()), 'acme');
    expect(acme?.models[0]?.context).toBeGreaterThan(
      acme?.models[1]?.context ?? 0,
    );
  });

  it('reads limits and pricing', () => {
    const model = parseModel('m', {
      limit: { context: 128000, output: 4096 },
      cost: { input: 1.5, output: 6 },
    });
    expect(model.context).toBe(128000);
    expect(model.outputLimit).toBe(4096);
    expect(model.pricing).toEqual({ input: 1.5, output: 6 });
  });

  it('tolerates a model missing everything optional', () => {
    const model = parseModel('bare', {});
    expect(model.context).toBe(0);
    expect(model.pricing).toBeUndefined();
    expect(model.reasoning).toBe(false);
  });

  it('survives a malformed dataset instead of throwing', () => {
    expect(parseRegistry(null)).toEqual([]);
    expect(parseRegistry('nonsense')).toEqual([]);
    // 'a' is not an object and 'b' has no usable model; neither is actionable.
    expect(
      parseRegistry({ a: 'not-an-object', b: { models: 'nope' } }),
    ).toEqual([]);
  });

  it('never surfaces a provider with no usable model', () => {
    // Offering a vendor the user cannot actually pick would be a dead row.
    expect(parseRegistry({ x: { models: { m: { limit: {} } } } })).toEqual([]);
  });

  it('rejects a top-level array rather than reading it as providers', () => {
    // An array is an object; reading it as one invents a provider called "0".
    expect(
      parseRegistry([{ id: 'x', models: { m: { limit: { context: 8 } } } }]),
    ).toEqual([]);
  });

  it('orders vendors by catalogue size, largest first', () => {
    // Regression risk: the sort used to sit after the return statement and so
    // never ran, which left the picker leading with whatever models.dev
    // happened to list first.
    const providers = parseRegistry({
      small: { models: { a: { limit: { context: 1 } } } },
      large: {
        models: {
          a: { limit: { context: 1 } },
          b: { limit: { context: 2 } },
          c: { limit: { context: 3 } },
        },
      },
    });
    expect(providers.map((provider) => provider.id)).toEqual([
      'large',
      'small',
    ]);
  });
});

describe('protocol inference', () => {
  /** Looks a provider up, failing the test rather than asserting on undefined. */
  function provider(id: string): ProviderInfo {
    const found = findProvider(parseRegistry(fixture()), id);
    if (found === undefined) throw new Error(`fixture is missing ${id}`);
    return found;
  }

  it('infers OpenAI-compatible from a normal endpoint', () => {
    expect(protocolFor(provider('acme'))).toBe('openai-compatible');
  });

  it('infers Anthropic-compatible when the endpoint says so', () => {
    expect(protocolFor(provider('zonky'))).toBe('anthropic-compatible');
  });

  it('reports unknown rather than guessing when no endpoint is stated', () => {
    // Regression risk: defaulting here silently picks the wrong wire format
    // for exactly the vendors that omit their endpoint.
    expect(protocolFor(provider('bare'))).toBeUndefined();
  });

  it('offers both protocols when inference is impossible', () => {
    expect(ATLAS_PROTOCOLS).toEqual([
      'openai-compatible',
      'anthropic-compatible',
    ]);
  });
});

describe('environment detection', () => {
  it('finds a provider whose key is already set', () => {
    const detected = detectProviders(parseRegistry(fixture()), {
      ACME_API_KEY: 'sk-live-abc',
    });
    expect(detected.map((d) => d.provider.id)).toEqual(['acme']);
    expect(detected[0]?.envVar).toBe('ACME_API_KEY');
  });

  it('reports nothing when no key is present', () => {
    expect(detectProviders(parseRegistry(fixture()), {})).toEqual([]);
  });

  it('ignores a blank variable rather than treating it as a key', () => {
    expect(
      detectProviders(parseRegistry(fixture()), { ACME_API_KEY: '   ' }),
    ).toEqual([]);
  });

  it('reports each provider at most once', () => {
    const detected = detectProviders(parseRegistry(fixture()), {
      ACME_API_KEY: 'a',
      BARE_API_KEY: 'b',
    });
    expect(new Set(detected.map((d) => d.provider.id)).size).toBe(
      detected.length,
    );
  });
});

describe('caching and refresh', () => {
  it('serves a fresh cache without hitting the network', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(fixture())));
    await loadRegistry({ atlasHome: home, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    const second = await loadRegistry({
      atlasHome: home,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(second.snapshot.source).toBe('cache');
    expect(second.snapshot.providers).toHaveLength(3);
  });

  it('refetches once the cache is older than the TTL', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(fixture())));
    await loadRegistry({ atlasHome: home, fetchImpl });
    await loadRegistry({
      atlasHome: home,
      fetchImpl,
      ttlMs: 0,
      now: () => Date.now() + 60_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to a stale cache when the network fails', async () => {
    const home = await tempHome();
    await loadRegistry({
      atlasHome: home,
      fetchImpl: () => Promise.resolve(jsonResponse(fixture())),
    });
    const result = await loadRegistry({
      atlasHome: home,
      fetchImpl: () => Promise.reject(new Error('offline')),
      ttlMs: 0,
    });
    // Degrades to older data with a notice rather than failing outright.
    expect(result.stale).toBe(true);
    expect(result.error).toContain('offline');
    expect(result.snapshot.providers).toHaveLength(3);
  });

  it('does not throw when there is neither cache nor network', async () => {
    const home = await tempHome();
    const result = await loadRegistry({
      atlasHome: home,
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    expect(result.snapshot.providers).toEqual([]);
    expect(result.stale).toBe(true);
  });

  it('treats a non-OK response as a failure', async () => {
    const home = await tempHome();
    const result = await loadRegistry({
      atlasHome: home,
      fetchImpl: () => Promise.resolve(jsonResponse({}, false, 503)),
    });
    expect(result.error).toContain('503');
  });

  it('ignores a corrupt cache and refetches', async () => {
    const home = await tempHome();
    await writeFile(join(home, 'models.dev.json'), '{not json', 'utf8');
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(fixture())));
    const result = await loadRegistry({
      atlasHome: home,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.snapshot.providers).toHaveLength(3);
  });

  it('forces a refetch on demand', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(fixture())));
    await loadRegistry({ atlasHome: home, fetchImpl });
    await refreshRegistry({ atlasHome: home, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a failure from an on-demand refresh instead of throwing', async () => {
    const home = await tempHome();
    const result = await refreshRegistry({
      atlasHome: home,
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    expect(result.error).toContain('offline');
  });

  it('points at the documented endpoint by default', () => {
    expect(MODELS_DEV_URL).toBe('https://models.dev/api.json');
  });
});

describe('lookups', () => {
  it('finds a model by id or display name', () => {
    const found = findProvider(parseRegistry(fixture()), 'acme');
    if (found === undefined) throw new Error('fixture is missing acme');
    expect(findModel(found, 'acme-large')?.context).toBe(200000);
    expect(findModel(found, 'Acme Large')?.context).toBe(200000);
    expect(findModel(found, 'nope')).toBeUndefined();
  });

  it('formats pricing, and reports free rather than $0/$0', () => {
    expect(formatPrice({ input: 3, output: 15 })).toContain('$3/$15');
    expect(formatPrice({ input: 0, output: 0 })).toBe('free');
  });

  it('reports no price rather than inventing one', () => {
    expect(formatPrice(undefined)).toBeUndefined();
  });

  it('never prints NaN or undefined into the picker', () => {
    // Regression risk: a hand-built ModelPricing is type-valid with NaN in it,
    // and the literal string used to reach the screen.
    expect(formatPrice({ input: NaN, output: NaN })).toBeUndefined();
    expect(formatPrice({ input: 1, output: NaN })).toBeUndefined();
  });

  it('does not claim a model is free when the dataset states no price', () => {
    // `cost: {}` means the dataset is silent, not that the model is free.
    expect(
      parseModel('m', { limit: { context: 8 }, cost: {} }).pricing,
    ).toBeUndefined();
    // A rate the dataset does state is kept even when it is zero.
    expect(
      parseModel('m', { limit: { context: 8 }, cost: { input: 0, output: 0 } })
        .pricing,
    ).toEqual({ input: 0, output: 0 });
  });
});

// Only runs where the real payload was already fetched, so CI stays offline-safe.
describe.runIf(hasRealPayload)('the real models.dev payload', () => {
  const raw: unknown = JSON.parse(readFileSync(REAL_PAYLOAD, 'utf8'));

  it('parses every provider without throwing', () => {
    const providers = parseRegistry(raw);
    expect(providers.length).toBeGreaterThan(100);
  });

  it('gives every provider at least one usable model', () => {
    const empty = parseRegistry(raw).filter((p) => p.models.length === 0);
    expect(empty.map((p) => p.id)).toEqual([]);
  });

  it('gives every provider at least one env var to auto-detect', () => {
    const missing = parseRegistry(raw).filter((p) => p.env.length === 0);
    expect(missing.map((p) => p.id)).toEqual([]);
  });

  it('detects the major vendors from their real env vars', () => {
    const providers = parseRegistry(raw);
    const detected = detectProviders(providers, {
      OPENAI_API_KEY: 'sk-live',
      ANTHROPIC_API_KEY: 'sk-live',
    });
    const byId = new Map(detected.map((d) => [d.provider.id, d.envVar]));
    expect(byId.get('openai')).toBe('OPENAI_API_KEY');
    expect(byId.get('anthropic')).toBe('ANTHROPIC_API_KEY');
    // A variable that is present but blank is not a key.
    expect(
      detectProviders(providers, {
        OPENAI_API_KEY: 'sk-live',
        ANTHROPIC_API_KEY: '   ',
      }).map((d) => d.provider.id),
    ).not.toContain('anthropic');
  });

  it('never prints a price for a real model with no stated rate', () => {
    const priced = parseRegistry(raw).flatMap((p) =>
      p.models
        .map((m) => formatPrice(m.pricing))
        .filter((text) => text !== undefined),
    );
    expect(priced.filter((text) => /NaN|undefined/.test(text))).toEqual([]);
  });

  it('resolves the major vendors Atlas already supports', () => {
    const providers = parseRegistry(raw);
    const openai = findProvider(providers, 'openai');
    const anthropic = findProvider(providers, 'anthropic');
    expect(openai?.name).toBe('OpenAI');
    expect(openai?.env).toContain('OPENAI_API_KEY');
    expect(anthropic?.name).toBe('Anthropic');
    expect(anthropic?.env).toContain('ANTHROPIC_API_KEY');
  });

  it('infers a protocol for vendors that state an endpoint', () => {
    const providers = parseRegistry(raw);
    const withEndpoint = providers.filter((p) => p.baseUrl !== undefined);
    const known = withEndpoint.filter((p) => protocolFor(p) !== undefined);
    expect(known.length).toBe(withEndpoint.length);
  });

  it('parses the largest real payload quickly enough for startup', () => {
    const start = Date.now();
    parseRegistry(raw);
    // Generous, but catches a parser that accidentally became quadratic.
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
