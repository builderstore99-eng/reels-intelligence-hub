import { describe, expect, it } from 'vitest';
import { displayTag, normalizeTag, normalizeTags, tagSimilarity } from '../tags';
import {
  computeBackoffDelay,
  DEFAULT_RETRY_POLICY,
  nextRetryAt,
  parseRetryAfter,
  shouldRetry,
} from '../retry';
import { estimateCostUsd, estimateTokens, formatBytes, formatUsd } from '../cost';
import { fuseResults, heuristicRelevance } from '../ranking';

describe('tag normalisation', () => {
  it('collapses casing, separators and punctuation', () => {
    expect(normalizeTag('Lead-Gen')).toBe('lead-gen');
    expect(normalizeTag('Lead Gen')).toBe('lead-gen');
    expect(normalizeTag('  #LeadGen  ')).toBe('leadgen');
    expect(normalizeTag('UI/UX')).toBe('ui-ux');
  });

  it('removes duplicates and stopwords, preserving order', () => {
    expect(normalizeTags(['Design', 'design', 'the', 'a', 'Layout'])).toEqual(['design', 'layout']);
  });

  it('caps the number of tags', () => {
    const many = Array.from({ length: 30 }, (_, index) => `tag${index}`);
    expect(normalizeTags(many)).toHaveLength(12);
    expect(normalizeTags(many, 3)).toHaveLength(3);
  });

  it('drops tags that normalise to nothing', () => {
    expect(normalizeTags(['!!!', '  ', '-', 'ok'])).toEqual(['ok']);
  });

  it('renders a slug back to spaced words', () => {
    expect(displayTag('lead-generation')).toBe('lead generation');
  });
});

describe('tagSimilarity', () => {
  it('returns Jaccard overlap', () => {
    expect(tagSimilarity(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    expect(tagSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(tagSimilarity([], ['a'])).toBe(0);
  });
});

describe('retry scheduling', () => {
  it('parses Retry-After as delta seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('not-a-number')).toBeNull();
  });

  it('parses Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:02:00 GMT', now)).toBe(120_000);
    // A date in the past never yields a negative delay.
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
  });

  it('honours Retry-After over the computed backoff, capped by the policy', () => {
    expect(computeBackoffDelay(1, DEFAULT_RETRY_POLICY, 5_000, () => 0.5)).toBe(5_000);
    expect(computeBackoffDelay(1, DEFAULT_RETRY_POLICY, 60 * 60 * 1000, () => 0.5)).toBe(
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
  });

  it('grows exponentially and stays within the cap', () => {
    const noJitter = () => 1;
    const first = computeBackoffDelay(1, DEFAULT_RETRY_POLICY, null, noJitter);
    const second = computeBackoffDelay(2, DEFAULT_RETRY_POLICY, null, noJitter);
    const third = computeBackoffDelay(3, DEFAULT_RETRY_POLICY, null, noJitter);

    expect(first).toBe(2_000);
    expect(second).toBe(4_000);
    expect(third).toBe(8_000);
    expect(computeBackoffDelay(50, DEFAULT_RETRY_POLICY, null, noJitter)).toBe(
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
  });

  it('applies full jitter — delay is never above the exponential value', () => {
    const delay = computeBackoffDelay(4, DEFAULT_RETRY_POLICY, null, () => 0.42);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(16_000);
  });

  it('never retries a permanent failure', () => {
    expect(shouldRetry(1, false)).toBe(false);
    expect(shouldRetry(1, true)).toBe(true);
    expect(shouldRetry(DEFAULT_RETRY_POLICY.maxAttempts, true)).toBe(false);
  });

  it('returns null once attempts are exhausted', () => {
    expect(nextRetryAt(99, true, DEFAULT_RETRY_POLICY, null, 0, () => 0.5)).toBeNull();
    expect(nextRetryAt(1, false, DEFAULT_RETRY_POLICY, null, 0, () => 0.5)).toBeNull();
    expect(nextRetryAt(1, true, DEFAULT_RETRY_POLICY, null, 0, () => 1)).toBe(
      '1970-01-01T00:00:02.000Z',
    );
  });
});

describe('cost estimation', () => {
  it('prices token usage from the registry', () => {
    // gpt-4.1-mini: $0.40 / 1M input, $1.60 / 1M output.
    const cost = estimateCostUsd('gpt-4.1-mini', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2.0, 6);
  });

  it('prices audio per minute', () => {
    expect(estimateCostUsd('whisper-1', { audioSeconds: 600 })).toBeCloseTo(0.06, 6);
  });

  it('returns zero for an unknown model rather than guessing', () => {
    expect(estimateCostUsd('does-not-exist', { inputTokens: 1_000 })).toBe(0);
  });

  it('estimates tokens at roughly four characters each', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(1);
  });

  it('formats money and bytes for display', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('$0.0040');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('hybrid ranking', () => {
  it('fuses lexical and semantic scores into a bounded ranking', () => {
    const fused = fuseResults([
      { id: 'a', lexicalScore: 10, semanticScore: 0.2 },
      { id: 'b', lexicalScore: 1, semanticScore: 0.95 },
      { id: 'c', lexicalScore: 0, semanticScore: 0 },
    ]);

    expect(fused).toHaveLength(3);
    // Every score is normalised into [0, 1.15].
    for (const hit of fused) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1.2);
    }
    // The item that is strong in both modalities should not be last.
    expect(fused[fused.length - 1]!.id).toBe('c');
  });

  it('respects the limit', () => {
    const hits = Array.from({ length: 30 }, (_, index) => ({
      id: `id-${index}`,
      lexicalScore: index,
      semanticScore: index / 30,
    }));
    expect(fuseResults(hits, 5)).toHaveLength(5);
  });

  it('handles an empty input', () => {
    expect(fuseResults([])).toEqual([]);
  });

  it('scores heuristic relevance by term coverage', () => {
    expect(heuristicRelevance('landing page design', 'a landing page teardown')).toBeCloseTo(2 / 3);
    expect(heuristicRelevance('', 'anything')).toBe(0);
    expect(heuristicRelevance('zzz', 'nothing here')).toBe(0);
  });
});
