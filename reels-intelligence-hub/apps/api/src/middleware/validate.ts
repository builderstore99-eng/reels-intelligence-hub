import { AppError, ERROR_CODES } from '@rih/shared';
import type { z } from 'zod';

/**
 * Parse and validate a request body or query against a Zod schema.
 *
 * On failure we return a VALIDATION_FAILED error whose `details` is a compact
 * field → message map, which the frontend renders next to the offending input
 * instead of a generic toast.
 */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }

  const first = result.error.issues[0];
  throw new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    first ? `${first.path.join('.') || 'Input'}: ${first.message}` : 'The request was not valid.',
    { details: { fields: fieldErrors } },
  );
}

/** Read a JSON body, tolerating an empty one. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The request body was not valid JSON.');
  }
}

/** Convert URLSearchParams into a plain object for query validation. */
export function queryObject(url: string): Record<string, string> {
  const params = new URL(url).searchParams;
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}
