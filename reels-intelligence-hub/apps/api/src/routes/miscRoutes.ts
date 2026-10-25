import { Hono } from 'hono';
import { AppError, ERROR_CODES, scheduleSchema } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, readJson } from '../middleware/validate.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { getCollection } from '../repositories/collections.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  markScheduleRun,
  setScheduleEnabled,
} from '../repositories/misc.js';
import {
  dashboardMetrics,
  recentCollections,
  recentItems,
  activeJobs,
} from '../services/dashboard.js';
import { listRecentEvents } from '../repositories/jobs.js';
import { listConversations } from '../repositories/chat.js';
import { listUsage, usageSummary } from '../repositories/misc.js';
import { deleteReport, generateReport, getReport, listReports } from '../services/reports.js';
import { startResearch } from '../services/research.js';
import { randomId } from '@rih/shared';

/**
 * Routes that are small enough to share a file: dashboard, usage, reports and
 * scheduled research. Each still owns its own Hono instance so the mount points
 * in index.ts stay explicit.
 */

/* --------------------------------------------------------------- dashboard */

export const dashboard = new Hono<AppEnv>();
dashboard.use('*', requireAuth);

dashboard.get('/', async (c) => {
  const user = currentUser(c);
  const [metrics, collections, jobs, items, events, conversations] = await Promise.all([
    dashboardMetrics(c.env.DB, user.id),
    recentCollections(c.env.DB, user.id, 6),
    activeJobs(c.env.DB, user.id, 5),
    recentItems(c.env.DB, user.id, 8),
    listRecentEvents(c.env.DB, user.id, 12),
    listConversations(c.env.DB, user.id, { limit: 5 }),
  ]);

  return c.json({
    data: { metrics, collections, jobs, items, events, conversations },
  });
});

/* ------------------------------------------------------------------- usage */

export const usage = new Hono<AppEnv>();
usage.use('*', requireAuth);

usage.get('/', async (c) => {
  const user = currentUser(c);
  const [summary, events] = await Promise.all([
    usageSummary(c.env.DB, user.id),
    listUsage(c.env.DB, user.id, 100),
  ]);
  return c.json({ data: { summary, events } });
});

usage.get('/summary', async (c) => {
  const user = currentUser(c);
  return c.json({ data: await usageSummary(c.env.DB, user.id) });
});

/* ----------------------------------------------------------------- reports */

export const reports = new Hono<AppEnv>();
reports.use('*', requireAuth);

reports.get('/', async (c) => {
  const user = currentUser(c);
  const collectionId = new URL(c.req.url).searchParams.get('collectionId') ?? undefined;
  return c.json({ data: await listReports(c.env.DB, user.id, collectionId) });
});

reports.post('/', async (c) => {
  const user = currentUser(c);
  const body = (await readJson(c.req.raw)) as {
    collectionId?: string;
    question?: string;
    title?: string;
  };
  if (!body.collectionId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Choose a collection to report on.');
  }
  const report = await generateReport(c.env, c.env.DB, user.id, {
    collectionId: body.collectionId,
    ...(body.question ? { question: body.question } : {}),
    ...(body.title ? { title: body.title } : {}),
  });
  return c.json({ data: report }, 201);
});

reports.get('/:id', async (c) => {
  const user = currentUser(c);
  return c.json({ data: await getReport(c.env.DB, user.id, c.req.param('id')) });
});

reports.delete('/:id', async (c) => {
  const user = currentUser(c);
  await deleteReport(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: { ok: true } });
});

/* --------------------------------------------------------------- schedules */

export const schedules = new Hono<AppEnv>();
schedules.use('*', requireAuth);

function nextRunFor(cadence: 'daily' | 'weekly' | 'custom', cron: string | null): string | null {
  const now = Date.now();
  if (cadence === 'daily') return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  if (cadence === 'weekly') return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  // Custom cron is validated by shape only; the platform cron trigger fires
  // daily and this field controls per-schedule eligibility.
  return cron ? new Date(now + 24 * 60 * 60 * 1000).toISOString() : null;
}

schedules.get('/', async (c) => {
  const user = currentUser(c);
  const list = await listSchedules(c.env.DB, user.id);
  return c.json({ data: list });
});

schedules.post('/', async (c) => {
  const user = currentUser(c);
  const body = parse(scheduleSchema, await readJson(c.req.raw));

  // Authorise the collection before scheduling against it.
  await getCollection(c.env.DB, user.id, body.collectionId);

  if (body.cadence === 'custom' && body.cron && !/^[\d*,/\-\s]+$/.test(body.cron)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'That cron expression contains unsupported characters.',
    );
  }

  await createSchedule(c.env.DB, {
    ownerId: user.id,
    collectionId: body.collectionId,
    cadence: body.cadence,
    cron: body.cron ?? null,
    maxItemsPerRun: body.maxItemsPerRun,
    autoProcess: body.autoProcess,
    notify: body.notify,
    enabled: body.enabled,
    nextRunAt: nextRunFor(body.cadence, body.cron ?? null),
  });

  return c.json({ data: await listSchedules(c.env.DB, user.id) }, 201);
});

schedules.patch('/:id', async (c) => {
  const user = currentUser(c);
  const body = (await readJson(c.req.raw)) as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Provide "enabled": true or false.');
  }
  await setScheduleEnabled(c.env.DB, user.id, c.req.param('id'), body.enabled);
  return c.json({ data: await listSchedules(c.env.DB, user.id) });
});

schedules.delete('/:id', async (c) => {
  const user = currentUser(c);
  await deleteSchedule(c.env.DB, user.id, c.req.param('id'));
  return c.json({ data: { ok: true } });
});

/** Run a schedule immediately, without waiting for the cron trigger. */
schedules.post('/:id/run', async (c) => {
  const user = currentUser(c);
  const list = await listSchedules(c.env.DB, user.id);
  const schedule = list.find((entry) => entry.id === c.req.param('id'));
  if (!schedule) throw new AppError(ERROR_CODES.NOT_FOUND, 'That schedule does not exist.');

  const collection = await getCollection(c.env.DB, user.id, schedule.collectionId);
  const result = await startResearch(c.env, c.env.DB, user.id, {
    kind: 'scheduled_refresh',
    collectionId: collection.id,
    source: collection.sourceIdentifier?.replace(/^instagram:profile:/, '') ?? '',
    options: { maxItems: schedule.maxItemsPerRun },
  });

  await markScheduleRun(
    c.env.DB,
    schedule.id,
    nextRunFor(schedule.cadence, schedule.cron),
    'triggered',
  );
  void randomId;
  return c.json({ data: { ok: true, job: result.job, discovered: result.discovered } });
});
