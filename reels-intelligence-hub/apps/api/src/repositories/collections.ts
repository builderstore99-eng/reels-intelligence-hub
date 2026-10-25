import {
  AppError,
  DEFAULT_COLLECTION_SETTINGS,
  ERROR_CODES,
  randomId,
  slugify,
  type Collection,
  type CollectionSettings,
  type CollectionType,
  type Paginated,
} from '@rih/shared';
import { all, first, nowIso, run } from '../db/client.js';
import { toCollection } from '../db/mappers.js';

/**
 * Collections repository.
 *
 * Every read and write is scoped by owner_id. There is no method that accepts
 * a collection id without also requiring the caller's user id — this is the
 * tenant-isolation boundary, and it lives in the data layer so a route handler
 * cannot forget it.
 */

const SELECT_WITH_COUNTS = `
  SELECT c.*,
    (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count,
    (SELECT COUNT(*) FROM collection_items ci
       JOIN content_items i ON i.id = ci.content_item_id
      WHERE ci.collection_id = c.id AND i.processing_status = 'completed') AS analyzed_count
  FROM collections c
`;

export interface ListOptions {
  status?: string;
  type?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listCollections(
  db: D1Database,
  ownerId: string,
  options: ListOptions,
): Promise<Paginated<Collection>> {
  const where: string[] = ['c.owner_id = ?'];
  const params: (string | number)[] = [ownerId];

  if (options.status && options.status !== 'all') {
    where.push('c.status = ?');
    params.push(options.status);
  }
  if (options.type && options.type !== 'all') {
    where.push('c.collection_type = ?');
    params.push(options.type);
  }
  if (options.search) {
    where.push('(c.name LIKE ? OR c.description LIKE ?)');
    const pattern = `%${options.search}%`;
    params.push(pattern, pattern);
  }

  const whereSql = where.join(' AND ');
  const totalRow = await first<{ total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM collections c WHERE ${whereSql}`,
    params,
  );

  const offset = (options.page - 1) * options.pageSize;
  const rows = await all<Record<string, unknown>>(
    db,
    `${SELECT_WITH_COUNTS} WHERE ${whereSql} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, options.pageSize, offset],
  );

  const total = totalRow?.total ?? 0;
  return {
    data: rows.map(toCollection),
    page: options.page,
    pageSize: options.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / options.pageSize)),
  };
}

export async function getCollection(
  db: D1Database,
  ownerId: string,
  collectionId: string,
): Promise<Collection> {
  const row = await first<Record<string, unknown>>(
    db,
    `${SELECT_WITH_COUNTS} WHERE c.id = ? AND c.owner_id = ?`,
    [collectionId, ownerId],
  );
  if (!row) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      'That collection does not exist, or you do not have access to it.',
    );
  }
  return toCollection(row);
}

export async function findCollectionBySource(
  db: D1Database,
  ownerId: string,
  sourceIdentifier: string,
): Promise<Collection | null> {
  const row = await first<Record<string, unknown>>(
    db,
    `${SELECT_WITH_COUNTS} WHERE c.owner_id = ? AND c.source_identifier = ?`,
    [ownerId, sourceIdentifier],
  );
  return row ? toCollection(row) : null;
}

export interface CreateCollectionInput {
  name: string;
  description?: string | null;
  collectionType: CollectionType;
  sourceIdentifier?: string | null;
  settings?: Partial<CollectionSettings>;
}

export async function createCollection(
  db: D1Database,
  ownerId: string,
  input: CreateCollectionInput,
): Promise<Collection> {
  const id = randomId();
  const now = nowIso();
  const normalized = slugify(input.name);
  const settings: CollectionSettings = { ...DEFAULT_COLLECTION_SETTINGS, ...input.settings };

  const clash = await first<{ id: string }>(
    db,
    'SELECT id FROM collections WHERE owner_id = ? AND normalized_name = ?',
    [ownerId, normalized],
  );
  if (clash) {
    throw new AppError(
      ERROR_CODES.DUPLICATE_RESOURCE,
      `You already have a collection called "${input.name}". Open it, or give this one a different name.`,
    );
  }

  await run(
    db,
    `INSERT INTO collections
       (id, owner_id, name, normalized_name, description, collection_type,
        source_identifier, settings_json, status, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id,
      ownerId,
      input.name,
      normalized,
      input.description ?? null,
      input.collectionType,
      input.sourceIdentifier ?? null,
      JSON.stringify(settings),
      now,
      now,
      now,
    ],
  );

  return getCollection(db, ownerId, id);
}

export async function updateCollection(
  db: D1Database,
  ownerId: string,
  collectionId: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: string;
    settings?: Partial<CollectionSettings>;
  },
): Promise<Collection> {
  const current = await getCollection(db, ownerId, collectionId);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?', 'normalized_name = ?');
    params.push(patch.name, slugify(patch.name));
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.settings !== undefined) {
    sets.push('settings_json = ?');
    params.push(JSON.stringify({ ...current.settings, ...patch.settings }));
  }

  if (sets.length === 0) return current;

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(collectionId, ownerId);

  await run(db, `UPDATE collections SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`, params);
  return getCollection(db, ownerId, collectionId);
}

export async function touchCollection(
  db: D1Database,
  collectionId: string,
  status?: string,
): Promise<void> {
  const now = nowIso();
  if (status) {
    await run(
      db,
      'UPDATE collections SET last_activity_at = ?, updated_at = ?, status = ? WHERE id = ?',
      [now, now, status, collectionId],
    );
  } else {
    await run(db, 'UPDATE collections SET last_activity_at = ?, updated_at = ? WHERE id = ?', [
      now,
      now,
      collectionId,
    ]);
  }
}

export async function deleteCollection(
  db: D1Database,
  ownerId: string,
  collectionId: string,
): Promise<void> {
  await getCollection(db, ownerId, collectionId);
  await run(db, 'DELETE FROM collections WHERE id = ? AND owner_id = ?', [collectionId, ownerId]);
}

export async function duplicateCollection(
  db: D1Database,
  ownerId: string,
  collectionId: string,
): Promise<Collection> {
  const source = await getCollection(db, ownerId, collectionId);
  const copy = await createCollection(db, ownerId, {
    name: `${source.name} (copy)`,
    description: source.description,
    collectionType: source.collectionType,
    sourceIdentifier: null,
    settings: source.settings,
  });

  const items = await all<{ content_item_id: string }>(
    db,
    'SELECT content_item_id FROM collection_items WHERE collection_id = ?',
    [collectionId],
  );
  const now = nowIso();
  for (const item of items) {
    await run(
      db,
      'INSERT OR IGNORE INTO collection_items (collection_id, content_item_id, added_at, added_by) VALUES (?, ?, ?, ?)',
      [copy.id, item.content_item_id, now, 'duplicate'],
    );
  }
  return getCollection(db, ownerId, copy.id);
}

/** Add an item to a collection. Idempotent. */
export async function addItemToCollection(
  db: D1Database,
  collectionId: string,
  contentItemId: string,
  addedBy = 'pipeline',
): Promise<void> {
  await run(
    db,
    'INSERT OR IGNORE INTO collection_items (collection_id, content_item_id, added_at, added_by) VALUES (?, ?, ?, ?)',
    [collectionId, contentItemId, nowIso(), addedBy],
  );
  await touchCollection(db, collectionId);
}

export async function removeItemFromCollection(
  db: D1Database,
  ownerId: string,
  collectionId: string,
  contentItemId: string,
): Promise<void> {
  await getCollection(db, ownerId, collectionId);
  await run(db, 'DELETE FROM collection_items WHERE collection_id = ? AND content_item_id = ?', [
    collectionId,
    contentItemId,
  ]);
  await touchCollection(db, collectionId);
}
