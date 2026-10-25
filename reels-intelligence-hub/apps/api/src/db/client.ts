import { AppError, ERROR_CODES } from '@rih/shared';

/**
 * Thin D1 helpers.
 *
 * Every query in the codebase goes through these three functions, which means
 * (a) parameter binding is always used — no string interpolation of values
 * anywhere, and (b) a driver-level failure is translated into a retryable
 * DATABASE_ERROR instead of leaking a D1 stack trace to the client.
 */

type Param = string | number | boolean | null;

function toD1Params(params: readonly Param[]): (string | number | boolean | null)[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function wrapError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new AppError(
    ERROR_CODES.DATABASE_ERROR,
    'The database could not complete that request. It is usually safe to retry.',
    { details: { driver: message } },
  );
}

export async function first<T>(
  db: D1Database,
  sql: string,
  params: readonly Param[] = [],
): Promise<T | null> {
  try {
    const stmt = db.prepare(sql).bind(...toD1Params(params));
    return (await stmt.first<T>()) ?? null;
  } catch (error) {
    wrapError(error);
  }
}

export async function all<T>(
  db: D1Database,
  sql: string,
  params: readonly Param[] = [],
): Promise<T[]> {
  try {
    const stmt = db.prepare(sql).bind(...toD1Params(params));
    const result = await stmt.all<T>();
    return result.results ?? [];
  } catch (error) {
    wrapError(error);
  }
}

export interface RunResult {
  changes: number;
  lastRowId: number | null;
}

export async function run(
  db: D1Database,
  sql: string,
  params: readonly Param[] = [],
): Promise<RunResult> {
  try {
    const stmt = db.prepare(sql).bind(...toD1Params(params));
    const result = await stmt.run();
    return {
      changes: result.meta.changes ?? 0,
      lastRowId: result.meta.last_row_id ?? null,
    };
  } catch (error) {
    wrapError(error);
  }
}

/**
 * Run several statements atomically. D1 applies a batch as a transaction, so a
 * mid-batch failure leaves no partial writes — which is what job counters and
 * content+tag inserts rely on.
 */
export async function batch(
  db: D1Database,
  statements: Array<{ sql: string; params?: readonly Param[] }>,
): Promise<void> {
  if (statements.length === 0) return;
  try {
    const prepared = statements.map((s) => db.prepare(s.sql).bind(...toD1Params(s.params ?? [])));
    await db.batch(prepared);
  } catch (error) {
    wrapError(error);
  }
}

/** ISO-8601 timestamp, the only date format we store. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Escape a value for use inside a LIKE pattern. */
export function likePattern(raw: string): string {
  return `%${raw.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}
