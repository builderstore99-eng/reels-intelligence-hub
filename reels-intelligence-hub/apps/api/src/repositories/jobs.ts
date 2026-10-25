import {
  AppError,
  ERROR_CODES,
  randomId,
  type JobEvent,
  type JobItem,
  type JobStatus,
  type JobType,
  type Paginated,
  type PipelineStage,
  type ResearchJob,
} from '@rih/shared';
import { all, first, nowIso, run } from '../db/client.js';
import { toJobEvent, toJobItem, toResearchJob } from '../db/mappers.js';

/**
 * Research jobs repository.
 *
 * Job state lives entirely in D1 — never in Worker memory — so a restart,
 * redeploy, or eviction mid-run cannot lose progress. `progress` is derived
 * from the item counters every time they change, which keeps the dashboard and
 * the live monitor agreeing with the queue.
 */

export async function createJob(
  db: D1Database,
  input: {
    ownerId: string;
    collectionId: string;
    jobType: JobType;
    configuration: Record<string, unknown>;
  },
): Promise<ResearchJob> {
  const id = randomId();
  const now = nowIso();
  await run(
    db,
    `INSERT INTO research_jobs
       (id, owner_id, collection_id, job_type, status, total_items, completed_items,
        failed_items, skipped_items, progress, configuration_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, 0, 0, ?, ?, ?)`,
    [
      id,
      input.ownerId,
      input.collectionId,
      input.jobType,
      JSON.stringify(input.configuration),
      now,
      now,
    ],
  );
  return getJob(db, input.ownerId, id);
}

export async function getJob(db: D1Database, ownerId: string, jobId: string): Promise<ResearchJob> {
  const row = await first<Record<string, unknown>>(
    db,
    'SELECT * FROM research_jobs WHERE id = ? AND owner_id = ?',
    [jobId, ownerId],
  );
  if (!row) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      'That job does not exist, or you do not have access to it.',
    );
  }
  return toResearchJob(row);
}

/** Internal variant used by the queue consumer, which has no request user. */
export async function getJobUnscoped(db: D1Database, jobId: string): Promise<ResearchJob | null> {
  const row = await first<Record<string, unknown>>(db, 'SELECT * FROM research_jobs WHERE id = ?', [
    jobId,
  ]);
  return row ? toResearchJob(row) : null;
}

export async function listJobs(
  db: D1Database,
  ownerId: string,
  options: { status?: string; collectionId?: string; page: number; pageSize: number },
): Promise<Paginated<ResearchJob>> {
  const where = ['owner_id = ?'];
  const params: (string | number)[] = [ownerId];

  if (options.status && options.status !== 'all') {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.collectionId) {
    where.push('collection_id = ?');
    params.push(options.collectionId);
  }

  const whereSql = where.join(' AND ');
  const totalRow = await first<{ total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM research_jobs WHERE ${whereSql}`,
    params,
  );

  const offset = (options.page - 1) * options.pageSize;
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT * FROM research_jobs WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, options.pageSize, offset],
  );

  const total = totalRow?.total ?? 0;
  return {
    data: rows.map(toResearchJob),
    page: options.page,
    pageSize: options.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / options.pageSize)),
  };
}

/** The active (queued/running/paused) job for a collection, if any. */
export async function findActiveJob(
  db: D1Database,
  collectionId: string,
  jobType?: JobType,
): Promise<ResearchJob | null> {
  const row = await first<Record<string, unknown>>(
    db,
    `SELECT * FROM research_jobs
      WHERE collection_id = ?
        AND status IN ('queued', 'running', 'paused')
        ${jobType ? 'AND job_type = ?' : ''}
      ORDER BY created_at DESC LIMIT 1`,
    jobType ? [collectionId, jobType] : [collectionId],
  );
  return row ? toResearchJob(row) : null;
}

export async function setJobStatus(
  db: D1Database,
  jobId: string,
  status: JobStatus,
  extra?: { errorSummary?: string | null },
): Promise<void> {
  const now = nowIso();
  const sets = ['status = ?', 'updated_at = ?'];
  const params: (string | number | null)[] = [status, now];

  if (status === 'running') {
    sets.push('started_at = COALESCE(started_at, ?)');
    params.push(now);
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    sets.push('completed_at = ?');
    params.push(now);
  }
  if (extra?.errorSummary !== undefined) {
    sets.push('error_summary = ?');
    params.push(extra.errorSummary);
  }

  params.push(jobId);
  await run(db, `UPDATE research_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
}

/**
 * Recompute counters and progress from job_items.
 *
 * Deriving rather than incrementing means a double-delivered queue message or
 * a retry cannot inflate the counters.
 */
export async function recalcJobProgress(
  db: D1Database,
  jobId: string,
): Promise<ResearchJob | null> {
  const counts = await first<{
    total: number;
    completed: number;
    failed: number;
    skipped: number;
  }>(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
     FROM job_items WHERE job_id = ?`,
    [jobId],
  );

  const total = counts?.total ?? 0;
  const completed = counts?.completed ?? 0;
  const failed = counts?.failed ?? 0;
  const skipped = counts?.skipped ?? 0;
  const settled = completed + failed + skipped;
  const progress = total === 0 ? 0 : Math.min(1, settled / total);

  await run(
    db,
    `UPDATE research_jobs
        SET total_items = ?, completed_items = ?, failed_items = ?, skipped_items = ?,
            progress = ?, updated_at = ?
      WHERE id = ?`,
    [total, completed, failed, skipped, progress, nowIso(), jobId],
  );

  const job = await getJobUnscoped(db, jobId);

  // Auto-complete once nothing is left in flight.
  if (job && job.status === 'running' && total > 0 && settled === total) {
    const finalStatus: JobStatus = failed > 0 && completed === 0 ? 'failed' : 'completed';
    await setJobStatus(db, jobId, finalStatus);
    return getJobUnscoped(db, jobId);
  }

  return job;
}

export async function addJobItem(
  db: D1Database,
  input: { jobId: string; contentItemId: string | null; stage?: PipelineStage },
): Promise<string> {
  const id = randomId();
  await run(
    db,
    `INSERT INTO job_items (id, job_id, content_item_id, stage, status, attempts)
     VALUES (?, ?, ?, ?, 'pending', 0)`,
    [id, input.jobId, input.contentItemId, input.stage ?? 'discovery'],
  );
  return id;
}

export async function getJobItem(db: D1Database, jobItemId: string): Promise<JobItem | null> {
  const row = await first<Record<string, unknown>>(db, 'SELECT * FROM job_items WHERE id = ?', [
    jobItemId,
  ]);
  return row ? toJobItem(row) : null;
}

export async function listJobItems(db: D1Database, jobId: string, limit = 200): Promise<JobItem[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    'SELECT * FROM job_items WHERE job_id = ? ORDER BY rowid LIMIT ?',
    [jobId, limit],
  );
  return rows.map(toJobItem);
}

export async function updateJobItem(
  db: D1Database,
  jobItemId: string,
  patch: {
    stage?: PipelineStage;
    status?: JobItem['status'];
    attempts?: number;
    nextRetryAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  const map: Record<string, string> = {
    stage: 'stage',
    status: 'status',
    attempts: 'attempts',
    nextRetryAt: 'next_retry_at',
    errorCode: 'error_code',
    errorMessage: 'error_message',
    startedAt: 'started_at',
    completedAt: 'completed_at',
  };

  for (const [key, column] of Object.entries(map)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      params.push(value as string | number | null);
    }
  }

  if (sets.length === 0) return;
  params.push(jobItemId);
  await run(db, `UPDATE job_items SET ${sets.join(', ')} WHERE id = ?`, params);
}

/** Items whose retry window has opened. Used by the queue consumer's sweep. */
export async function listDueRetries(db: D1Database, limit = 25): Promise<JobItem[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT * FROM job_items
      WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
      ORDER BY next_retry_at LIMIT ?`,
    [nowIso(), limit],
  );
  return rows.map(toJobItem);
}

/* ---------------------------------------------------------------- events -- */

export async function recordEvent(
  db: D1Database,
  input: {
    jobId: string;
    eventType: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO job_events (id, job_id, event_type, message, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      input.jobId,
      input.eventType,
      input.message,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    ],
  );
}

export async function listEvents(db: D1Database, jobId: string, limit = 100): Promise<JobEvent[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    'SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?',
    [jobId, limit],
  );
  return rows.map(toJobEvent);
}

export async function listRecentEvents(
  db: D1Database,
  ownerId: string,
  limit = 40,
): Promise<Array<JobEvent & { collectionName: string | null }>> {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT e.*, c.name AS collection_name
       FROM job_events e
       JOIN research_jobs j ON j.id = e.job_id
       LEFT JOIN collections c ON c.id = j.collection_id
      WHERE j.owner_id = ?
      ORDER BY e.created_at DESC LIMIT ?`,
    [ownerId, limit],
  );
  return rows.map((row) => ({
    ...toJobEvent(row),
    collectionName: typeof row['collection_name'] === 'string' ? row['collection_name'] : null,
  }));
}
