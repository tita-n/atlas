/**
 * Builds the `/model` picker's views from the provider registry.
 *
 * Two views come out of here: the default catalogue - every vendor in the
 * dataset, largest first - and the search result for a query typed into the
 * picker. Established harnesses (Claude Code's `/model`, Gemini CLI's
 * `/model`, OpenCode's `/models`) all open on a list rather than a single
 * row, so the default view is the whole dataset and search narrows it.
 *
 * Pure and dependency-free apart from the fuzzy matcher: ranking and capping
 * are the parts worth testing, and testing them through a TUI would be slow
 * and fragile.
 */
import {
  formatPrice,
  type ModelInfo,
  type ProviderInfo,
} from '../providers/model-registry.js';
import { fuzzyFilter } from './fuzzy.js';
import type { ProviderGroup } from './components/ModelPicker.js';

/**
 * Rows shown per vendor in the default view. The picker renders every row it
 * is handed, and the largest catalogue in the dataset is 643 models, so an
 * uncapped group would bury everything below it.
 */
const MODELS_PER_PROVIDER = 12;

/** Vendors kept for a search, so one typo does not list the whole dataset. */
const HIT_PROVIDERS = 8;

/** Models kept per vendor among search hits. */
const HIT_MODELS_PER_PROVIDER = 8;

/** Projects a registry model into what the picker renders. */
export function toModelChoice(entry: {
  id: string;
  context: number;
  pricing?: { input: number; output: number } | undefined;
}): ProviderGroup['models'][number] {
  return {
    model: entry.id,
    ...(entry.context === 0 ? {} : { contextWindow: entry.context }),
    note: formatPrice(entry.pricing) ?? 'no published price',
  };
}

/**
 * Picks a vendor's models for the picker: at most `MODELS_PER_PROVIDER` of
 * them, with the configured model kept even when it falls outside that window
 * (vendors are ordered by context window, not by what the user is using).
 */
export function pickModels(
  provider: ProviderInfo,
  activeModel: string,
): readonly ModelInfo[] {
  const all = provider.models;
  if (all.length <= MODELS_PER_PROVIDER) return all;
  const active = all.find((entry) => entry.id === activeModel);
  if (active === undefined) return all.slice(0, MODELS_PER_PROVIDER);
  const head = all.slice(0, MODELS_PER_PROVIDER).filter((e) => e !== active);
  return [active, ...head].slice(0, MODELS_PER_PROVIDER);
}

/**
 * The picker's catalogue section for a query.
 *
 * An empty query keeps every vendor in dataset order (largest catalogues
 * first) so the list is there before anything is typed. A query ranks
 * individual models across the whole dataset and regroups the best hits by
 * vendor, so typing `gpt` finds OpenAI's models wherever they sit and typing
 * `openai` finds the vendor by name.
 */
export function catalogueGroups(
  providers: readonly ProviderInfo[],
  query: string,
  activeModel: string,
): readonly ProviderGroup[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return providers.map((provider) => ({
      provider: provider.name,
      models: pickModels(provider, activeModel).map(toModelChoice),
    }));
  }

  const entries = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      label: model.id,
      provider: provider.name,
      id: model.id,
      vendor: provider,
      model,
    })),
  );
  const ranked = fuzzyFilter(entries, trimmed);
  const groups = new Map<string, ProviderGroup>();
  for (const hit of ranked) {
    const key = hit.item.vendor.id;
    const group = groups.get(key);
    if (group === undefined) {
      // Insertion order is rank order: the vendor whose models matched first
      // leads, and later vendors are dropped past the cap.
      if (groups.size >= HIT_PROVIDERS) continue;
      groups.set(key, {
        provider: hit.item.provider,
        models: [toModelChoice(hit.item.model)],
      });
      continue;
    }
    if (group.models.length >= HIT_MODELS_PER_PROVIDER) continue;
    groups.set(key, {
      provider: group.provider,
      models: [...group.models, toModelChoice(hit.item.model)],
    });
  }
  return [...groups.values()];
}
