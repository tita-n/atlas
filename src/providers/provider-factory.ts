import type { AtlasConfig } from '../config/config.schema.js';
import { AnthropicCompatibleProvider } from './anthropic-compatible.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type {
  LLMProvider,
  ProviderDependencies,
} from './provider.interface.js';

/** Creates the configured provider without exposing wire formats to callers. */
export function createProvider(
  config: AtlasConfig,
  dependencies?: ProviderDependencies,
): LLMProvider {
  switch (config.provider) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        dependencies,
      });
    case 'anthropic-compatible':
      return new AnthropicCompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        dependencies,
      });
  }
}
