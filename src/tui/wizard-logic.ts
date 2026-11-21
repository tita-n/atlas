/**
 * Pure decision logic for the /init wizard.
 *
 * Extracted from the component so the choices a wizard step makes — which
 * endpoint gets probed, which model gets saved, whether the endpoint has to
 * be asked for — are unit-testable without rendering anything.
 *
 * Two rules encode the fixes this module exists for:
 *
 *   - the config that gets probed is the config that gets saved: the picked
 *     vendor's own endpoint and its own top model, never whatever the current
 *     session happens to hold;
 *   - a vendor with no endpoint anywhere is asked for one instead of being
 *     silently validated against the previous configuration's base URL.
 */
import type {
  AtlasProtocol,
  ProviderInfo,
} from '../providers/model-registry.js';
import {
  protocolFromUrl,
  vendorEndpoint,
  vendorForUrl,
} from '../providers/model-registry.js';
import { PROVIDER_OPTIONS } from './components/InitWizard.js';

/** What the wizard knows about the row the user picked. */
export interface WizardSelection {
  readonly id: string;
  readonly label: string;
  /** Resolved endpoint (dataset or built-in), when one is known. */
  readonly baseUrl?: string | undefined;
  /** Inferred from the resolved endpoint; unknown until one exists. */
  readonly protocol?: AtlasProtocol | undefined;
  /** The vendor's top model, when the vendor is known. */
  readonly model?: string | undefined;
}

/**
 * Resolves a picked row against the registry.
 *
 * The custom-endpoint row is not a vendor: `vendor` is undefined for it (and
 * for any row the dataset does not describe), so it comes out with no
 * endpoint, no protocol, and no model — all three get asked for or derived
 * later.
 */
export function resolveWizardSelection(
  chosen: { readonly id: string; readonly label: string },
  vendor: ProviderInfo | undefined,
): WizardSelection {
  if (vendor === undefined) return { id: chosen.id, label: chosen.label };
  const baseUrl = vendorEndpoint(vendor);
  const topModel = vendor.models[0];
  return {
    id: chosen.id,
    label: chosen.label,
    ...(baseUrl === undefined
      ? {}
      : { baseUrl, protocol: protocolFromUrl(baseUrl) }),
    ...(topModel === undefined ? {} : { model: topModel.id }),
  };
}

/** The next step after a row is chosen: ask for an endpoint, or for a key. */
export function wizardStepForSelection(
  selection: WizardSelection,
): 'endpoint' | 'key' {
  return selection.baseUrl === undefined ? 'endpoint' : 'key';
}

/** The wire-format default model, matching `PROVIDER_OPTIONS`. */
export function protocolDefaultModel(protocol: AtlasProtocol): string {
  const option = PROVIDER_OPTIONS.find((entry) => entry.id === protocol);
  return option?.defaultModel ?? 'gpt-4.1-mini';
}

export interface WizardConfigResolution {
  readonly provider: AtlasProtocol;
  readonly baseUrl: string;
  readonly model: string;
}

/**
 * Builds the exact config the wizard will validate and then save.
 *
 * Order of resolution mirrors `atlas config init`: the picked selection's own
 * endpoint and model first; a typed endpoint next (protocol inferred from its
 * shape); the registry vendor serving that endpoint recovered for its top
 * model when the selection did not carry one (typing a known vendor's URL by
 * hand gets the same model the menu would have offered); the wire-format
 * default last.
 *
 * Returns `undefined` only when there is no endpoint at all — a state the
 * endpoint step exists to prevent.
 */
export function resolveWizardConfig(input: {
  readonly selection: WizardSelection | null;
  readonly typedEndpoint: string;
  readonly providers: readonly ProviderInfo[];
  readonly fallbackProvider: AtlasProtocol;
}): WizardConfigResolution | undefined {
  const typed = input.typedEndpoint.trim();
  const baseUrl =
    input.selection?.baseUrl ?? (typed === '' ? undefined : typed);
  if (baseUrl === undefined) return undefined;
  const provider =
    input.selection?.protocol ??
    (typed === '' ? undefined : protocolFromUrl(typed)) ??
    input.fallbackProvider;
  const recovered =
    input.selection?.model === undefined
      ? vendorForUrl(input.providers, baseUrl)
      : undefined;
  const model =
    input.selection?.model ??
    recovered?.models[0]?.id ??
    protocolDefaultModel(provider);
  return { provider, baseUrl, model };
}
