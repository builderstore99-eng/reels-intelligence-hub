/**
 * Retry scheduling.
 *
 * Bounded exponential backoff with full jitter. "Bounded" matters: a job that
 * hits a platform rate limit must not keep retrying for days, and it must
 * never retry a permanent authorization failure at all.
 */

export interface RetryPolicy {
  /** Total attempts, including the first one. */
  maxAttempts: number;
  /** Base delay in ms for attempt 2. */
  baseDelayMs: number;
  /** Upper bound for any single delay. */
  maxDelayMs: number;
  /** Multiplier applied per attempt. */
  factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 10 * 60 * 1000,
  factor: 2,
};

/**
 * Parse an HTTP `Retry-After` header. Accepts either delta-seconds or an
 * HTTP-date. Returns milliseconds, or null when absent/unparseable.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Delay before the next attempt.
 *
 * @param attempt       1-based number of the attempt that just failed.
 * @param policy        Retry policy.
 * @param retryAfterMs  Server-provided Retry-After, which always wins.
 * @param random        Injectable RNG so tests are deterministic.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, policy.maxDelayMs);
  }

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = policy.baseDelayMs * Math.pow(policy.factor, safeAttempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Full jitter: uniform in [0, capped]. Spreads a thundering herd of
  // retries that all failed against the same rate-limited endpoint.
  return Math.floor(random() * capped);
}

export function shouldRetry(
  attempt: number,
  retryable: boolean,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (!retryable) return false;
  return attempt < policy.maxAttempts;
}

/** Next retry timestamp as ISO string, or null when the item is exhausted. */
export function nextRetryAt(
  attempt: number,
  retryable: boolean,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs: number | null = null,
  now = Date.now(),
  random: () => number = Math.random,
): string | null {
  if (!shouldRetry(attempt, retryable, policy)) return null;
  const delay = computeBackoffDelay(attempt, policy, retryAfterMs, random);
  return new Date(now + delay).toISOString();
}
