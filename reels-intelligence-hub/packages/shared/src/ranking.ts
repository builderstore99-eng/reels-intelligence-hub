/**
 * Hybrid retrieval ranking.
 *
 * Lexical (D1 FTS / LIKE) and semantic (Vectorize cosine) scores are on
 * completely different scales, so they cannot be added directly. We min-max
 * normalise each list within itself, then fuse with Reciprocal Rank Fusion
 * (RRF) as a tie-breaker on the normalised score.
 *
 * The method is documented in ARCHITECTURE.md § Search.
 */

export interface RankedHit {
  id: string;
  /** Raw lexical score (bm25 or a LIKE-match heuristic). */
  lexicalScore?: number;
  /** Raw semantic score (cosine similarity, -1..1 for most models). */
  semanticScore?: number;
  /** Optional recency bonus input, epoch ms. */
  publishedAt?: number | null;
}

export interface FusedHit {
  id: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
}

const LEXICAL_WEIGHT = 0.45;
const SEMANTIC_WEIGHT = 0.55;
const RRF_K = 60;

function minMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function normalise(value: number, min: number, max: number): number {
  if (max - min <= 1e-9) return value > 0 ? 1 : 0;
  return (value - min) / (max - min);
}

/**
 * Fuse lexical and semantic hits.
 *
 * @param hits   Union of both result sets, keyed by id.
 * @param limit  Maximum results returned.
 */
export function fuseResults(hits: RankedHit[], limit = 20): FusedHit[] {
  if (hits.length === 0) return [];

  const lexicalValues = hits.map((h) => h.lexicalScore ?? 0);
  const semanticValues = hits.map((h) => h.semanticScore ?? 0);
  const lex = minMax(lexicalValues);
  const sem = minMax(semanticValues);

  // RRF ranks are computed independently per modality.
  const byLexical = [...hits].sort((a, b) => (b.lexicalScore ?? 0) - (a.lexicalScore ?? 0));
  const bySemantic = [...hits].sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0));
  const rrf = new Map<string, number>();
  byLexical.forEach((h, i) => {
    if ((h.lexicalScore ?? 0) > 0) rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (RRF_K + i + 1));
  });
  bySemantic.forEach((h, i) => {
    if ((h.semanticScore ?? 0) > 0) rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (RRF_K + i + 1));
  });

  const maxRrf = Math.max(...[...rrf.values()], 1e-9);

  const fused: FusedHit[] = hits.map((h) => {
    const l = normalise(h.lexicalScore ?? 0, lex.min, lex.max);
    const s = normalise(h.semanticScore ?? 0, sem.min, sem.max);
    const r = (rrf.get(h.id) ?? 0) / maxRrf;
    const score = LEXICAL_WEIGHT * l + SEMANTIC_WEIGHT * s + 0.15 * r;
    return {
      id: h.id,
      score: Math.round(score * 10_000) / 10_000,
      lexicalScore: h.lexicalScore ?? 0,
      semanticScore: h.semanticScore ?? 0,
    };
  });

  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return fused.slice(0, limit);
}

/** Simple relevance heuristic for discovery results with no provider score. */
export function heuristicRelevance(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 2);
  if (terms.length === 0) return 0;

  const haystack = text.toLowerCase();
  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matches += 1;
  }
  return matches / terms.length;
}
