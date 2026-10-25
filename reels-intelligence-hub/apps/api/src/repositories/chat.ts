import {
  AppError,
  ERROR_CODES,
  randomId,
  type ChatMessage,
  type ChatScope,
  type Citation,
  type Conversation,
  type UsageUnits,
} from '@rih/shared';
import { all, first, nowIso, run } from '../db/client.js';
import { toChatMessage, toConversation } from '../db/mappers.js';

/** Conversations and messages. */

export async function createConversation(
  db: D1Database,
  input: {
    ownerId: string;
    collectionId: string | null;
    title?: string;
    scopeType: ChatScope;
  },
): Promise<Conversation> {
  const id = randomId();
  const now = nowIso();
  await run(
    db,
    `INSERT INTO conversations (id, owner_id, collection_id, title, scope_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.ownerId,
      input.collectionId,
      input.title?.trim() || 'New conversation',
      input.scopeType,
      now,
      now,
    ],
  );
  return getConversation(db, input.ownerId, id);
}

export async function getConversation(
  db: D1Database,
  ownerId: string,
  conversationId: string,
): Promise<Conversation> {
  const row = await first<Record<string, unknown>>(
    db,
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c WHERE c.id = ? AND c.owner_id = ?`,
    [conversationId, ownerId],
  );
  if (!row) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      'That conversation does not exist, or you do not have access to it.',
    );
  }
  return toConversation(row);
}

export async function listConversations(
  db: D1Database,
  ownerId: string,
  options: { collectionId?: string; limit?: number } = {},
): Promise<Conversation[]> {
  const where = ['c.owner_id = ?'];
  const params: (string | number)[] = [ownerId];
  if (options.collectionId) {
    where.push('c.collection_id = ?');
    params.push(options.collectionId);
  }
  params.push(options.limit ?? 50);

  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
      WHERE ${where.join(' AND ')}
      ORDER BY c.updated_at DESC LIMIT ?`,
    params,
  );
  return rows.map(toConversation);
}

export async function renameConversation(
  db: D1Database,
  ownerId: string,
  conversationId: string,
  title: string,
): Promise<void> {
  await getConversation(db, ownerId, conversationId);
  await run(db, 'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [
    title.trim().slice(0, 120) || 'Untitled conversation',
    nowIso(),
    conversationId,
  ]);
}

export async function deleteConversation(
  db: D1Database,
  ownerId: string,
  conversationId: string,
): Promise<void> {
  await getConversation(db, ownerId, conversationId);
  await run(db, 'DELETE FROM conversations WHERE id = ? AND owner_id = ?', [
    conversationId,
    ownerId,
  ]);
}

export async function listMessages(
  db: D1Database,
  conversationId: string,
  limit = 200,
): Promise<ChatMessage[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?',
    [conversationId, limit],
  );
  return rows.map(toChatMessage);
}

export async function addMessage(
  db: D1Database,
  input: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    citations?: Citation[];
    modelIdentifier?: string | null;
    usage?: UsageUnits | null;
  },
): Promise<ChatMessage> {
  const id = randomId();
  const now = nowIso();
  await run(
    db,
    `INSERT INTO messages
       (id, conversation_id, role, content, citations_json, model_identifier, usage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.conversationId,
      input.role,
      input.content,
      JSON.stringify(input.citations ?? []),
      input.modelIdentifier ?? null,
      input.usage ? JSON.stringify(input.usage) : null,
      now,
    ],
  );
  await run(db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [
    now,
    input.conversationId,
  ]);
  const row = await first<Record<string, unknown>>(db, 'SELECT * FROM messages WHERE id = ?', [id]);
  return toChatMessage(row ?? { id });
}

/** Auto-title a conversation from its first user message. */
export async function maybeAutoTitle(
  db: D1Database,
  conversationId: string,
  firstMessage: string,
): Promise<void> {
  const row = await first<{ title: string }>(db, 'SELECT title FROM conversations WHERE id = ?', [
    conversationId,
  ]);
  if (!row || row.title !== 'New conversation') return;
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 70);
  if (!title) return;
  await run(db, 'UPDATE conversations SET title = ? WHERE id = ?', [title, conversationId]);
}
