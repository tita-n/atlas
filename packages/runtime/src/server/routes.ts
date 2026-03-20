import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getAgent, listAgents } from '../agents/registry';
import { bus, Message } from '../bus/bus';
import { ProviderManager } from '../providers/manager';
import { memoryService } from '../memory';

export async function registerRoutes(app: FastifyInstance, providerManager: ProviderManager) {
  try {
    await memoryService.initialize({ dbPath: './data/atlas_memory.json' });
  } catch (error) {
    console.error('Failed to initialize memory service:', error);
  }

  app.get('/health', async () => {
    const status = providerManager.getStatus();
    return { status: 'ok', primary: status.primary, fallback: status.fallback, memory: memoryService.isInitialized() };
  });

  app.get('/models', async () => {
    return { models: [] };
  });

  app.get('/agents', async () => {
    return { agents: listAgents() };
  });

  app.get('/providers', async () => {
    return providerManager.getStatus();
  });

  app.get('/memory/stats', async () => {
    const counts = await memoryService.getAllAgentMemoryCounts();
    return { counts, conversationId: memoryService.getCurrentConversationId(), initialized: memoryService.isInitialized() };
  });

  app.get('/memory/:agentName', async (request) => {
    const { agentName } = request.params as { agentName: string };
    const memories = await memoryService.getConversationHistory();
    return { memories: memories.slice(-20).reverse() };
  });

  app.post('/settings', async (request, reply) => {
    const body = request.body as { openrouterApiKey?: string; selectedModel?: string };
    if (body.openrouterApiKey) {
      process.env.OPENROUTER_API_KEY = body.openrouterApiKey;
      await providerManager.initialize();
    }
    if (body.selectedModel) {
      process.env.OPENROUTER_MODEL = body.selectedModel;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    reply.send({ status: 'updated', primary: providerManager.getStatus().primary });
  });

  app.get('/openrouter/models', async (request, reply) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return reply.code(400).send({ error: 'No API key' });
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${apiKey}` } });
      const data = await response.json() as { data: { id: string; name: string; context_length?: number }[] };
      reply.send({ models: data.data.map(m => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length || 0 })) });
    } catch { reply.code(500).send({ error: 'Failed to fetch models' }); }
  });

  app.post('/chat', async (request, reply) => {
    const body = request.body as { message: string; sender?: string };
    if (!body.message) return reply.code(400).send({ error: 'Message required' });
    const status = providerManager.getStatus();
    if (status.primary === 'none') return reply.code(503).send({ error: 'No provider configured' });

    const userMessageId = uuidv4();
    const userMessage: Message = { id: userMessageId, type: 'user', sender: body.sender || 'user', content: body.message, timestamp: new Date() };
    
    if (memoryService.isInitialized()) {
      await memoryService.storeMessage(body.message, 'user', 'user');
    }
    bus.publish(userMessage);

    try {
      const lowerMessage = body.message.toLowerCase();
      let targetAgentName = 'Atlas';
      if (lowerMessage.includes('summarize') || lowerMessage.includes('research') || lowerMessage.includes('explain')) {
        targetAgentName = 'Research';
      } else if (lowerMessage.includes('todo') || lowerMessage.includes('schedule') || lowerMessage.includes('meeting')) {
        targetAgentName = 'Planner';
      }
      
      const targetAgent = getAgent(targetAgentName);
      if (!targetAgent) throw new Error('Agent not found');

      let systemPrompt = targetAgent.systemPrompt;
      if (memoryService.isInitialized()) {
        const memories = await memoryService.retrieveMemories(body.message, targetAgentName, 5);
        if (memories.length > 0) {
          const memoryBlock = memories.map(m => `[${m.agentName}: ${m.content}]`).join('\n');
          systemPrompt = `Relevant context:\n${memoryBlock}\n---\n${targetAgent.systemPrompt}`;
        }
      }

      const agentResponse = await providerManager.generateCompletion(targetAgent.model, body.message, systemPrompt);
      
      const agentMessageId = uuidv4();
      const agentMessage: Message = { id: agentMessageId, type: 'agent', sender: targetAgentName, target: 'user', content: agentResponse, timestamp: new Date(), metadata: { routedFrom: 'Atlas' } };

      if (memoryService.isInitialized()) {
        await memoryService.storeMessage(agentResponse, targetAgentName, 'agent');
      }
      bus.publish(agentMessage);
      reply.send({ response: agentResponse, agent: targetAgentName, messageId: agentMessageId });
    } catch (error) {
      reply.code(500).send({ error: 'Internal server error', details: (error as Error).message });
    }
  });

  const loadConversation = async () => {
    if (!memoryService.isInitialized()) return;
    try {
      const history = await memoryService.getConversationHistory();
      if (history.length > 0) {
        history.forEach(msg => {
          const message: Message = { id: msg.id, type: msg.role === 'user' ? 'user' : 'agent', sender: msg.agentName, content: msg.content, timestamp: new Date(msg.timestamp) };
          bus.publish(message);
        });
      }
    } catch {}
  };
  setTimeout(loadConversation, 2000);

  const messageHistory: Message[] = [];
  bus.subscribe('*', (msg) => {
    if (!messageHistory.find(m => m.id === msg.id)) {
      messageHistory.push(msg);
      if (messageHistory.length > 100) messageHistory.shift();
    }
  });

  app.get('/history', async () => {
    return { history: messageHistory };
  });
}
