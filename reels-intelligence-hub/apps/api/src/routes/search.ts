import { Hono } from 'hono';
import { searchSchema } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, queryObject } from '../middleware/validate.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { indexedCount, search, suggest } from '../services/search.js';

const searchRoutes = new Hono<AppEnv>();
searchRoutes.use('*', requireAuth);

searchRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const query = queryObject(c.req.url);
  const params = parse(searchSchema, query);

  const result = await search(c.env, c.env.DB, user.id, {
    q: params.q,
    mode: params.mode,
    sort: params.sort,
    page: params.page,
    pageSize: params.pageSize,
    ...(params.collectionId ? { collectionId: params.collectionId } : {}),
    ...(params.creator ? { creator: params.creator } : {}),
    ...(params.contentType ? { contentType: params.contentType } : {}),
    ...(params.tag ? { tag: params.tag } : {}),
    ...(params.status ? { status: params.status } : {}),
  });

  return c.json({
    data: result.data,
    meta: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
      semanticAvailable: result.semanticAvailable,
      mode: result.mode,
      notice: result.notice,
      indexedItems: await indexedCount(c.env.DB, user.id),
    },
  });
});

/** Alias kept so clients can be explicit about wanting vector search. */
searchRoutes.get('/semantic', async (c) => {
  const user = currentUser(c);
  const query = queryObject(c.req.url);
  const params = parse(searchSchema, { ...query, mode: 'semantic' });
  const result = await search(c.env, c.env.DB, user.id, {
    q: params.q,
    mode: 'semantic',
    sort: params.sort,
    page: params.page,
    pageSize: params.pageSize,
  });
  return c.json({
    data: result.data,
    meta: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
      semanticAvailable: result.semanticAvailable,
      mode: result.mode,
      notice: result.notice,
    },
  });
});

searchRoutes.get('/suggest', async (c) => {
  const user = currentUser(c);
  const prefix = new URL(c.req.url).searchParams.get('q') ?? '';
  if (prefix.trim().length < 2) return c.json({ data: [] });
  return c.json({ data: await suggest(c.env.DB, user.id, prefix.trim()) });
});

export default searchRoutes;
