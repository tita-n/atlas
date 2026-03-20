import { Ollama } from 'ollama';
import { ModelProvider, ProviderConfig } from './index';

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  private client: Ollama;
  private available: boolean | null = null;

  constructor(config: ProviderConfig) {
    this.client = new Ollama({ host: config.baseUrl || 'http://localhost:11434' });
  }

  get isAvailable(): boolean { return this.available !== false; }

  async testConnection(): Promise<boolean> {
    try { await this.client.list(); this.available = true; return true; }
    catch { this.available = false; return false; }
  }

  async listModels(): Promise<string[]> {
    try { const models = await this.client.list(); return models.models.map(m => m.name); }
    catch { return []; }
  }

  async generateCompletion(params: { model: string; prompt: string; systemPrompt?: string }): Promise<string> {
    const response = await this.client.generate({ model: params.model, prompt: params.prompt, system: params.systemPrompt, stream: false });
    return response.response;
  }
}
