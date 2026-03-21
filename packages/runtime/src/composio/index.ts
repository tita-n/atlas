import { Composio } from '@composio/core';
import fs from 'fs/promises';
import path from 'path';

export interface ComposioToolkit {
  name: string;
  slug: string;
  enabled: boolean;
  connected: boolean;
}

const DEFAULT_TOOLKIT_SLUGS = ['github', 'gmail', 'slack', 'hackernews', 'tavily'];
const STATE_FILE = path.join(process.cwd(), 'data', 'composio_state.json');

interface ComposioState {
  enabledToolkits: string[];
  sessionId?: string;
}

class ComposioService {
  private client: Composio | null = null;
  private enabledToolkits: Set<string> = new Set();
  private sessionId: string | null = null;

  async initialize(apiKey: string): Promise<void> {
    if (!apiKey) throw new Error('Composio API key is required');

    this.client = new Composio({ apiKey });
    await this.loadState();

    if (this.enabledToolkits.size === 0) {
      for (const slug of DEFAULT_TOOLKIT_SLUGS) {
        this.enabledToolkits.add(slug);
      }
    }

    if (!this.sessionId) {
      const session = await this.client.toolRouter.create('atlas_user');
      this.sessionId = session.sessionId;
    }
    
    await this.saveState();
    console.log(`Composio initialized: session=${this.sessionId}, toolkits=${this.enabledToolkits.size}`);
  }

  private async loadState(): Promise<void> {
    try {
      const data = await fs.readFile(STATE_FILE, 'utf-8');
      const state: ComposioState = JSON.parse(data);
      this.enabledToolkits = new Set(state.enabledToolkits || []);
      this.sessionId = state.sessionId || null;
    } catch {
      this.enabledToolkits = new Set(DEFAULT_TOOLKIT_SLUGS);
    }
  }

  private async saveState(): Promise<void> {
    const state: ComposioState = {
      enabledToolkits: Array.from(this.enabledToolkits),
      sessionId: this.sessionId || undefined
    };
    const dir = path.dirname(STATE_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private async getSession() {
    if (!this.client || !this.sessionId) throw new Error('Composio not initialized');
    return await this.client.toolRouter.use(this.sessionId);
  }

  isConnected(): boolean {
    return this.client !== null && this.sessionId !== null;
  }

  async listToolkits(): Promise<ComposioToolkit[]> {
    if (!this.isConnected()) return [];
    try {
      const session = await this.getSession();
      const response = await session.toolkits({ limit: 100 });
      return response.items.map((tk: any) => ({
        name: tk.name,
        slug: tk.slug,
        enabled: this.enabledToolkits.has(tk.slug),
        connected: tk.connection?.isActive || false
      }));
    } catch (error) {
      console.error('Failed to list toolkits:', error);
      return [];
    }
  }

  async searchTools(query: string): Promise<any[]> {
    if (!this.isConnected()) return [];
    try {
      const session = await this.getSession();
      const response = await session.search({
        query,
        toolkits: Array.from(this.enabledToolkits)
      });
      return response.results || [];
    } catch (error) {
      console.error('Failed to search tools:', error);
      return [];
    }
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string | null; executionTime: number }> {
    if (!this.isConnected()) {
      return { success: false, error: 'Composio not initialized', executionTime: 0 };
    }
    const startTime = Date.now();
    try {
      const session = await this.getSession();
      const result = await session.execute(toolSlug, arguments_);
      return {
        success: !result.error,
        data: result.data,
        error: result.error,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }

  enableToolkit(slug: string): void {
    this.enabledToolkits.add(slug);
    this.saveState();
  }

  disableToolkit(slug: string): void {
    this.enabledToolkits.delete(slug);
    this.saveState();
  }

  getEnabledToolkitSlugs(): string[] {
    return Array.from(this.enabledToolkits);
  }

  async getAuthUrl(toolkitSlug: string): Promise<string | null> {
    if (!this.isConnected()) return null;
    try {
      const session = await this.getSession();
      const connectionRequest = await session.authorize(toolkitSlug, {
        callbackUrl: 'http://localhost:3421/auth/callback'
      });
      return connectionRequest.redirectUrl || null;
    } catch (error) {
      console.error(`Failed to get auth URL for ${toolkitSlug}:`, error);
      return null;
    }
  }

  async getConnectedAccounts(): Promise<Record<string, boolean>> {
    if (!this.isConnected()) return {};
    try {
      const session = await this.getSession();
      const toolkits = await session.toolkits({ limit: 100 });
      const result: Record<string, boolean> = {};
      for (const tk of toolkits.items) {
        result[tk.slug] = tk.connection?.isActive || false;
      }
      return result;
    } catch (error) {
      return {};
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

export const composioService = new ComposioService();
