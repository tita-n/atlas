import { ModelProvider, ProviderConfig } from './index';

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private baseUrl = 'https://openrouter.ai/api/v1';

  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error('OpenRouter API key is required');
    this.apiKey = config.apiKey;
  }

  get isAvailable(): boolean { return true; }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: { 'Authorization': `Bearer ${this.apiKey}` } });
      return response.ok;
    } catch { return false; }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: { 'Authorization': `Bearer ${this.apiKey}` } });
      const data = await response.json() as { data: { id: string }[] };
      return data.data.map(m => m.id);
    } catch { return []; }
  }

  async generateCompletion(params: { model: string; prompt: string; systemPrompt?: string }): Promise<string> {
    const messages = [];
    if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt });
    messages.push({ role: 'user', content: params.prompt });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: params.model, messages, stream: false })
    });
    const data = await response.json() as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content || '';
  }
}
