import { Hono } from 'hono';
import { createConversationSchema, sendMessageSchema } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, queryObject, readJson } from '../middleware/validate.js';
import { currentUser, enforceRateLimit, requireAuth } from '../middleware/auth.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '../repositories/chat.js';
import { sendMessage } from '../services/chat.js';

const chat = new Hono<AppEnv>();
chat.use('*', requireAuth);

chat.get('/conversations', async (c) => {
  const user = currentUser(c);
  const query = queryObject(c.req.url);
  const conversations = await listConversations(c.env.DB, user.id, {
    ...(query['collectionId'] ? { collectionId: query['collectionId'] } : {}),
  });
  return c.json({ data: conversations });
});

chat.post('/conversations', async (c) => {
  const user = currentUser(c);
  const body = parse(createConversationSchema, await readJson(c.req.raw));
  const conversation = await createConversation(c.env.DB, {
    ownerId: user.id,
    collectionId: body.collectionId ?? null,
    scopeType: body.scopeType,
    ...(body.title ? { title: body.title } : {}),
  });
  return c.json({ data: conversation }, 201);
});

chat.get('/conversations/:id', async (c) => {
  const user = currentUser(c);
  const conversation = await getConversation(c.env.DB, user.id, c.req.param('id'));
  const messages = await listMessages(c.env.DB, conversation.id);
  return c.json({ data: { conversation, messages } });
});

chat.patch('/conversations/:id', async (c) => {
  const user = currentUser(c);
  const body = (await readJson(c.req.raw)) as { title?: string };
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'A title is required.',
          retryable: false,
          requestId: c.get('requestId'),
        },
      },
      400,
    );
  }
  await renameConversation(c.env.DB, user.id, c.req.param('id'), body.title);
  return c.json({ data: await getConversation(c.env.DB, user.id, c.req.param('id')) });
});

chat.delete('/conversations/:id', async (c) => {
  const user = currentUser(c);
  await deleteConversation(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: { ok: true } });
});

/**
 * Ask a question.
 *
 * This endpoint is intentionally non-streaming: the answer is generated in one
 * pass and returned complete. Streaming is the obvious next improvement and is
 * noted in README § Known limitations — but a fake typewriter effect over a
 * buffered response would be dishonest, so we do not ship one.
 */
chat.post('/conversations/:id/messages', async (c) => {
  const user = currentUser(c);
  await enforceRateLimit(c.env, user.id, 'chat', 30);

  const body = parse(sendMessageSchema, await readJson(c.req.raw));
  const conversation = await getConversation(c.env.DB, user.id, c.req.param('id'));

  const result = await sendMessage(c.env, c.env.DB, {
    ownerId: user.id,
    conversationId: conversation.id,
    question: body.content,
    ...(body.collectionIds ? { collectionIds: body.collectionIds } : {}),
    ...(body.contentItemId ? { contentItemId: body.contentItemId } : {}),
  });

  return c.json({
    data: {
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      semanticAvailable: result.semanticAvailable,
    },
  });
});

export default chat;
