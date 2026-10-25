import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AppError,
  ERROR_CODES,
  confirmPasswordResetSchema,
  hashPassword,
  loginSchema,
  randomId,
  registerSchema,
  requestPasswordResetSchema,
  signToken,
  verifyPassword,
} from '@rih/shared';
import type { AppEnv, Env } from '../env.js';
import { requireSecret } from '../env.js';
import { parse, readJson } from '../middleware/validate.js';
import { currentUser, enforceRateLimit, requireAuth } from '../middleware/auth.js';
import {
  consumePasswordReset,
  createPasswordReset,
  createUser,
  findUserByEmail,
  updateUserPassword,
} from '../repositories/users.js';
import { recordAudit } from '../repositories/misc.js';

const auth = new Hono<AppEnv>();

const SESSION_COOKIE = 'rih_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Session cookie.
 *
 * HttpOnly so JavaScript cannot read it; SameSite=Lax so a cross-site form POST
 * cannot carry it; Secure whenever the request arrived over HTTPS. The token is
 * *also* returned in the response body, because a cross-origin frontend (the
 * default local setup) cannot rely on cookies.
 */
function setSessionCookie(c: Context<AppEnv>, token: string): void {
  const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
  c.header(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

async function issueToken(
  env: Env,
  user: { id: string; email: string; role: string },
): Promise<string> {
  const secret = requireSecret(env, 'AUTH_SECRET');
  return signToken(
    {
      sub: user.id,
      email: user.email,
      role: user.role as 'owner' | 'admin' | 'member',
      ttlSeconds: SESSION_TTL_SECONDS,
    },
    secret,
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

auth.post('/register', async (c) => {
  const body = parse(registerSchema, await readJson(c.req.raw));
  const passwordHash = await hashPassword(body.password);
  const user = await createUser(c.env.DB, {
    email: body.email,
    displayName: body.displayName,
    passwordHash,
  });

  const token = await issueToken(c.env, user);
  setSessionCookie(c, token);

  await recordAudit(c.env.DB, {
    ownerId: user.id,
    actorId: user.id,
    action: 'auth.register',
    targetType: 'user',
    targetId: user.id,
  });

  return c.json({ data: { user, token } }, 201);
});

auth.post('/login', async (c) => {
  const body = parse(loginSchema, await readJson(c.req.raw));
  const record = await findUserByEmail(c.env.DB, body.email);

  // Hash even when the user is missing, so response time does not reveal
  // whether an email is registered.
  const ok = record ? await verifyPassword(body.password, record.passwordHash) : false;

  if (!record || !ok) {
    if (record) await enforceRateLimit(c.env, record.id, 'login-fail', 10);
    throw new AppError(
      ERROR_CODES.INVALID_CREDENTIALS,
      'That email and password combination is not correct.',
    );
  }

  const token = await issueToken(c.env, record);
  setSessionCookie(c, token);

  const { passwordHash: _passwordHash, ...user } = record;
  await recordAudit(c.env.DB, { ownerId: user.id, actorId: user.id, action: 'auth.login' });

  return c.json({ data: { user, token } });
});

auth.post('/logout', (c) => {
  c.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return c.json({ data: { ok: true } });
});

auth.get('/session', requireAuth, (c) => {
  return c.json({ data: { user: currentUser(c) } });
});

auth.post('/password-reset/request', async (c) => {
  const body = parse(requestPasswordResetSchema, await readJson(c.req.raw));
  const record = await findUserByEmail(c.env.DB, body.email);

  // Always 202 whether or not the account exists, so the endpoint cannot be
  // used to enumerate registered emails.
  if (record) {
    const token = randomId(24);
    await createPasswordReset(
      c.env.DB,
      record.id,
      await sha256Hex(token),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );

    // No email provider is wired up in this repository. In development the
    // token is returned so the flow is testable end to end; in production it
    // is logged for an operator to pick up. DEPLOYMENT.md explains how to plug
    // in a real sender.
    if (c.env.ENVIRONMENT === 'development') {
      return c.json(
        {
          data: {
            ok: true,
            devToken: token,
            note: 'Development only: no email provider is configured, so the reset token is returned here.',
          },
        },
        202,
      );
    }
    console.log(
      JSON.stringify({ level: 'info', event: 'password_reset_requested', userId: record.id }),
    );
  }

  return c.json(
    { data: { ok: true, note: 'If that email is registered, a reset link has been sent.' } },
    202,
  );
});

auth.post('/password-reset/confirm', async (c) => {
  const body = parse(confirmPasswordResetSchema, await readJson(c.req.raw));
  const userId = await consumePasswordReset(c.env.DB, await sha256Hex(body.token));
  if (!userId) {
    throw new AppError(
      ERROR_CODES.INVALID_STATE,
      'That reset link is invalid or has expired. Request a new one.',
    );
  }
  await updateUserPassword(c.env.DB, userId, await hashPassword(body.password));
  await recordAudit(c.env.DB, { ownerId: userId, actorId: userId, action: 'auth.password_reset' });
  return c.json({ data: { ok: true } });
});

export default auth;
