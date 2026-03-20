export interface ModelProvider {
  readonly name: string;
  readonly isAvailable: boolean;
  listModels(): Promise<string[]>;
  generateCompletion(params: { model: string; prompt: string; systemPrompt?: string }): Promise<string>;
  testConnection(): Promise<boolean>;
}

export interface ProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
}
