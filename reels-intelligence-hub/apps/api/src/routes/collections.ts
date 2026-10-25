import { Hono } from 'hono';
import { createCollectionSchema, paginationSchema, updateCollectionSchema } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, queryObject, readJson } from '../middleware/validate.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  createCollection,
  deleteCollection,
  duplicateCollection,
  getCollection,
  listCollections,
  removeItemFromCollection,
  updateCollection,
} from '../repositories/collections.js';
import { getSummary, getTagsForItem, listItems } from '../repositories/content.js';
import { listReports } from '../services/reports.js';

const collections = new Hono<AppEnv>();
collections.use('*', requireAuth);

collections.get('/', async (c) => {
  const user = currentUser(c);
  const query = queryObject(c.req.url);
  const page = parse(paginationSchema, query);

  const result = await listCollections(c.env.DB, user.id, {
    status: query['status'],
    type: query['type'],
    search: query['search'],
    page: page.page,
    pageSize: page.pageSize,
  });
  return c.json({
    data: result.data,
    meta: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
});

collections.post('/', async (c) => {
  const user = currentUser(c);
  const body = parse(createCollectionSchema, await readJson(c.req.raw));
  const collection = await createCollection(c.env.DB, user.id, {
    name: body.name,
    description: body.description ?? null,
    collectionType: body.collectionType,
    sourceIdentifier: body.sourceIdentifier ?? null,
    settings: body.settings,
  });
  return c.json({ data: collection }, 201);
});

collections.get('/:id', async (c) => {
  const user = currentUser(c);
  const collection = await getCollection(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: collection });
});

collections.patch('/:id', async (c) => {
  const user = currentUser(c);
  const body = parse(updateCollectionSchema, await readJson(c.req.raw));
  const collection = await updateCollection(c.env.DB, user.id, c.req.param('id'), {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.settings === undefined ? {} : { settings: body.settings }),
  });
  return c.json({ data: collection });
});

collections.delete('/:id', async (c) => {
  const user = currentUser(c);
  await deleteCollection(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: { ok: true } });
});

collections.post('/:id/duplicate', async (c) => {
  const user = currentUser(c);
  const copy = await duplicateCollection(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: copy }, 201);
});

collections.get('/:id/items', async (c) => {
  const user = currentUser(c);
  const collectionId = c.req.param('id');
  // Authorise before listing: getCollection throws NOT_FOUND for another user's id.
  await getCollection(c.env.DB, user.id, collectionId);

  const query = queryObject(c.req.url);
  const page = parse(paginationSchema, query);
  const items = await listItems(c.env.DB, user.id, {
    collectionId,
    creator: query['creator'],
    contentType: query['contentType'] as never,
    status: query['status'] as never,
    tag: query['tag'],
    sort: (query['sort'] as never) ?? 'recent',
    page: page.page,
    pageSize: page.pageSize,
  });

  const summaries = await Promise.all(
    items.data.map(async (item) => ({
      contentItemId: item.id,
      summary: await getSummary(c.env.DB, item.id),
      tags: await getTagsForItem(c.env.DB, item.id),
    })),
  );
  const byItem = new Map(summaries.map((entry) => [entry.contentItemId, entry]));

  return c.json({
    data: items.data.map((item) => ({
      ...item,
      summary: byItem.get(item.id)?.summary ?? null,
      tags: byItem.get(item.id)?.tags ?? [],
    })),
    meta: {
      page: items.page,
      pageSize: items.pageSize,
      total: items.total,
      totalPages: items.totalPages,
    },
  });
});

collections.delete('/:id/items/:itemId', async (c) => {
  const user = currentUser(c);
  await removeItemFromCollection(c.env.DB, user.id, c.req.param('id'), c.req.param('itemId'));
  return c.json({ data: { ok: true } });
});

collections.get('/:id/reports', async (c) => {
  const user = currentUser(c);
  await getCollection(c.env.DB, user.id, c.req.param('id'));
  const reports = await listReports(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: reports });
});

export default collections;
