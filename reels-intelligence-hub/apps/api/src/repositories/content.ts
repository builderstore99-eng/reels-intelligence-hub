import {
  AppError,
  ERROR_CODES,
  normalizeTags,
  randomId,
  type ContentItem,
  type ContentType,
  type Paginated,
  type ProcessingStatus,
  type Summary,
  type Tag,
  type Transcript,
  type TranscriptSegment,
  type VisualAnalysis,
} from '@rih/shared';
import { all, first, nowIso, run } from '../db/client.js';
import { toContentItem, toSummary, toTranscript } from '../db/mappers.js';

/** Content items, their derived artefacts, and tags. */

export interface ItemFilters {
  collectionId?: string;
  creator?: string;
  contentType?: ContentType;
  status?: ProcessingStatus;
  tag?: string;
  sort?: 'recent' | 'oldest' | 'creator' | 'status';
  page: number;
  pageSize: number;
}

export async function listItems(
  db: D1Database,
  ownerId: string,
  filters: ItemFilters,
): Promise<Paginated<ContentItem>> {
  const where: string[] = ['i.owner_id = ?'];
  const params: (string | number)[] = [ownerId];

  let join = '';
  if (filters.collectionId) {
    join = 'JOIN collection_items ci ON ci.content_item_id = i.id AND ci.collection_id = ?';
    params.unshift(filters.collectionId);
  }
  if (filters.tag) {
    join += `
      JOIN content_tags ct ON ct.content_item_id = i.id
      JOIN tags t ON t.id = ct.tag_id AND t.normalized_name = ?`;
    params.push(filters.tag);
  }

  if (filters.creator) {
    where.push('i.creator_identifier = ?');
    params.push(filters.creator);
  }
  if (filters.contentType) {
    where.push('i.content_type = ?');
    params.push(filters.contentType);
  }
  if (filters.status) {
    where.push('i.processing_status = ?');
    params.push(filters.status);
  }

  const whereSql = where.join(' AND ');

  const totalRow = await first<{ total: number }>(
    db,
    `SELECT COUNT(DISTINCT i.id) AS total FROM content_items i ${join} WHERE ${whereSql}`,
    params,
  );

  const orderBy =
    filters.sort === 'oldest'
      ? 'i.published_at ASC'
      : filters.sort === 'creator'
        ? 'i.creator_identifier ASC'
        : filters.sort === 'status'
          ? 'i.processing_status ASC'
          : 'COALESCE(i.published_at, i.created_at) DESC';

  const offset = (filters.page - 1) * filters.pageSize;
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT DISTINCT i.* FROM content_items i ${join}
     WHERE ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  const total = totalRow?.total ?? 0;
  return {
    data: rows.map(toContentItem),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
  };
}

export async function getItem(
  db: D1Database,
  ownerId: string,
  itemId: string,
  collectionId?: string,
): Promise<ContentItem> {
  const row = await first<Record<string, unknown>>(
    db,
    `SELECT i.*, ? AS collection_id FROM content_items i WHERE i.id = ? AND i.owner_id = ?`,
    [collectionId ?? '', itemId, ownerId],
  );
  if (!row) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      'That item does not exist, or you do not have access to it.',
    );
  }
  const item = toContentItem(row);
  if (!item.collectionId) {
    const membership = await first<{ collection_id: string }>(
      db,
      'SELECT collection_id FROM collection_items WHERE content_item_id = ? LIMIT 1',
      [itemId],
    );
    item.collectionId = membership?.collection_id ?? '';
  }
  return item;
}

export interface UpsertItemInput {
  sourceProvider: string;
  sourceIdentifier: string;
  sourceUrl: string;
  creatorIdentifier: string | null;
  contentType: ContentType;
  caption: string | null;
  publishedAt: string | null;
  thumbnailReference: string | null;
  metadata: Record<string, unknown>;
}

export interface UpsertResult {
  item: ContentItem;
  created: boolean;
}

/**
 * Insert or refresh a content item.
 *
 * The uniqueness key is (owner, provider, source identifier), which is exactly
 * what the schema's unique index enforces. On conflict we refresh metadata but
 * deliberately do NOT reset `processing_status` — re-discovering an already
 * analysed item must not throw away its summary.
 */
export async function upsertItem(
  db: D1Database,
  ownerId: string,
  input: UpsertItemInput,
): Promise<UpsertResult> {
  const existing = await first<Record<string, unknown>>(
    db,
    `SELECT * FROM content_items
      WHERE owner_id = ? AND source_provider = ? AND source_identifier = ?`,
    [ownerId, input.sourceProvider, input.sourceIdentifier],
  );

  const now = nowIso();

  if (existing) {
    await run(
      db,
      `UPDATE content_items
          SET source_url = ?, creator_identifier = ?, content_type = ?, caption = ?,
              published_at = COALESCE(?, published_at), thumbnail_reference = COALESCE(?, thumbnail_reference),
              metadata_json = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.sourceUrl,
        input.creatorIdentifier,
        input.contentType,
        input.caption,
        input.publishedAt,
        input.thumbnailReference,
        JSON.stringify(input.metadata),
        now,
        String(existing['id']),
      ],
    );
    return { item: toContentItem({ ...existing, ...{ updated_at: now } }), created: false };
  }

  const id = randomId();
  await run(
    db,
    `INSERT INTO content_items
       (id, owner_id, source_provider, source_identifier, source_url, creator_identifier,
        content_type, caption, published_at, thumbnail_reference, metadata_json,
        processing_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`,
    [
      id,
      ownerId,
      input.sourceProvider,
      input.sourceIdentifier,
      input.sourceUrl,
      input.creatorIdentifier,
      input.contentType,
      input.caption,
      input.publishedAt,
      input.thumbnailReference,
      JSON.stringify(input.metadata),
      now,
      now,
    ],
  );

  const created = await first<Record<string, unknown>>(
    db,
    'SELECT * FROM content_items WHERE id = ?',
    [id],
  );
  return { item: toContentItem(created ?? { id }), created: true };
}

export async function setItemStatus(
  db: D1Database,
  itemId: string,
  status: ProcessingStatus,
): Promise<void> {
  await run(db, 'UPDATE content_items SET processing_status = ?, updated_at = ? WHERE id = ?', [
    status,
    nowIso(),
    itemId,
  ]);
}

export async function saveTranscript(
  db: D1Database,
  itemId: string,
  input: { text: string; language: string | null; segments: TranscriptSegment[]; provider: string },
): Promise<void> {
  await run(
    db,
    `INSERT INTO transcripts (id, content_item_id, text, language, segments_json, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (content_item_id) DO UPDATE SET
       text = excluded.text,
       language = excluded.language,
       segments_json = excluded.segments_json,
       provider = excluded.provider`,
    [
      randomId(),
      itemId,
      input.text,
      input.language,
      JSON.stringify(input.segments),
      input.provider,
      nowIso(),
    ],
  );
}

export async function saveSummary(
  db: D1Database,
  itemId: string,
  input: {
    summaryType: string;
    title: string | null;
    shortSummary: string | null;
    detailedSummary: string | null;
    mainPoints: string[];
    takeaways: string[];
    visualAnalysis: VisualAnalysis | null;
    sourceReferences: Array<{ label: string; url: string; contentItemId?: string }>;
    modelIdentifier: string | null;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO summaries
       (id, content_item_id, summary_type, title, short_summary, detailed_summary,
        main_points_json, takeaways_json, visual_analysis_json, source_references_json,
        model_identifier, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (content_item_id, summary_type) DO UPDATE SET
       title = excluded.title,
       short_summary = excluded.short_summary,
       detailed_summary = excluded.detailed_summary,
       main_points_json = excluded.main_points_json,
       takeaways_json = excluded.takeaways_json,
       visual_analysis_json = excluded.visual_analysis_json,
       source_references_json = excluded.source_references_json,
       model_identifier = excluded.model_identifier`,
    [
      randomId(),
      itemId,
      input.summaryType,
      input.title,
      input.shortSummary,
      input.detailedSummary,
      JSON.stringify(input.mainPoints),
      JSON.stringify(input.takeaways),
      input.visualAnalysis ? JSON.stringify(input.visualAnalysis) : null,
      JSON.stringify(input.sourceReferences),
      input.modelIdentifier,
      nowIso(),
    ],
  );
}

export async function getSummary(db: D1Database, itemId: string): Promise<Summary | null> {
  const row = await first<Record<string, unknown>>(
    db,
    'SELECT * FROM summaries WHERE content_item_id = ? ORDER BY created_at DESC LIMIT 1',
    [itemId],
  );
  return row ? toSummary(row) : null;
}

export async function getTranscript(db: D1Database, itemId: string): Promise<Transcript | null> {
  const row = await first<Record<string, unknown>>(
    db,
    'SELECT * FROM transcripts WHERE content_item_id = ?',
    [itemId],
  );
  return row ? toTranscript(row) : null;
}

/**
 * Replace an item's tag set. Tags are created on demand and shared per owner,
 * so "lead-generation" is one row no matter how many items carry it.
 */
export async function setTags(
  db: D1Database,
  ownerId: string,
  itemId: string,
  rawTags: readonly string[],
): Promise<string[]> {
  const normalized = normalizeTags(rawTags);
  const now = nowIso();

  await run(db, 'DELETE FROM content_tags WHERE content_item_id = ?', [itemId]);

  for (const name of normalized) {
    const existing = await first<{ id: string }>(
      db,
      'SELECT id FROM tags WHERE owner_id = ? AND normalized_name = ?',
      [ownerId, name],
    );
    const tagId = existing?.id ?? randomId();
    if (!existing) {
      await run(
        db,
        'INSERT OR IGNORE INTO tags (id, owner_id, name, normalized_name) VALUES (?, ?, ?, ?)',
        [tagId, ownerId, name, name],
      );
    }
    await run(db, 'INSERT OR IGNORE INTO content_tags (content_item_id, tag_id) VALUES (?, ?)', [
      itemId,
      tagId,
    ]);
  }

  await refreshSearchRow(db, itemId);
  void now;
  return normalized;
}

export async function getTagsForItem(db: D1Database, itemId: string): Promise<Tag[]> {
  const rows = await all<{ id: string; name: string; normalized_name: string }>(
    db,
    `SELECT t.id, t.name, t.normalized_name
       FROM content_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.content_item_id = ?
      ORDER BY t.normalized_name`,
    [itemId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, normalizedName: r.normalized_name }));
}

export async function getTagsForItems(
  db: D1Database,
  itemIds: readonly string[],
): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>();
  if (itemIds.length === 0) return map;
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = await all<{
    content_item_id: string;
    id: string;
    name: string;
    normalized_name: string;
  }>(
    db,
    `SELECT ct.content_item_id, t.id, t.name, t.normalized_name
       FROM content_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.content_item_id IN (${placeholders})`,
    [...itemIds],
  );
  for (const row of rows) {
    const list = map.get(row.content_item_id) ?? [];
    list.push({ id: row.id, name: row.name, normalizedName: row.normalized_name });
    map.set(row.content_item_id, list);
  }
  return map;
}

export async function listOwnerTags(db: D1Database, ownerId: string): Promise<Tag[]> {
  const rows = await all<{ id: string; name: string; normalized_name: string; count: number }>(
    db,
    `SELECT t.id, t.name, t.normalized_name, COUNT(ct.content_item_id) AS count
       FROM tags t LEFT JOIN content_tags ct ON ct.tag_id = t.id
      WHERE t.owner_id = ?
      GROUP BY t.id
      ORDER BY count DESC, t.normalized_name
      LIMIT 200`,
    [ownerId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    normalizedName: r.normalized_name,
    count: r.count,
  }));
}

/**
 * Keep the FTS row in sync after a summary/transcript/tag write. FTS5 has no
 * UPDATE-on-virtual-table triggers here because the columns come from several
 * tables, so the pipeline calls this explicitly at the end of each stage.
 */
export async function refreshSearchRow(db: D1Database, itemId: string): Promise<void> {
  const item = await first<Record<string, unknown>>(
    db,
    'SELECT caption FROM content_items WHERE id = ?',
    [itemId],
  );
  if (!item) return;

  const summary = await first<Record<string, unknown>>(
    db,
    'SELECT title, short_summary, detailed_summary, visual_analysis_json FROM summaries WHERE content_item_id = ? LIMIT 1',
    [itemId],
  );
  const transcript = await first<Record<string, unknown>>(
    db,
    'SELECT text FROM transcripts WHERE content_item_id = ?',
    [itemId],
  );
  const tags = await getTagsForItem(db, itemId);

  let ocrText = '';
  if (summary && typeof summary['visual_analysis_json'] === 'string') {
    try {
      const visual = JSON.parse(summary['visual_analysis_json']) as VisualAnalysis;
      ocrText = visual.observedText ?? '';
    } catch {
      ocrText = '';
    }
  }

  const summaryText = summary
    ? [summary['title'], summary['short_summary'], summary['detailed_summary']]
        .filter((v): v is string => typeof v === 'string')
        .join('\n')
    : '';

  await run(db, 'DELETE FROM content_search WHERE content_item_id = ?', [itemId]);
  await run(
    db,
    `INSERT INTO content_search
       (content_item_id, owner_id, title, caption, summary_text, transcript_text, ocr_text, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      itemId,
      String(item['owner_id'] ?? ''),
      summary && typeof summary['title'] === 'string' ? summary['title'] : '',
      typeof item['caption'] === 'string' ? item['caption'] : '',
      summaryText,
      transcript && typeof transcript['text'] === 'string' ? transcript['text'] : '',
      ocrText,
      tags.map((t) => t.normalizedName).join(' '),
    ],
  );
}
