import type { Context, MiddlewareHandler } from 'hono';
import { AppError, ERROR_CODES, type ApiErrorBody, type User } from '@rih/shared';
import type { AppEnv, Env } from '../env.js';
import { MissingSecretError, requireSecret } from '../env.js';
import { verifyToken } from '@rih/shared';
import { findUserById } from '../repositories/users.js';
import { randomId } from '@rih/shared';

/** Request id for correlation across logs and error bodies. */
export function requestIdOf(c: Context<AppEnv>): string {
  return c.get('requestId') ?? 'unknown';
}

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  c.set('requestId', incoming && incoming.length <= 64 ? incoming : randomId(8));
  await next();
  c.header('x-request-id', requestIdOf(c));
};

/** Read a session token from the Authorization header or the session cookie. */
function readToken(c: Context<AppEnv>): string | null {
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookie = c.req.header('cookie');
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'rih_session') return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readToken(c);
  if (!token) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Sign in to continue.');
  }

  const secret = requireSecret(c.env, 'AUTH_SECRET');
  const result = await verifyToken(token, secret);

  if (!result.ok) {
    throw new AppError(
      result.reason === 'expired' ? ERROR_CODES.SESSION_EXPIRED : ERROR_CODES.UNAUTHENTICATED,
      result.reason === 'expired'
        ? 'Your session has expired. Sign in again.'
        : 'That session token is not valid. Sign in again.',
    );
  }

  const user = await findUserById(c.env.DB, result.payload.sub);
  if (!user) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'That account no longer exists.');
  }

  c.set('user', user);
  await next();
};

export function currentUser(c: Context<AppEnv>): User {
  const user = c.get('user');
  if (!user) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Sign in to continue.');
  }
  return user;
}

/**
 * Very small fixed-window limiter backed by D1's rate_limit_events table.
 *
 * This is deliberately coarse: it protects against accidental hammering from a
 * single account, not against a determined attacker (Cloudflare's own rate
 * limiting rules are the right tool for that, and DEPLOYMENT.md explains how to
 * turn them on). In-memory counters are not used because a Worker instance is
 * evicted whenever it feels like it.
 */
export async function enforceRateLimit(
  env: Env,
  ownerId: string,
  bucket: string,
  limitPerMinute: number,
): Promise<void> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM audit_events
      WHERE actor_id = ? AND action = ? AND created_at >= ?`,
  )
    .bind(ownerId, `ratelimit:${bucket}`, since)
    .first<{ total: number }>();

  if ((row?.total ?? 0) >= limitPerMinute) {
    throw new AppError(
      ERROR_CODES.RATE_LIMITED,
      'Too many requests in the last minute. Wait a moment and try again.',
    );
  }

  await env.DB.prepare(
    'INSERT INTO audit_events (id, owner_id, actor_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(randomId(), ownerId, ownerId, `ratelimit:${bucket}`, new Date().toISOString())
    .run();
}

/** Convert any thrown value into the standard error envelope. */
export function toErrorResponse(
  error: unknown,
  requestId: string,
): { body: ApiErrorBody; status: number } {
  if (error instanceof AppError) {
    return { body: error.toBody(requestId), status: error.status };
  }

  if (error instanceof MissingSecretError) {
    // A deployment problem, not a user problem. The variable name is safe to
    // show an operator; its value never is.
    return {
      body: {
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message:
            'The server is not fully configured. An administrator must set the required secrets before this feature works.',
          retryable: false,
          requestId,
        },
      },
      status: 500,
    };
  }

  // Unknown failure: log the detail server-side, return something generic.
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );

  return {
    body: {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong on our side. The request id above can be used to trace it.',
        retryable: true,
        requestId,
      },
    },
    status: 500,
  };
}
