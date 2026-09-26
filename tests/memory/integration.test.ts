import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../../src/conversation/conversation.js';
import { buildSystemPrompt } from '../../src/memory/context-builder.js';
import { ConversationRepository } from '../../src/memory/conversation-repository.js';
import { openDatabase } from '../../src/memory/database.js';
import { FactExtractor } from '../../src/memory/fact-extractor.js';
import { FactsRepository } from '../../src/memory/facts-repository.js';
import type {
  ChatCompletionRequest,
  LLMProvider,
} from '../../src/providers/provider.interface.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('persistent conversation integration', () => {
  it('resumes history and injects facts into a later session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-integration-'));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, 'atlas.db'));
    const conversations = new ConversationRepository(database);
    const facts = new FactsRepository(database);
    const requests: ChatCompletionRequest[] = [];
    const chatCompletion = vi
      .fn<LLMProvider['chatCompletion']>()
      .mockImplementation((request) => {
        requests.push(request);
        const isExtraction = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.startsWith('Extract durable facts'),
        );
        return Promise.resolve({
          model: 'mock-model',
          content: isExtraction
            ? '{"facts":[{"content":"My name is Sam.","category":"identity"}]}'
            : `mock reply ${request.messages.length}`,
        });
      });
    const provider: LLMProvider = { name: 'mock', chatCompletion };
    const extractor = new FactExtractor({
      provider,
      factsRepository: facts,
      model: 'mock-model',
    });

    try {
      const firstSession = new Conversation({
        model: 'mock-model',
        conversationRepository: conversations,
        buildSystemPrompt: () => buildSystemPrompt(facts.getAllFacts()),
        onTurnComplete: async (turn) => {
          await extractor.extractAndStore({
            userContent: turn.userMessage.content,
            assistantContent: turn.assistantMessage.content,
            sourceMessageId: turn.userMessageId,
          });
        },
      });
      await firstSession.send(provider, 'My name is Sam.');
      await firstSession.flush();

      const resumed = conversations.getMostRecentConversation();
      expect(resumed).toBeDefined();
      if (resumed === undefined)
        throw new Error('Expected a persisted conversation.');
      const secondSession = new Conversation({
        model: 'mock-model',
        conversationRepository: conversations,
        conversationId: resumed.id,
        buildSystemPrompt: () => buildSystemPrompt(facts.getAllFacts()),
      });
      await secondSession.send(provider, 'What do you know about me?');

      const latestRequest = requests.at(-1);
      expect(latestRequest).toBeDefined();
      if (latestRequest === undefined) {
        throw new Error('Expected a provider request.');
      }
      const systemMessage = latestRequest.messages[0];
      expect(systemMessage?.role).toBe('system');
      expect(systemMessage?.content).toContain('My name is Sam.');
      expect(
        latestRequest.messages.slice(1).map((message) => message.content),
      ).toEqual([
        'My name is Sam.',
        'mock reply 2',
        'What do you know about me?',
      ]);
      expect(facts.getAllFacts()).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
