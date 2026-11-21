import { describe, expect, it } from 'vitest';

import {
  resolveWizardConfig,
  resolveWizardSelection,
  wizardStepForSelection,
} from '../../src/tui/wizard-logic.js';
import type { ProviderInfo } from '../../src/providers/model-registry.js';

function vendor(
  input: Partial<ProviderInfo> & Pick<ProviderInfo, 'id'>,
): ProviderInfo {
  return {
    id: input.id,
    name: input.name ?? input.id,
    env: input.env ?? [],
    models: input.models ?? [
      {
        id: 'vendor-top-model',
        name: 'Vendor Top Model',
        context: 100_000,
        outputLimit: 4096,
        reasoning: false,
        toolCall: true,
      },
    ],
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
  };
}

describe('wizard provider selection and save config', () => {
  it('resolves a registry vendor endpoint and its top model', () => {
    const provider = vendor({
      id: 'example',
      baseUrl: 'https://api.example.test/v1',
    });
    const selection = resolveWizardSelection(
      { id: provider.id, label: provider.name },
      provider,
    );

    expect(selection).toMatchObject({
      baseUrl: 'https://api.example.test/v1',
      protocol: 'openai-compatible',
      model: 'vendor-top-model',
    });
    expect(wizardStepForSelection(selection)).toBe('key');
    expect(
      resolveWizardConfig({
        selection,
        typedEndpoint: '',
        providers: [provider],
        fallbackProvider: 'anthropic-compatible',
      }),
    ).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'vendor-top-model',
    });
  });

  it('uses Atlas-known defaults for OpenAI and Anthropic endpoint-less entries', () => {
    const openai = resolveWizardSelection(
      { id: 'openai', label: 'OpenAI' },
      vendor({ id: 'openai' }),
    );
    const anthropic = resolveWizardSelection(
      { id: 'anthropic', label: 'Anthropic' },
      vendor({ id: 'anthropic' }),
    );

    expect(openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(openai.protocol).toBe('openai-compatible');
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(anthropic.protocol).toBe('anthropic-compatible');
  });

  it('requires a typed endpoint when the selected vendor has none', () => {
    const selection = resolveWizardSelection(
      { id: 'unknown-hosted', label: 'Unknown Hosted Vendor' },
      vendor({ id: 'unknown-hosted' }),
    );
    expect(selection.baseUrl).toBeUndefined();
    expect(wizardStepForSelection(selection)).toBe('endpoint');
    expect(
      resolveWizardConfig({
        selection,
        typedEndpoint: '',
        providers: [],
        fallbackProvider: 'openai-compatible',
      }),
    ).toBeUndefined();
  });

  it('infers a custom endpoint protocol and never saves the endpoint as its model', () => {
    const selection = resolveWizardSelection(
      { id: '__custom__', label: 'Custom endpoint' },
      undefined,
    );
    const config = resolveWizardConfig({
      selection,
      typedEndpoint: 'https://proxy.anthropic.example/v1',
      providers: [],
      fallbackProvider: 'openai-compatible',
    });

    expect(config).toEqual({
      provider: 'anthropic-compatible',
      baseUrl: 'https://proxy.anthropic.example/v1',
      model: 'claude-sonnet-4-5',
    });
    expect(config?.model).not.toBe(config?.baseUrl);
  });

  it('recovers the selected vendor model when its endpoint is typed manually', () => {
    const provider = vendor({
      id: 'example',
      baseUrl: 'https://api.example.test/v1',
    });
    const selection = resolveWizardSelection(
      { id: '__custom__', label: 'Custom endpoint' },
      undefined,
    );
    const endpoint = provider.baseUrl;
    if (endpoint === undefined) throw new Error('expected vendor endpoint');
    expect(
      resolveWizardConfig({
        selection,
        typedEndpoint: endpoint,
        providers: [provider],
        fallbackProvider: 'anthropic-compatible',
      }),
    ).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'vendor-top-model',
    });
  });
});
