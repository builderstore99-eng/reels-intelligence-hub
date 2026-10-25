import { Hono } from 'hono';
import { AppError, ERROR_CODES, paginationSchema, type Collection } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, queryObject } from '../middleware/validate.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  getItem,
  getSummary,
  getTagsForItem,
  getTranscript,
  listItems,
} from '../repositories/content.js';
import { getCollection } from '../repositories/collections.js';

const content = new Hono<AppEnv>();
content.use('*', requireAuth);

/** Fetch an item and the collection it belongs to, enforcing ownership on both. */
async function loadItemWithCollection(
  env: AppEnv['Bindings'],
  ownerId: string,
  itemId: string,
): Promise<{ item: Awaited<ReturnType<typeof getItem>>; collection: Collection }> {
  const item = await getItem(env.DB, ownerId, itemId);
  if (!item.collectionId) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      'That item is not attached to any collection, so it cannot be opened here.',
    );
  }
  const collection = await getCollection(env.DB, ownerId, item.collectionId);
  return { item, collection };
}

content.get('/', async (c) => {
  const user = currentUser(c);
  const query = queryObject(c.req.url);
  const page = parse(paginationSchema, query);
  const items = await listItems(c.env.DB, user.id, {
    collectionId: query['collectionId'],
    creator: query['creator'],
    contentType: query['contentType'] as never,
    status: query['status'] as never,
    tag: query['tag'],
    sort: (query['sort'] as never) ?? 'recent',
    page: page.page,
    pageSize: page.pageSize,
  });
  return c.json({
    data: items.data,
    meta: {
      page: items.page,
      pageSize: items.pageSize,
      total: items.total,
      totalPages: items.totalPages,
    },
  });
});

content.get('/:id', async (c) => {
  const user = currentUser(c);
  const { item, collection } = await loadItemWithCollection(c.env, user.id, c.req.param('id'));
  const [summary, transcript, tags] = await Promise.all([
    getSummary(c.env.DB, item.id),
    getTranscript(c.env.DB, item.id),
    getTagsForItem(c.env.DB, item.id),
  ]);
  return c.json({
    data: {
      item,
      collection: { id: collection.id, name: collection.name },
      summary,
      transcript,
      tags,
    },
  });
});

content.get('/:id/summary', async (c) => {
  const user = currentUser(c);
  const item = await getItem(c.env.DB, user.id, c.req.param('id'));
  const summary = await getSummary(c.env.DB, item.id);
  return c.json({ data: summary });
});

content.get('/:id/transcript', async (c) => {
  const user = currentUser(c);
  const item = await getItem(c.env.DB, user.id, c.req.param('id'));
  const transcript = await getTranscript(c.env.DB, item.id);
  return c.json({ data: transcript });
});

content.get('/:id/tags', async (c) => {
  const user = currentUser(c);
  const item = await getItem(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: await getTagsForItem(c.env.DB, item.id) });
});

export default content;
