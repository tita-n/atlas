import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  type MemoryDatabase,
} from '../../src/memory/database.js';
import { ConversationRepository } from '../../src/memory/conversation-repository.js';

const temporaryDirectories: string[] = [];
const openDatabases: MemoryDatabase[] = [];

async function createRepository(): Promise<ConversationRepository> {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-conversations-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'atlas.db'));
  openDatabases.push(database);
  return new ConversationRepository(database);
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ConversationRepository', () => {
  it('creates conversations and appends messages with activity updates', async () => {
    const repository = await createRepository();
    const conversation = repository.createConversation('Test conversation');
    const user = repository.appendMessage(conversation.id, {
      role: 'user',
      content: 'Hello',
    });
    const assistant = repository.appendMessage(conversation.id, {
      role: 'assistant',
      content: 'Hi there',
      tokenCount: 3,
    });

    expect(user.conversationId).toBe(conversation.id);
    expect(assistant.tokenCount).toBe(3);
    expect(repository.getRecentMessages(conversation.id)).toEqual([
      expect.objectContaining({ role: 'user', content: 'Hello' }),
      expect.objectContaining({ role: 'assistant', content: 'Hi there' }),
    ]);
    expect(repository.getMostRecentConversation()?.id).toBe(conversation.id);
    expect(repository.listConversations()[0]?.messageCount).toBe(2);
  });

  it('returns only the most recent requested messages in chronological order', async () => {
    const repository = await createRepository();
    const conversation = repository.createConversation();
    for (const content of ['one', 'two', 'three']) {
      repository.appendMessage(conversation.id, { role: 'user', content });
    }

    expect(
      repository
        .getRecentMessages(conversation.id, 2)
        .map((message) => message.content),
    ).toEqual(['two', 'three']);
    expect(repository.getRecentMessages(conversation.id, 0)).toEqual([]);
  });
});
