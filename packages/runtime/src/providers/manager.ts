import { ModelProvider, ProviderConfig } from './index';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';

export class ProviderManager {
  private primaryProvider: ModelProvider | null = null;
  private fallbackProvider: ModelProvider | null = null;

  constructor(private config: { ollama?: { baseUrl?: string }; openrouter?: { apiKey?: string }; defaultToOpenRouter: boolean }) {}

  async initialize(): Promise<void> {
    const ollamaProvider = new OllamaProvider({ name: 'ollama', baseUrl: this.config.ollama?.baseUrl, defaultModel: 'llama3.2' });
    const ollamaAvailable = await ollamaProvider.testConnection();
    
    const apiKey = process.env.OPENROUTER_API_KEY || this.config.openrouter?.apiKey;
    
    if (ollamaAvailable) {
      this.primaryProvider = ollamaProvider;
      console.log('✓ Ollama detected and set as primary provider');
    } else {
      console.log('✗ Ollama not available');
      if (apiKey) {
        try {
          this.primaryProvider = new OpenRouterProvider({ name: 'openrouter', apiKey, defaultModel: 'openai/gpt-4o-mini' });
          const openRouterAvailable = await this.primaryProvider.testConnection();
          if (openRouterAvailable) console.log('✓ OpenRouter configured and available');
          else this.primaryProvider = null;
        } catch (error) {
          console.error('Failed to initialize OpenRouter:', error);
        }
      }
    }
  }

  async generateCompletion(model: string, prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.primaryProvider) throw new Error('No provider available');
    let actualModel = model;
    if (this.primaryProvider.name === 'openrouter') {
      actualModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    }
    return this.primaryProvider.generateCompletion({ model: actualModel, prompt, systemPrompt });
  }

  getStatus(): { primary: string; fallback: string | null } {
    return { primary: this.primaryProvider?.name || 'none', fallback: this.fallbackProvider?.name || null };
  }
}
