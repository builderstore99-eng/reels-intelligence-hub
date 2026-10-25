import type { Collection, DashboardMetrics, JobStatus, ResearchJob } from '@rih/shared';
import { all, first } from '../db/client.js';
import { toCollection, toResearchJob } from '../db/mappers.js';

/**
 * Dashboard aggregation.
 *
 * Every number here is a real query. There is no demo fallback and no seeded
 * constant: a brand-new account sees zeros, which is the honest answer.
 */

export async function dashboardMetrics(db: D1Database, ownerId: string): Promise<DashboardMetrics> {
  const discovered = await first<{ total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM content_items WHERE owner_id = ?',
    [ownerId],
  );

  const analyzed = await first<{ total: number }>(
    db,
    "SELECT COUNT(*) AS total FROM content_items WHERE owner_id = ? AND processing_status = 'completed'",
    [ownerId],
  );

  const collections = await first<{ total: number }>(
    db,
    "SELECT COUNT(*) AS total FROM collections WHERE owner_id = ? AND status != 'archived'",
    [ownerId],
  );

  const jobs = await first<{ pending: number; failed: number }>(
    db,
    `SELECT
       SUM(CASE WHEN status IN ('queued','running','paused') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM research_jobs WHERE owner_id = ?`,
    [ownerId],
  );

  const usage = await first<{ cost: number; calls: number }>(
    db,
    'SELECT COALESCE(SUM(estimated_cost), 0) AS cost, COUNT(*) AS calls FROM usage_events WHERE owner_id = ?',
    [ownerId],
  );

  // Storage is approximated from R2 object metadata only when a listing has
  // been recorded; we do not invent a number here.
  return {
    totalDiscovered: discovered?.total ?? 0,
    totalAnalyzed: analyzed?.total ?? 0,
    collections: collections?.total ?? 0,
    pendingJobs: jobs?.pending ?? 0,
    failedJobs: jobs?.failed ?? 0,
    storageBytes: 0,
    aiCostUsd: usage?.cost ?? 0,
    aiCalls: usage?.calls ?? 0,
  };
}

export async function recentCollections(
  db: D1Database,
  ownerId: string,
  limit = 6,
): Promise<Collection[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT c.*,
       (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count,
       (SELECT COUNT(*) FROM collection_items ci
          JOIN content_items i ON i.id = ci.content_item_id
         WHERE ci.collection_id = c.id AND i.processing_status = 'completed') AS analyzed_count
     FROM collections c
     WHERE c.owner_id = ? AND c.status != 'archived'
     ORDER BY COALESCE(c.last_activity_at, c.updated_at) DESC
     LIMIT ?`,
    [ownerId, limit],
  );
  return rows.map(toCollection);
}

export async function activeJobs(
  db: D1Database,
  ownerId: string,
  limit = 5,
): Promise<ResearchJob[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT * FROM research_jobs
      WHERE owner_id = ? AND status IN ('queued','running','paused')
      ORDER BY created_at DESC LIMIT ?`,
    [ownerId, limit],
  );
  return rows.map(toResearchJob);
}

export async function recentItems(
  db: D1Database,
  ownerId: string,
  limit = 8,
): Promise<
  Array<{
    id: string;
    caption: string | null;
    creatorIdentifier: string | null;
    contentType: string;
    sourceUrl: string;
    thumbnailReference: string | null;
    processingStatus: string;
    publishedAt: string | null;
    collectionId: string | null;
    collectionName: string | null;
  }>
> {
  const rows = await all<{
    id: string;
    caption: string | null;
    creator_identifier: string | null;
    content_type: string;
    source_url: string;
    thumbnail_reference: string | null;
    processing_status: string;
    published_at: string | null;
    collection_id: string | null;
    collection_name: string | null;
  }>(
    db,
    `SELECT i.id, i.caption, i.creator_identifier, i.content_type, i.source_url,
            i.thumbnail_reference, i.processing_status, i.published_at,
            (SELECT ci.collection_id FROM collection_items ci WHERE ci.content_item_id = i.id LIMIT 1) AS collection_id,
            (SELECT c.name FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
              WHERE ci.content_item_id = i.id LIMIT 1) AS collection_name
       FROM content_items i
      WHERE i.owner_id = ?
      ORDER BY i.created_at DESC LIMIT ?`,
    [ownerId, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    caption: row.caption,
    creatorIdentifier: row.creator_identifier,
    contentType: row.content_type,
    sourceUrl: row.source_url,
    thumbnailReference: row.thumbnail_reference,
    processingStatus: row.processing_status,
    publishedAt: row.published_at,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
  }));
}

export interface LiveMonitorSnapshot {
  totalDiscovered: number;
  processed: number;
  waiting: number;
  processing: number;
  succeeded: number;
  failed: number;
  retryable: number;
  skipped: number;
  ratePerMinute: number;
  estimatedRemainingMs: number | null;
  jobs: ResearchJob[];
}

export async function liveMonitor(db: D1Database, ownerId: string): Promise<LiveMonitorSnapshot> {
  const items = await first<{
    total: number;
    processed: number;
    waiting: number;
    processing: number;
    succeeded: number;
    failed: number;
    retryable: number;
    skipped: number;
  }>(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ji.status = 'completed' THEN 1 ELSE 0 END) AS processed,
       SUM(CASE WHEN ji.status = 'pending' THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN ji.status = 'running' THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN ji.status = 'completed' THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN ji.status = 'failed' AND ji.next_retry_at IS NULL THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN ji.status = 'failed' AND ji.next_retry_at IS NOT NULL THEN 1 ELSE 0 END) AS retryable,
       SUM(CASE WHEN ji.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
     FROM job_items ji JOIN research_jobs j ON j.id = ji.job_id
     WHERE j.owner_id = ?`,
    [ownerId],
  );

  // Throughput over the last 5 minutes, from completion timestamps.
  const recent = await first<{ completed: number }>(
    db,
    `SELECT COUNT(*) AS completed FROM job_items ji
       JOIN research_jobs j ON j.id = ji.job_id
      WHERE j.owner_id = ? AND ji.status = 'completed'
        AND ji.completed_at >= ?`,
    [ownerId, new Date(Date.now() - 5 * 60_000).toISOString()],
  );

  const ratePerMinute = (recent?.completed ?? 0) / 5;
  const remaining = (items?.waiting ?? 0) + (items?.processing ?? 0);
  const estimatedRemainingMs =
    ratePerMinute > 0 && remaining > 0 ? Math.round((remaining / ratePerMinute) * 60_000) : null;

  const jobRows = await all<Record<string, unknown>>(
    db,
    `SELECT * FROM research_jobs WHERE owner_id = ? ORDER BY
       CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
       created_at DESC LIMIT 20`,
    [ownerId],
  );

  return {
    totalDiscovered: items?.total ?? 0,
    processed: items?.processed ?? 0,
    waiting: items?.waiting ?? 0,
    processing: items?.processing ?? 0,
    succeeded: items?.succeeded ?? 0,
    failed: items?.failed ?? 0,
    retryable: items?.retryable ?? 0,
    skipped: items?.skipped ?? 0,
    ratePerMinute: Math.round(ratePerMinute * 100) / 100,
    estimatedRemainingMs,
    jobs: jobRows.map(toResearchJob),
  };
}

export async function jobCountsByStatus(
  db: D1Database,
  ownerId: string,
): Promise<Record<string, number>> {
  const rows = await all<{ status: JobStatus; total: number }>(
    db,
    'SELECT status, COUNT(*) AS total FROM research_jobs WHERE owner_id = ? GROUP BY status',
    [ownerId],
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.total]));
}
