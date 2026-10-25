/**
 * Tag normalisation.
 *
 * Tags arrive from AI output, user input, and imports, so they are messy.
 * We canonicalise aggressively so that "Lead-Gen", "lead gen" and "LeadGen"
 * collapse into a single tag row instead of three.
 */

const MAX_TAG_LENGTH = 48;
const MAX_TAGS_PER_ITEM = 12;

/** Words that carry no retrieval value on their own. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'to',
  'in',
  'on',
  'with',
  'this',
  'that',
  'is',
  'are',
  'be',
  'it',
  'its',
  'as',
  'at',
  'by',
  'or',
  'from',
  'your',
  'you',
  'how',
  'what',
  'why',
  'when',
  'video',
  'reel',
  'post',
  'content',
  'instagram',
]);

/** Trim, lowercase, collapse separators to a single hyphen. */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[#@]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/** Display form: hyphenated slugs rendered back as spaced words. */
export function displayTag(normalized: string): string {
  return normalized.replace(/-/g, ' ');
}

/**
 * Normalise a list of tags: slugify, drop empties/stopwords/over-long tokens,
 * de-duplicate, and cap the count. Order is preserved so the most relevant
 * (usually model-ranked) tags survive the cap.
 */
export function normalizeTags(raw: readonly string[], limit = MAX_TAGS_PER_ITEM): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const slug = normalizeTag(item);
    if (!slug || slug.length < 2) continue;
    if (STOPWORDS.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= limit) break;
  }

  return out;
}

/** Jaccard similarity between two tag sets, 0..1. Used for related items. */
export function tagSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
