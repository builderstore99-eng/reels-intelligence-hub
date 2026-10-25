import { describe, expect, it } from 'vitest';
import { toFtsQuery } from '../src/services/search';

/**
 * FTS5 injection guard.
 *
 * `toFtsQuery` is the only place user text becomes an FTS expression. If it ever
 * stops quoting tokens, a query like `foo OR bar` — or worse, `"` — becomes
 * syntax and the search endpoint starts throwing 500s on ordinary input.
 */
describe('toFtsQuery', () => {
  it('quotes every token so FTS operators are inert', () => {
    expect(toFtsQuery('lead generation')).toBe('"lead" OR "generation"*');
  });

  it('strips characters that carry FTS meaning', () => {
    expect(toFtsQuery('foo OR bar')).toBe('"foo" OR "or" OR "bar"*');
    expect(toFtsQuery('"quoted"')).toBe('"quoted"*');
    expect(toFtsQuery('a*b(c)')).toBe('"abc"*');
  });

  it('drops single-character tokens that would match everything', () => {
    expect(toFtsQuery('a b c design')).toBe('"design"*');
  });

  it('returns an empty string when nothing searchable remains', () => {
    expect(toFtsQuery('')).toBe('');
    expect(toFtsQuery('   ')).toBe('');
    expect(toFtsQuery('!!! ???')).toBe('');
    expect(toFtsQuery('a')).toBe('');
  });

  it('caps the number of terms so a pathological query stays cheap', () => {
    const query = Array.from({ length: 40 }, (_, index) => `term${index}`).join(' ');
    const result = toFtsQuery(query);
    expect(result.split(' OR ')).toHaveLength(12);
  });

  it('prefix-matches only the final token', () => {
    const result = toFtsQuery('landing page');
    expect(result.endsWith('"page"*')).toBe(true);
    expect(result.startsWith('"landing" OR')).toBe(true);
  });

  it('is idempotent enough to be safe with punctuation-heavy input', () => {
    const hostile = '"); DROP TABLE content_search; --';
    const result = toFtsQuery(hostile);
    // Every emitted token is quoted; no bare operators survive.
    expect(result).not.toMatch(/;\s*DROP/i);
    for (const part of result.split(' OR ')) {
      expect(part).toMatch(/^"[a-z0-9]+"\*?$/);
    }
  });
});
