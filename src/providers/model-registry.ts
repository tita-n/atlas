/**
 * Provider and model metadata sourced from models.dev.
 *
 * The point of consuming the shared dataset is that Atlas never hardcodes a
 * provider table: a model released today appears on the next fetch, with no
 * code change. Everything here is derived from the dataset at runtime.
 *
 * What the dataset actually provides, verified rather than assumed:
 *
 *   provider: { id, name, env: string[], npm, doc, api?, models: {...} }
 *   model:    { id, name, limit: { context, input, output }, cost?: { input,
 *              output, cache_read }, reasoning?, tool_call?, modalities?, ... }
 *
 * Notably `api` is a base URL, NOT a wire-format tag. Atlas speaks exactly two
 * protocols, so the protocol is inferred from that URL and can always be
 * overridden by hand. Only `openai` and `anthropic` omit `api`, and Atlas
 * already knows both defaults.
 *
 * The dataset is ~5 MB with ~8,400 models, so it is fetched, cached on disk,
 * and parsed lazily. Nothing in this module blocks startup.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The one endpoint Atlas needs. Kept here so it can be overridden in tests. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** Cache is considered fresh for a day. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Guards against a hung request when the network is slow. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ModelPricing {
  /** USD per million input tokens, as the dataset reports it. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  /** Context window in tokens, or 0 when the dataset does not state one. */
  readonly context: number;
  /** Maximum output tokens, 0 when unknown. */
  readonly outputLimit: number;
  readonly pricing?: ModelPricing;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
}

export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  /** Base URL from the dataset; undefined for the vendors Atlas knows. */
  readonly baseUrl?: string;
  /** Environment variables that may hold this provider's key. */
  readonly env: readonly string[];
  readonly doc?: string;
  readonly models: readonly ModelInfo[];
}

export interface RegistrySnapshot {
  readonly providers: readonly ProviderInfo[];
  /** Epoch ms when this snapshot was fetched. */
  readonly fetchedAt: number;
  /** How this snapshot was obtained. */
  readonly source: 'network' | 'cache';
}

/** The wire formats Atlas actually implements. */
export type AtlasProtocol = 'openai-compatible' | 'anthropic-compatible';

export function isRecord(value: unknown): value is Record<string, unknown> {
  // An array is an object but never a dataset entry: treating one as a record
  // would silently invent providers keyed "0", "1", ... out of a payload that
  // is simply the wrong shape.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parses one model's record, tolerating missing optional fields. */
export function parseModel(id: string, raw: unknown): ModelInfo {
  if (!isRecord(raw)) {
    return {
      id,
      name: id,
      context: 0,
      outputLimit: 0,
      reasoning: false,
      toolCall: false,
    };
  }
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const cost = isRecord(raw.cost) ? raw.cost : undefined;
  // A cost object that states neither rate is not a price of zero: reporting
  // it as `free` would claim a vendor is free when the dataset simply is
  // silent, so an unstated rate stays unstated. A rate the dataset does state
  // is kept even when it is 0, which is a real (free) price.
  const input = readNumber(cost?.input);
  const output = readNumber(cost?.output);
  const priced =
    cost !== undefined &&
    (typeof cost.input === 'number' || typeof cost.output === 'number');
  return {
    id: typeof raw.id === 'string' ? raw.id : id,
    name: typeof raw.name === 'string' ? raw.name : id,
    context: readNumber(limit.context),
    outputLimit: readNumber(limit.output),
    ...(priced
      ? {
          pricing: {
            input,
            output,
            ...(typeof cost?.cache_read === 'number'
              ? { cacheRead: cost.cache_read }
              : {}),
          },
        }
      : {}),
    reasoning: raw.reasoning === true,
    toolCall: raw.tool_call === true,
  };
}

/** Parses the whole dataset, dropping entries that cannot be used. */
export function parseRegistry(raw: unknown): ProviderInfo[] {
  if (!isRecord(raw)) return [];
  const providers: ProviderInfo[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const modelsRaw = isRecord(value.models) ? value.models : {};
    const models = Object.entries(modelsRaw)
      .map(([modelId, model]) => parseModel(modelId, model))
      .filter((model) => model.context > 0)
      .sort((a, b) => b.context - a.context);
    providers.push({
      id: typeof value.id === 'string' ? value.id : id,
      name: typeof value.name === 'string' ? value.name : id,
      ...(typeof value.api === 'string' ? { baseUrl: value.api } : {}),
      env: Array.isArray(value.env)
        ? value.env.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [],
      ...(typeof value.doc === 'string' ? { doc: value.doc } : {}),
      models,
    });
  }
  // A vendor with no usable model cannot be connected to or offered, so it is
  // dropped rather than shown as an empty row in a picker.
  const usable = providers.filter((provider) => provider.models.length > 0);
  // Largest model catalogues first: the vendors people actually use lead.
  return usable.sort((a, b) => b.models.length - a.models.length);
}

/**
 * Infers which of Atlas's two protocols a vendor speaks, if that can be known.
 *
 * The dataset gives a base URL but never a protocol. Most vendors expose an
 * OpenAI-compatible surface, and the few that do not say so in their endpoint
 * name. When a vendor states no endpoint at all, its protocol is genuinely
 * unknown and `undefined` is returned so the user is asked — guessing here would
 * silently pick the wrong wire format for exactly the vendors that omit it.
 */
export function protocolFor(provider: ProviderInfo): AtlasProtocol | undefined {
  if (provider.baseUrl === undefined) return undefined;
  return /anthropic/i.test(provider.baseUrl)
    ? 'anthropic-compatible'
    : 'openai-compatible';
}

/** Both protocols, for presenting a choice when inference is not possible. */
export const ATLAS_PROTOCOLS: readonly AtlasProtocol[] = [
  'openai-compatible',
  'anthropic-compatible',
];

/** Cache location, inside the Atlas home so isolation applies to it too. */
export function cachePath(atlasHome: string): string {
  return join(atlasHome, 'models.dev.json');
}

interface CacheFile {
  readonly fetchedAt: number;
  readonly payload: unknown;
}

export interface RegistryOptions {
  readonly atlasHome: string;
  readonly url?: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /** Injected so tests never touch the network. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function isFresh(fetchedAt: number, ttlMs: number, now: number): boolean {
  return now - fetchedAt < ttlMs;
}

async function readCache(
  path: string,
): Promise<{ fetchedAt: number; payload: unknown } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.fetchedAt !== 'number') return undefined;
    return { fetchedAt: parsed.fetchedAt, payload: parsed.payload };
  } catch {
    // A corrupt cache is not worth failing over; it is simply refetched.
    return undefined;
  }
}

/**
 * Loads the registry, preferring a fresh cache and falling back to a stale one.
 *
 * Never throws for network reasons: a provider being unreachable degrades to
 * older data plus a notice, because failing `/init` outright would make Atlas
 * look broken when the real problem is that a website is down.
 */
export async function loadRegistry(
  options: RegistryOptions,
): Promise<{ snapshot: RegistrySnapshot; stale: boolean; error?: string }> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const url = options.url ?? MODELS_DEV_URL;
  const path = cachePath(options.atlasHome);
  const cached = await readCache(path);

  if (cached !== undefined && isFresh(cached.fetchedAt, ttlMs, now())) {
    return {
      snapshot: {
        providers: parseRegistry(cached.payload),
        fetchedAt: cached.fetchedAt,
        source: 'cache',
      },
      stale: false,
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`models.dev responded ${response.status}`);
    }
    const payload: unknown = await response.json();
    const fetchedAt = now();
    await writeCache(path, { fetchedAt, payload });
    return {
      snapshot: {
        providers: parseRegistry(payload),
        fetchedAt,
        source: 'network',
      },
      stale: false,
    };
  } catch (error) {
    // Unreachable or malformed: fall back to whatever was cached, even if old.
    if (cached !== undefined) {
      return {
        snapshot: {
          providers: parseRegistry(cached.payload),
          fetchedAt: cached.fetchedAt,
          source: 'cache',
        },
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      snapshot: { providers: [], fetchedAt: 0, source: 'cache' },
      stale: true,
      error: describe(error),
    };
  }
}

/** Forces a refetch, ignoring cache freshness. Used by an explicit refresh. */
export async function refreshRegistry(
  options: RegistryOptions,
): Promise<{ snapshot: RegistrySnapshot; error?: string }> {
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(options.url ?? MODELS_DEV_URL, {
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`models.dev responded ${response.status}`);
    const payload: unknown = await response.json();
    const fetchedAt = now();
    await writeCache(cachePath(options.atlasHome), { fetchedAt, payload });
    return {
      snapshot: {
        providers: parseRegistry(payload),
        fetchedAt,
        source: 'network',
      },
    };
  } catch (error) {
    return {
      snapshot: { providers: [], fetchedAt: 0, source: 'cache' },
      error: describe(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // A cache that cannot be written costs a refetch, not correctness.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Providers whose API key is already present in the environment.
 *
 * This is what lets Atlas offer to connect without the user running `/init`.
 */
export interface DetectedProvider {
  readonly provider: ProviderInfo;
  /** The variable that matched. */
  readonly envVar: string;
}

export function detectProviders(
  providers: readonly ProviderInfo[],
  env: NodeJS.ProcessEnv,
): DetectedProvider[] {
  const found: DetectedProvider[] = [];
  for (const provider of providers) {
    for (const name of provider.env) {
      const value = env[name];
      if (value !== undefined && value.trim() !== '') {
        found.push({ provider, envVar: name });
        break;
      }
    }
  }
  return found;
}

/** Finds one provider by its dataset id. */
export function findProvider(
  providers: readonly ProviderInfo[],
  id: string,
): ProviderInfo | undefined {
  return providers.find((provider) => provider.id === id);
}

/** Finds a model within a provider, by id or by display name. */
export function findModel(
  provider: ProviderInfo,
  modelId: string,
): ModelInfo | undefined {
  return (
    provider.models.find((model) => model.id === modelId) ??
    provider.models.find((model) => model.name === modelId)
  );
}

/** Formats price for display; returns undefined rather than guessing. */
export function formatPrice(
  pricing: ModelPricing | undefined,
): string | undefined {
  if (pricing === undefined) return undefined;
  const { input, output } = pricing;
  // A non-finite rate can only come from a caller that built the object by
  // hand; rendering it would put a literal `NaN` in the picker.
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (input === 0 && output === 0) return 'free';
  return `$${input}/$${output} per Mtok`;
}

/**
 * Whether a model is known to emit reasoning inline.
 *
 * Read from the cached registry, so it never blocks on the network. This is a
 * mitigation, not a guarantee: the dataset is community-maintained and has gaps,
 * which is why tag stripping still runs for every model regardless.
 */
export async function modelExpectsInlineReasoning(
  atlasHome: string,
  model: string,
): Promise<boolean> {
  const { snapshot } = await loadRegistry({ atlasHome });
  for (const provider of snapshot.providers) {
    const found = provider.models.find(
      (entry) => entry.id === model || entry.name === model,
    );
    if (found !== undefined) return found.reasoning;
  }
  return false;
}
