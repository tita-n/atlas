import { describe, expect, it, vi } from 'vitest';
import { Conversation } from '../../src/conversation/conversation.js';
import type {
  ChatCompletionRequest,
  LLMProvider,
  ToolExecutor,
} from '../../src/providers/provider.interface.js';

describe('Conversation tool loop', () => {
  it('executes structured calls and continues to a final response', async () => {
    const responses = [
      {
        content: '',
        model: 'mock',
        toolCalls: [
          { id: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
        ],
      },
      { content: 'The current directory is /tmp.', model: 'mock' },
    ];
    const chatCompletion = vi
      .fn<LLMProvider['chatCompletion']>()
      .mockImplementation(() => {
        const next = responses.shift();
        if (next === undefined)
          return Promise.reject(new Error('missing response'));
        return Promise.resolve(next);
      });
    const provider: LLMProvider = { name: 'mock', chatCompletion };
    const execute = vi.fn<ToolExecutor['execute']>().mockResolvedValue({
      content: '/tmp',
    });
    const conversation = new Conversation({
      model: 'mock',
      tools: [
        {
          name: 'shell',
          description: 'Run a command',
          parameters: { type: 'object' },
        },
      ],
      toolExecutor: { execute },
    });

    const result = await conversation.send(provider, 'Where am I?');

    expect(result.content).toBe('The current directory is /tmp.');
    expect(execute).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'shell',
      arguments: { command: 'pwd' },
    });
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(conversation.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    const secondRequest: ChatCompletionRequest | undefined =
      chatCompletion.mock.calls[1]?.[0];
    expect(secondRequest?.messages[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call-1',
      content: '/tmp',
    });
  });

  it('fails safely when a tool call has no executor', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      chatCompletion: () =>
        Promise.resolve({
          content: '',
          model: 'mock',
          toolCalls: [
            { id: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
          ],
        }),
    };
    const conversation = new Conversation({
      model: 'mock',
      tools: [
        {
          name: 'shell',
          description: 'Run a command',
          parameters: { type: 'object' },
        },
      ],
    });

    await expect(conversation.send(provider, 'Run pwd')).rejects.toThrow(
      'no harness tool executor',
    );
  });
});
