import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { AppError, ERROR_CODES } from '@rih/shared';
import type { AppEnv, Env, PipelineMessage } from './env.js';
import { allowedOrigins, describeConfig } from './env.js';
import { requestContext, requestIdOf, toErrorResponse } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import collectionRoutes from './routes/collections.js';
import researchRoutes from './routes/research.js';
import contentRoutes from './routes/content.js';
import jobRoutes from './routes/jobs.js';
import searchRoutes from './routes/search.js';
import chatRoutes from './routes/chat.js';
import settingsRoutes from './routes/settings.js';
import integrationRoutes from './routes/integrations.js';
import { dashboard, reports, schedules, usage } from './routes/miscRoutes.js';
import { processItem, sweepRetries } from './services/pipeline.js';
import { listDueSchedules, markScheduleRun } from './repositories/misc.js';
import { getCollection } from './repositories/collections.js';
import { startResearch } from './services/research.js';

/**
 * Worker entry point.
 *
 * Three exports, three responsibilities:
 *   fetch     — the HTTP API (Hono) plus static asset passthrough
 *   queue     — the content processing pipeline consumer
 *   scheduled — the daily cron that kicks off scheduled research and retries
 */

const app = new Hono<AppEnv>();

app.use('*', requestContext);

// Structured request logging. The Hono logger is fine for dev, but we emit JSON
// so Cloudflare's log push can index it. Secrets never reach this line because
// nothing logs headers.
app.use('*', logger());

app.use('*', async (c, next) => {
  const origins = allowedOrigins(c.env);
  const middleware = cors({
    origin: (origin) =>
      origins.includes(origin) || origins.includes('*') ? origin : (origins[0] ?? ''),
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization', 'x-request-id'],
    exposeHeaders: ['x-request-id'],
    credentials: true,
    maxAge: 600,
  });
  return middleware(c, next);
});

app.get('/api/v1/health', (c) => {
  const config = describeConfig(c.env);
  const healthy = config.bindings.db && config.authSecret && config.encryptionKey;
  return c.json(
    {
      data: {
        status: healthy ? 'ok' : 'degraded',
        environment: c.env.ENVIRONMENT,
        time: new Date().toISOString(),
        // Names only — never values.
        missing: [
          ...(config.authSecret ? [] : ['AUTH_SECRET']),
          ...(config.encryptionKey ? [] : ['SECRETS_ENCRYPTION_KEY']),
        ],
      },
    },
    healthy ? 200 : 503,
  );
});

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/collections', collectionRoutes);
app.route('/api/v1/research', researchRoutes);
app.route('/api/v1/content', contentRoutes);
app.route('/api/v1/jobs', jobRoutes);
app.route('/api/v1/search', searchRoutes);
app.route('/api/v1/chat', chatRoutes);
app.route('/api/v1/settings', settingsRoutes);
app.route('/api/v1/integrations', integrationRoutes);
app.route('/api/v1/dashboard', dashboard);
app.route('/api/v1/usage', usage);
app.route('/api/v1/reports', reports);
app.route('/api/v1/schedules', schedules);

/**
 * Frontend delivery.
 *
 * The built SPA is uploaded alongside the Worker (`[assets]` in wrangler.toml),
 * so the app and the API share an origin. Cloudflare serves any request that
 * matches a real file before this Worker runs; everything else — client-side
 * routes like `/collections/abc`, and `/api/*` — arrives here.
 *
 * Three cases, in order:
 *   1. `/api/*` that reached this point has no route → JSON 404, never HTML.
 *   2. A request that maps to a real file → serve it (with its own headers).
 *   3. A navigation request with no matching file → `index.html`, so React
 *      Router can resolve the route client-side.
 */
app.get('*', async (c) => {
  const url = new URL(c.req.url);

  if (url.pathname.startsWith('/api/')) {
    return c.json(
      {
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: `No route matches ${c.req.method} ${url.pathname}.`,
          retryable: false,
          requestId: requestIdOf(c),
        },
      },
      404,
    );
  }

  if (!c.env.ASSETS) {
    // `wrangler dev` without a web build, or a deploy that skipped build:web.
    return c.json(
      {
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message:
            'The frontend has not been built into this Worker. Run `npm run build:web` and redeploy, or use `npm run dev` for the Vite dev server.',
          retryable: false,
          requestId: requestIdOf(c),
        },
      },
      503,
    );
  }

  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) return asset;

  const acceptsHtml = (c.req.header('accept') ?? '').includes('text/html');
  if (acceptsHtml) {
    return c.env.ASSETS.fetch(new URL('/index.html', url).toString());
  }

  return c.json(
    {
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: `No file or route matches ${url.pathname}.`,
        retryable: false,
        requestId: requestIdOf(c),
      },
    },
    404,
  );
});

app.notFound((c) => {
  const requestId = requestIdOf(c);
  return c.json(
    {
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: `No route matches ${c.req.method} ${new URL(c.req.url).pathname}.`,
        retryable: false,
        requestId,
      },
    },
    404,
  );
});

app.onError((error, c) => {
  const { body, status } = toErrorResponse(error, requestIdOf(c));
  return c.json(body, status as 400);
});

/* ------------------------------------------------------------------ queue -- */

async function handleQueue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      switch (message.body.type) {
        case 'process_item': {
          const outcome = await processItem(env, message.body);
          if (outcome.status === 'retry') {
            // Let the queue redeliver; the pipeline has already recorded the
            // attempt and scheduled the database-side retry time.
            message.retry({ delaySeconds: 30 });
          } else {
            message.ack();
          }
          break;
        }
        case 'refresh_schedule': {
          await sweepRetries(env);
          message.ack();
          break;
        }
        default:
          message.ack();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'queue',
          jobId: message.body.jobId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      // Bounded retries: Cloudflare's max_retries (3) plus a DLQ configured in
      // wrangler.toml means a poison message cannot loop forever.
      message.retry({ delaySeconds: 60 });
    }
  }
}

/* -------------------------------------------------------------- scheduled -- */

async function handleScheduled(env: Env): Promise<void> {
  // 1. Re-queue any retries whose backoff window has opened.
  const retried = await sweepRetries(env);
  if (retried > 0) {
    console.log(JSON.stringify({ level: 'info', scope: 'cron', retried }));
  }

  // 2. Kick off due scheduled research. Each schedule is processed
  //    independently so one failure cannot block the rest.
  const due = await listDueSchedules(env.DB, 20);
  for (const schedule of due) {
    try {
      const collection = await getCollection(env.DB, schedule.ownerId, schedule.collectionId);
      const username = collection.sourceIdentifier?.replace(/^instagram:profile:/, '') ?? '';

      if (!username) {
        await markScheduleRun(env.DB, schedule.id, null, 'skipped:no_source');
        continue;
      }

      await startResearch(env, env.DB, schedule.ownerId, {
        kind: 'scheduled_refresh',
        collectionId: collection.id,
        source: username,
        options: { maxItems: schedule.maxItemsPerRun },
      });

      const next =
        schedule.cadence === 'daily'
          ? new Date(Date.now() + 86_400_000).toISOString()
          : new Date(Date.now() + 7 * 86_400_000).toISOString();
      await markScheduleRun(env.DB, schedule.id, next, 'completed');
    } catch (error) {
      await markScheduleRun(
        env.DB,
        schedule.id,
        new Date(Date.now() + 86_400_000).toISOString(),
        `failed:${error instanceof AppError ? error.code : 'error'}`,
      );
    }
  }
}

// Exported for tests: the SPA/API routing split is deploy-critical and is
// exercised directly with a fake `ASSETS` binding in apps/api/tests/spa.test.ts.
export { app };

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
