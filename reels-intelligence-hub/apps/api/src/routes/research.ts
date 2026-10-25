import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  describeUnsupportedSource,
  designResearchSchema,
  parseInstagramSource,
  profileResearchSchema,
  topicResearchSchema,
} from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, readJson } from '../middleware/validate.js';
import { currentUser, enforceRateLimit, requireAuth } from '../middleware/auth.js';
import { researchReadiness, startResearch, type ResearchKind } from '../services/research.js';
import { getSettings } from '../repositories/misc.js';
import { getJob } from '../repositories/jobs.js';
import { getCollection } from '../repositories/collections.js';

const research = new Hono<AppEnv>();
research.use('*', requireAuth);

/**
 * Validate a source *before* creating anything, so the user gets a precise
 * explanation rather than an empty collection plus a failed job.
 */
research.post('/validate-source', async (c) => {
  const body = (await readJson(c.req.raw)) as { source?: string };
  const source = typeof body.source === 'string' ? body.source : '';
  const parsed = parseInstagramSource(source);

  if (!parsed) {
    return c.json({
      data: {
        valid: false,
        kind: null,
        canonicalUrl: null,
        username: null,
        message: describeUnsupportedSource(source),
      },
    });
  }

  return c.json({
    data: {
      valid: true,
      kind: parsed.kind,
      canonicalUrl: parsed.canonicalUrl,
      username: parsed.username || null,
      sourceIdentifier: parsed.sourceIdentifier,
      message:
        parsed.kind === 'profile'
          ? `Will research @${parsed.username}. Only media this app is authorised to read will be collected.`
          : `Will research the single ${parsed.kind} at ${parsed.canonicalUrl}.`,
    },
  });
});

research.get('/readiness', async (c) => {
  const user = currentUser(c);
  const settings = await getSettings(c.env.DB, user.id);
  const readiness = await researchReadiness(c.env, c.env.DB, user.id, settings);
  return c.json({ data: readiness });
});

async function runResearch(
  c: Context<AppEnv>,
  kind: ResearchKind,
  body: {
    source?: string;
    query?: string;
    collectionName?: string;
    collectionId?: string;
    options?: Record<string, unknown>;
    useDemoData?: boolean;
    accountId?: string;
  },
) {
  const user = currentUser(c);
  await enforceRateLimit(c.env, user.id, 'research-start', 20);

  const result = await startResearch(c.env, c.env.DB, user.id, {
    kind,
    ...(body.source === undefined ? {} : { source: body.source }),
    ...(body.query === undefined ? {} : { query: body.query }),
    ...(body.collectionName === undefined ? {} : { collectionName: body.collectionName }),
    ...(body.collectionId === undefined ? {} : { collectionId: body.collectionId }),
    ...(body.accountId === undefined ? {} : { accountId: body.accountId }),
    ...(body.useDemoData === undefined ? {} : { useDemoData: body.useDemoData }),
    options: body.options as never,
  });

  return c.json({ data: result }, 201);
}

research.post('/profiles', async (c) => {
  const body = parse(profileResearchSchema, await readJson(c.req.raw));
  return runResearch(c, 'profile_reels', body as never);
});

research.post('/designs', async (c) => {
  const body = parse(designResearchSchema, await readJson(c.req.raw));
  return runResearch(c, 'design_documents', body as never);
});

research.post('/topics', async (c) => {
  const body = parse(topicResearchSchema, await readJson(c.req.raw));
  return runResearch(c, 'topic_research', body as never);
});

research.get('/:jobId/status', async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.env.DB, user.id, c.req.param('jobId'));
  const collection = await getCollection(c.env.DB, user.id, job.collectionId);

  return c.json({
    data: {
      job,
      collection: { id: collection.id, name: collection.name, status: collection.status },
      progressPercent: Math.round(job.progress * 100),
    },
  });
});

research.get('/providers', (c) => {
  return c.json({
    data: [
      {
        slug: 'instagram',
        label: 'Instagram Graph API',
        available: Boolean(c.env.INSTAGRAM_APP_ID && c.env.INSTAGRAM_APP_SECRET),
        supports: [
          'profile media (authorised accounts)',
          'public Business/Creator media via Business Discovery',
        ],
        doesNotSupport: ['arbitrary personal accounts', 'private accounts', 'keyword search'],
      },
      {
        slug: 'demo',
        label: 'Demo data (synthetic)',
        available: c.env.ENABLE_DEMO_MODE === 'true',
        supports: ['interface and pipeline evaluation'],
        doesNotSupport: ['real Instagram content'],
      },
    ],
  });
});

export default research;
