import fs from 'fs';
import path from 'path';

export interface MemoryEntry {
  id: string;
  content: string;
  agentName: string;
  timestamp: Date;
  conversationId: string;
  role: 'user' | 'agent';
}

interface StoredMemory {
  id: string;
  content: string;
  agentName: string;
  timestamp: string;
  conversationId: string;
  role: 'user' | 'agent';
}

class MemoryService {
  private dbPath: string = '';
  private memories: StoredMemory[] = [];
  private currentConversationId: string = '';
  private initialized: boolean = false;

  async initialize(config: { dbPath: string }): Promise<void> {
    if (this.initialized) return;
    this.dbPath = config.dbPath;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(this.dbPath)) {
      try {
        const data = fs.readFileSync(this.dbPath, 'utf-8');
        this.memories = JSON.parse(data);
      } catch (error) {
        this.memories = [];
      }
    }
    this.currentConversationId = await this.getLastConversationId() || this.createConversation();
    this.initialized = true;
  }

  private saveToDisk(): void {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.memories, null, 2));
    } catch (error) {
      console.error('Failed to save memories:', error);
    }
  }

  async storeMessage(content: string, agentName: string, role: 'user' | 'agent', conversationId?: string): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const convId = conversationId || this.currentConversationId;
    this.memories.push({ id, content, agentName, timestamp: new Date().toISOString(), conversationId: convId, role });
    this.saveToDisk();
    return id;
  }

  async retrieveMemories(query: string, agentName: string, limit: number = 5): Promise<MemoryEntry[]> {
    return this.memories
      .filter(m => m.conversationId === this.currentConversationId)
      .slice(-limit)
      .map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  }

  createConversation(): string {
    this.currentConversationId = `conv-${Date.now()}`;
    return this.currentConversationId;
  }

  async getLastConversationId(): Promise<string | null> {
    if (this.memories.length > 0) {
      return this.memories[this.memories.length - 1].conversationId;
    }
    return null;
  }

  async getConversationHistory(conversationId?: string): Promise<MemoryEntry[]> {
    const convId = conversationId || this.currentConversationId;
    return this.memories
      .filter(m => m.conversationId === convId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  }

  async getAgentMemoryCount(agentName: string): Promise<number> {
    return this.memories.filter(m => m.agentName === agentName && m.conversationId === this.currentConversationId).length;
  }

  async getAllAgentMemoryCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const agent of ['Atlas', 'Research', 'Planner']) {
      counts[agent] = await this.getAgentMemoryCount(agent);
    }
    return counts;
  }

  getCurrentConversationId(): string { return this.currentConversationId; }
  isInitialized(): boolean { return this.initialized; }
}

export const memoryService = new MemoryService();
