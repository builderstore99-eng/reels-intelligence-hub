import {
  EMBEDDING_DIMENSIONS,
  fuseResults,
  heuristicRelevance,
  type ContentItem,
  type Paginated,
  type RankedHit,
} from '@rih/shared';
import { all, first, likePattern } from '../db/client.js';
import { toContentItem } from '../db/mappers.js';
import { embedTexts } from './ai.js';
import { getSettings } from '../repositories/misc.js';
import type { Env } from '../env.js';

/**
 * Hybrid search.
 *
 * Lexical search runs on the FTS5 table (`content_search`) with bm25 ranking.
 * Semantic search runs against Vectorize. Results are fused with the documented
 * method in `@rih/shared/ranking` — min-max normalise each modality, weight
 * 0.45 lexical / 0.55 semantic, then a small Reciprocal Rank Fusion term to
 * break ties in favour of items that score well in both.
 *
 * If semantic search is unavailable (no key, no binding, index empty), the
 * caller transparently gets lexical-only results and `semanticAvailable: false`
 * — the UI says so rather than implying semantic coverage it does not have.
 */

export interface SearchFilters {
  collectionId?: string;
  creator?: string;
  contentType?: string;
  tag?: string;
  status?: string;
}

export interface SearchParams extends SearchFilters {
  q: string;
  mode: 'hybrid' | 'lexical' | 'semantic';
  sort: 'relevance' | 'recent' | 'oldest';
  page: number;
  pageSize: number;
}

export interface SearchHit extends ContentItem {
  score: number;
  lexicalScore: number;
  semanticScore: number;
  excerpt: string | null;
  tags: string[];
}

export interface SearchResponse extends Paginated<SearchHit> {
  semanticAvailable: boolean;
  mode: 'hybrid' | 'lexical' | 'semantic';
  /** Set when the requested mode was downgraded, e.g. semantic → lexical. */
  notice: string | null;
}

/**
 * Turn free text into an FTS5 MATCH expression.
 *
 * User input is never interpolated raw: every token is stripped to
 * alphanumerics and quoted, so an input like `foo OR bar"` becomes
 * `"foo" OR "bar"` and cannot smuggle in FTS operators.
 */
export function toFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 1)
    .slice(0, 12);

  if (tokens.length === 0) return '';
  // Prefix-match the last token so search-as-you-type works.
  return tokens
    .map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(' OR ');
}

async function lexicalSearch(
  db: D1Database,
  ownerId: string,
  params: SearchParams,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const ftsQuery = toFtsQuery(params.q);

  if (ftsQuery) {
    const rows = await all<{ content_item_id: string; score: number }>(
      db,
      `SELECT content_item_id, bm25(content_search) AS score
         FROM content_search
        WHERE content_search MATCH ? AND owner_id = ?
        ORDER BY score
        LIMIT 200`,
      [ftsQuery, ownerId],
    );
    for (const row of rows) {
      // bm25 returns a negative number where more negative is better.
      scores.set(row.content_item_id, -row.score);
    }
  }

  // Complementary substring pass over captions: catches short or partial
  // tokens that FTS tokenisation drops (e.g. "UI", "AI").
  if (scores.size < 20) {
    const rows = await all<{ id: string; caption: string | null }>(
      db,
      `SELECT id, caption FROM content_items
        WHERE owner_id = ? AND caption IS NOT NULL AND caption LIKE ? ESCAPE '\\'
        LIMIT 100`,
      [ownerId, likePattern(params.q)],
    );
    for (const row of rows) {
      if (scores.has(row.id)) continue;
      scores.set(row.id, heuristicRelevance(params.q, row.caption ?? '') * 0.5);
    }
  }

  return scores;
}

async function semanticSearch(
  env: Env,
  db: D1Database,
  ownerId: string,
  query: string,
  limit: number,
): Promise<{ scores: Map<string, number>; available: boolean; notice: string | null }> {
  const scores = new Map<string, number>();

  try {
    const settings = await getSettings(db, ownerId);
    const result = await embedTexts(
      { env, db, ownerId, collectionId: null, jobId: null, settings },
      [query],
    );
    const vector = result.vectors[0];
    if (!vector) {
      return { scores, available: false, notice: 'Embedding generation returned no vector.' };
    }
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      return {
        scores,
        available: false,
        notice: `The embedding model returned ${vector.length} dimensions but the index expects ${EMBEDDING_DIMENSIONS}.`,
      };
    }

    const matches = await env.VECTORS.query(vector, {
      topK: limit,
      returnMetadata: 'all',
      // Filter in the index so another tenant's vectors are never even scored.
      filter: { ownerId },
    });

    for (const match of matches.matches ?? []) {
      scores.set(match.id, match.score);
    }
    return { scores, available: true, notice: null };
  } catch (error) {
    return {
      scores,
      available: false,
      notice:
        error instanceof Error &&
        /not configured|PROVIDER_NOT_CONFIGURED|No .* key/i.test(error.message)
          ? 'Semantic search needs an embedding provider key. Add one in Settings → API Keys. Showing keyword results instead.'
          : 'Semantic search is temporarily unavailable. Showing keyword results instead.',
    };
  }
}

export async function search(
  env: Env,
  db: D1Database,
  ownerId: string,
  params: SearchParams,
): Promise<SearchResponse> {
  let notice: string | null = null;
  let semanticAvailable = false;

  const lexicalScores =
    params.mode === 'semantic'
      ? new Map<string, number>()
      : await lexicalSearch(db, ownerId, params);

  let semanticScores = new Map<string, number>();
  if (params.mode !== 'lexical') {
    const semantic = await semanticSearch(env, db, ownerId, params.q, 60);
    semanticScores = semantic.scores;
    semanticAvailable = semantic.available;
    notice = semantic.notice;
  }

  // Union of candidate ids.
  const candidateIds = new Set<string>([...lexicalScores.keys(), ...semanticScores.keys()]);

  if (candidateIds.size === 0) {
    return {
      data: [],
      page: params.page,
      pageSize: params.pageSize,
      total: 0,
      totalPages: 1,
      semanticAvailable,
      mode: params.mode,
      notice,
    };
  }

  const ids = [...candidateIds].slice(0, 400);
  const placeholders = ids.map(() => '?').join(',');
  const where: string[] = [`i.owner_id = ?`, `i.id IN (${placeholders})`];
  const whereParams: (string | number)[] = [ownerId, ...ids];

  if (params.collectionId) {
    where.push(
      'EXISTS (SELECT 1 FROM collection_items ci WHERE ci.content_item_id = i.id AND ci.collection_id = ?)',
    );
    whereParams.push(params.collectionId);
  }
  if (params.creator) {
    where.push('i.creator_identifier = ?');
    whereParams.push(params.creator);
  }
  if (params.contentType) {
    where.push('i.content_type = ?');
    whereParams.push(params.contentType);
  }
  if (params.status) {
    where.push('i.processing_status = ?');
    whereParams.push(params.status);
  }
  if (params.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM content_tags ct JOIN tags t ON t.id = ct.tag_id
               WHERE ct.content_item_id = i.id AND t.normalized_name = ?)`,
    );
    whereParams.push(params.tag);
  }

  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT i.* FROM content_items i WHERE ${where.join(' AND ')} LIMIT 400`,
    whereParams,
  );

  const items = rows.map(toContentItem);
  const ranked: RankedHit[] = items.map((item) => ({
    id: item.id,
    lexicalScore: lexicalScores.get(item.id) ?? 0,
    semanticScore: semanticScores.get(item.id) ?? 0,
  }));

  const fused = fuseResults(ranked, items.length);
  const itemById = new Map(items.map((item) => [item.id, item]));

  // Excerpts: prefer the summary's short summary, fall back to the caption.
  const summaryRows = await all<{ content_item_id: string; short_summary: string | null }>(
    db,
    `SELECT content_item_id, short_summary FROM summaries WHERE content_item_id IN (${placeholders})`,
    [...ids],
  );
  const excerptById = new Map(summaryRows.map((row) => [row.content_item_id, row.short_summary]));

  const tagRows = await all<{ content_item_id: string; normalized_name: string }>(
    db,
    `SELECT ct.content_item_id, t.normalized_name
       FROM content_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.content_item_id IN (${placeholders})`,
    [...ids],
  );
  const tagsById = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tagsById.get(row.content_item_id) ?? [];
    list.push(row.normalized_name);
    tagsById.set(row.content_item_id, list);
  }

  const hits: SearchHit[] = fused
    .map((fusedHit) => {
      const item = itemById.get(fusedHit.id);
      if (!item) return null;
      return {
        ...item,
        score: fusedHit.score,
        lexicalScore: fusedHit.lexicalScore,
        semanticScore: fusedHit.semanticScore,
        excerpt: excerptById.get(item.id) ?? item.caption?.slice(0, 220) ?? null,
        tags: tagsById.get(item.id) ?? [],
      } satisfies SearchHit;
    })
    .filter((hit): hit is SearchHit => hit !== null);

  if (params.sort === 'recent') {
    hits.sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
  } else if (params.sort === 'oldest') {
    hits.sort((a, b) => (a.publishedAt ?? a.createdAt).localeCompare(b.publishedAt ?? b.createdAt));
  }

  const total = hits.length;
  const start = (params.page - 1) * params.pageSize;

  return {
    data: hits.slice(start, start + params.pageSize),
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    semanticAvailable,
    mode: params.mode,
    notice,
  };
}

/** Search suggestions for the command palette / search-as-you-type. */
export async function suggest(
  db: D1Database,
  ownerId: string,
  prefix: string,
): Promise<Array<{ kind: 'collection' | 'creator' | 'tag'; value: string }>> {
  const pattern = likePattern(prefix);
  const out: Array<{ kind: 'collection' | 'creator' | 'tag'; value: string }> = [];

  const collections = await all<{ name: string }>(
    db,
    "SELECT name FROM collections WHERE owner_id = ? AND name LIKE ? ESCAPE '\\' LIMIT 5",
    [ownerId, pattern],
  );
  out.push(...collections.map((c) => ({ kind: 'collection' as const, value: c.name })));

  const creators = await all<{ creator_identifier: string }>(
    db,
    `SELECT DISTINCT creator_identifier FROM content_items
      WHERE owner_id = ? AND creator_identifier LIKE ? ESCAPE '\\' LIMIT 5`,
    [ownerId, pattern],
  );
  out.push(...creators.map((c) => ({ kind: 'creator' as const, value: c.creator_identifier })));

  const tags = await all<{ normalized_name: string }>(
    db,
    `SELECT normalized_name FROM tags WHERE owner_id = ? AND normalized_name LIKE ? ESCAPE '\\' LIMIT 5`,
    [ownerId, pattern],
  );
  out.push(...tags.map((t) => ({ kind: 'tag' as const, value: t.normalized_name })));

  return out;
}

/** Total indexed items, used by the search empty state. */
export async function indexedCount(db: D1Database, ownerId: string): Promise<number> {
  const row = await first<{ total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM content_items WHERE owner_id = ?',
    [ownerId],
  );
  return row?.total ?? 0;
}
