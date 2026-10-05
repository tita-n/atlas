import { randomUUID } from 'node:crypto';
import { MemoryOperationError } from '../errors.js';
import type {
  ChatMessage,
  ChatRole,
  ToolCall,
} from '../providers/provider.interface.js';
import type { MemoryDatabase } from './database.js';

/** Metadata for one persisted conversation. */
export interface ConversationRecord {
  /** Stable UUID for the conversation. */
  id: string;
  /** ISO timestamp when the conversation was created. */
  startedAt: string;
  /** ISO timestamp of the most recently persisted message. */
  lastActiveAt: string;
  /** Optional human-readable title reserved for later phases. */
  title: string | null;
}

/** A message row loaded from SQLite. */
export interface StoredMessage {
  /** SQLite message identifier. */
  id: number;
  /** Conversation containing the message. */
  conversationId: string;
  /** Provider-neutral message role. */
  role: ChatRole;
  /** Message text. */
  content: string;
  /** ISO creation timestamp. */
  createdAt: string;
  /** Optional token count supplied by the provider. */
  tokenCount: number | null;
  /** Internal persistence kind used to reconstruct tool messages. */
  messageType: 'message' | 'tool_call' | 'tool_result';
  /** Tool calls attached to an assistant message. */
  toolCalls: ToolCall[];
  /** Provider call identifier for a tool result. */
  toolCallId: string | null;
  /** Whether a tool result represents an error. */
  isError: boolean;
}

/** Input for appending a message to a conversation. */
export interface AppendMessageInput {
  /** Provider-neutral message role. */
  role: ChatRole;
  /** Message text. */
  content: string;
  /** Optional token count associated with the message. */
  tokenCount?: number | null;
  /** Tool calls attached to an assistant message. */
  toolCalls?: readonly ToolCall[];
  /** Provider call identifier for a tool result. */
  toolCallId?: string | null;
  /** Whether a tool result represents an error. */
  isError?: boolean;
}

/** Conversation summary used by the history command. */
export interface ConversationSummary extends ConversationRecord {
  /** Number of messages currently stored for the conversation. */
  messageCount: number;
}

/** Optional deterministic dependencies useful for tests. */
export interface ConversationRepositoryOptions {
  /** Clock used for generated timestamps. */
  now?: (() => string) | undefined;
  /** UUID factory used for new conversations. */
  idFactory?: (() => string) | undefined;
}

interface ConversationRow {
  id: string;
  started_at: string;
  last_active_at: string;
  title: string | null;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  token_count: number | null;
  message_type: 'message' | 'tool_call' | 'tool_result';
  tool_call_id: string | null;
  tool_name: string | null;
  tool_arguments: string | null;
  is_error: number | null;
}

interface ConversationSummaryRow extends ConversationRow {
  message_count: number;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    title: row.title,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseToolCalls(value: string | null): ToolCall[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        !isRecord(item.arguments)
      ) {
        return [];
      }
      return [{ id: item.id, name: item.name, arguments: item.arguments }];
    });
  } catch {
    return [];
  }
}

function toMessage(row: MessageRow): StoredMessage {
  const toolCalls = parseToolCalls(row.tool_arguments);
  const role: ChatRole = row.message_type === 'tool_result' ? 'tool' : row.role;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role,
    content: row.content,
    createdAt: row.created_at,
    tokenCount: row.token_count,
    messageType: row.message_type,
    toolCalls,
    toolCallId: row.tool_call_id,
    isError: row.is_error === 1,
  };
}

function toChatMessage(message: StoredMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls.length === 0 ? {} : { toolCalls: message.toolCalls }),
    ...(message.toolCallId === null ? {} : { toolCallId: message.toolCallId }),
    ...(message.isError ? { isError: true } : {}),
  };
}

/** Typed persistence operations for conversations and their messages. */
export class ConversationRepository {
  readonly #database: MemoryDatabase;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  public constructor(
    database: MemoryDatabase,
    options: ConversationRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  /** Creates and returns a new conversation row. */
  public createConversation(title: string | null = null): ConversationRecord {
    const now = this.#now();
    const conversation: ConversationRecord = {
      id: this.#idFactory(),
      startedAt: now,
      lastActiveAt: now,
      title,
    };

    try {
      this.#database.connection
        .prepare(
          'INSERT INTO conversations (id, started_at, last_active_at, title) VALUES (?, ?, ?, ?)',
        )
        .run(
          conversation.id,
          conversation.startedAt,
          conversation.lastActiveAt,
          conversation.title,
        );
    } catch (error) {
      throw new MemoryOperationError('Could not create the conversation.', {
        cause: error,
      });
    }

    return conversation;
  }

  /** Appends a message and advances the parent conversation activity timestamp. */
  public appendMessage(
    conversationId: string,
    message: AppendMessageInput,
  ): StoredMessage {
    const insert = this.#database.connection.prepare(
      `INSERT INTO messages
       (conversation_id, role, content, created_at, token_count, message_type,
        tool_call_id, tool_name, tool_arguments, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findConversation = this.#database.connection.prepare<
      [string],
      { id: string }
    >('SELECT id FROM conversations WHERE id = ?');
    const touchConversation = this.#database.connection.prepare(
      'UPDATE conversations SET last_active_at = ? WHERE id = ?',
    );
    const transaction = this.#database.connection.transaction(() => {
      if (findConversation.get(conversationId) === undefined) {
        throw new MemoryOperationError(
          `Conversation ${conversationId} does not exist.`,
        );
      }

      const createdAt = this.#now();
      const toolCalls = message.toolCalls ?? [];
      const messageType =
        message.role === 'tool'
          ? 'tool_result'
          : toolCalls.length > 0
            ? 'tool_call'
            : 'message';
      const firstToolCall = toolCalls[0];
      const result = insert.run(
        conversationId,
        message.role === 'tool' ? 'assistant' : message.role,
        message.content,
        createdAt,
        message.tokenCount ?? null,
        messageType,
        message.toolCallId ?? firstToolCall?.id ?? null,
        firstToolCall?.name ?? null,
        toolCalls.length === 0 ? null : JSON.stringify(toolCalls),
        message.isError === true ? 1 : 0,
      );
      touchConversation.run(createdAt, conversationId);
      return {
        id: Number(result.lastInsertRowid),
        conversationId,
        role: message.role,
        content: message.content,
        createdAt,
        tokenCount: message.tokenCount ?? null,
        messageType,
        toolCalls: [...toolCalls],
        toolCallId: message.toolCallId ?? firstToolCall?.id ?? null,
        isError: message.isError === true,
      } satisfies StoredMessage;
    });

    try {
      return transaction();
    } catch (error) {
      if (error instanceof MemoryOperationError) throw error;
      throw new MemoryOperationError('Could not append the message.', {
        cause: error,
      });
    }
  }

  /** Returns up to `limit` messages in chronological order. */
  public getRecentMessages(
    conversationId: string,
    limit = 20,
  ): StoredMessage[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : 20;
    const rows = this.#database.connection
      .prepare<[string, number], MessageRow>(
        `SELECT id, conversation_id, role, content, created_at, token_count,
                message_type, tool_call_id, tool_name, tool_arguments, is_error
         FROM (
           SELECT id, conversation_id, role, content, created_at, token_count,
                  message_type, tool_call_id, tool_name, tool_arguments, is_error
           FROM messages
           WHERE conversation_id = ?
           ORDER BY id DESC
           LIMIT ?
         )
         ORDER BY id ASC`,
      )
      .all(conversationId, normalizedLimit);

    return rows.map(toMessage);
  }

  /** Returns recent messages in provider-neutral form. */
  public getRecentChatMessages(
    conversationId: string,
    limit = 20,
  ): ChatMessage[] {
    const messages = this.getRecentMessages(conversationId, limit).map(
      toChatMessage,
    );
    // A window can begin with a tool result whose originating tool_call was
    // cut off. Providers reject that whole request, so drop leading orphans
    // until the history starts on something valid.
    let start = 0;
    while (start < messages.length && messages[start]?.role === 'tool') {
      start += 1;
    }
    return messages.slice(start);
  }

  /** Returns the conversation with the most recent activity, if one exists. */
  public getMostRecentConversation(): ConversationRecord | undefined {
    const row = this.#database.connection
      .prepare<[], ConversationRow>(
        `SELECT id, started_at, last_active_at, title
         FROM conversations
         ORDER BY last_active_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get();
    return row === undefined ? undefined : toConversation(row);
  }

  /** Lists conversations newest-first with their message counts. */
  public listConversations(): ConversationSummary[] {
    const rows = this.#database.connection
      .prepare<[], ConversationSummaryRow>(
        `SELECT c.id, c.started_at, c.last_active_at, c.title,
                COUNT(m.id) AS message_count
         FROM conversations AS c
         LEFT JOIN messages AS m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.last_active_at DESC, c.rowid DESC`,
      )
      .all();
    return rows.map((row) => ({
      ...toConversation(row),
      messageCount: row.message_count,
    }));
  }
}
