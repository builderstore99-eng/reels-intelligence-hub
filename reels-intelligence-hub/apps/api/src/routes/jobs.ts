import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError, ERROR_CODES, nextRetryAt, paginationSchema, type JobStatus } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { parse, queryObject } from '../middleware/validate.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  getJob,
  listEvents,
  listJobItems,
  listJobs,
  recordEvent,
  setJobStatus,
  updateJobItem,
} from '../repositories/jobs.js';
import { liveMonitor } from '../services/dashboard.js';
import { getSettings } from '../repositories/misc.js';
import { touchCollection } from '../repositories/collections.js';

const jobs = new Hono<AppEnv>();
jobs.use('*', requireAuth);

jobs.get('/', async (c) => {
  const user = currentUser(c);
  const query = queryObject(c.req.url);
  const page = parse(paginationSchema, query);
  const result = await listJobs(c.env.DB, user.id, {
    status: query['status'],
    collectionId: query['collectionId'],
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

jobs.get('/monitor', async (c) => {
  const user = currentUser(c);
  return c.json({ data: await liveMonitor(c.env.DB, user.id) });
});

jobs.get('/:id', async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.env.DB, user.id, c.req.param('id') ?? '');
  const [items, events] = await Promise.all([
    listJobItems(c.env.DB, job.id),
    listEvents(c.env.DB, job.id, 60),
  ]);
  return c.json({ data: { job, items, events } });
});

/**
 * Job controls.
 *
 * All four transitions validate the current state first: pausing a completed
 * job, resuming a cancelled one, or retrying a job that is still running are
 * rejected with an explanation instead of being silently ignored.
 */
async function transition(c: Context<AppEnv>, to: JobStatus): Promise<Response> {
  const user = currentUser(c);
  const job = await getJob(c.env.DB, user.id, c.req.param('id') ?? '');

  const allowed: Record<string, JobStatus[]> = {
    pause: ['queued', 'running'],
    resume: ['paused'],
    cancel: ['queued', 'running', 'paused'],
    retry: ['failed'],
  };

  const from = c.req.path.endsWith('/pause')
    ? 'pause'
    : c.req.path.endsWith('/resume')
      ? 'resume'
      : c.req.path.endsWith('/cancel')
        ? 'cancel'
        : 'retry';

  if (!(allowed[from] ?? []).includes(job.status)) {
    throw new AppError(
      ERROR_CODES.INVALID_STATE,
      `A job that is "${job.status}" cannot be ${from === 'retry' ? 'retried' : `${from}d`}.`,
    );
  }

  if (from === 'retry') {
    // Re-arm every failed item that has retries left, then reopen the job.
    const settings = await getSettings(c.env.DB, user.id);
    const items = await listJobItems(c.env.DB, job.id);
    let rearmed = 0;
    for (const item of items) {
      if (item.status !== 'failed') continue;
      if (item.attempts >= settings.processing.retryMaxAttempts) {
        await updateJobItem(c.env.DB, item.id, { attempts: 0 });
      }
      await updateJobItem(c.env.DB, item.id, {
        status: 'pending',
        nextRetryAt: nextRetryAt(1, true, {
          maxAttempts: settings.processing.retryMaxAttempts,
          baseDelayMs: settings.processing.retryBaseDelayMs,
          maxDelayMs: 10 * 60 * 1000,
          factor: 2,
        }),
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      });
      rearmed += 1;
    }
    if (rearmed === 0) {
      throw new AppError(
        ERROR_CODES.INVALID_STATE,
        'There are no failed items to retry on this job.',
      );
    }
    await setJobStatus(c.env.DB, job.id, 'running', { errorSummary: null });
    await recordEvent(c.env.DB, {
      jobId: job.id,
      eventType: 'retry_scheduled',
      message: `Re-armed ${rearmed} failed item${rearmed === 1 ? '' : 's'} for retry.`,
    });
  } else {
    await setJobStatus(c.env.DB, job.id, to);
    await recordEvent(c.env.DB, {
      jobId: job.id,
      eventType: `job_${to}`,
      message: `Job ${to}d by the user.`,
    });
    await touchCollection(c.env.DB, job.collectionId, to === 'paused' ? 'paused' : undefined);
  }

  return c.json({ data: await getJob(c.env.DB, user.id, job.id) });
}

jobs.post('/:id/pause', (c) => transition(c, 'paused'));
jobs.post('/:id/resume', (c) => transition(c, 'running'));
jobs.post('/:id/cancel', (c) => transition(c, 'cancelled'));
jobs.post('/:id/retry', (c) => transition(c, 'running'));

jobs.get('/:id/events', async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.env.DB, user.id, c.req.param('id') ?? '');
  return c.json({ data: await listEvents(c.env.DB, job.id, 200) });
});

export default jobs;
