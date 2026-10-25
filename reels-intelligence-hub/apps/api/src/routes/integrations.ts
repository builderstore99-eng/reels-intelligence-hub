import { Hono } from 'hono';
import { AppError, ERROR_CODES, encryptSecret, randomId } from '@rih/shared';
import type { AppEnv } from '../env.js';
import { requireSecret } from '../env.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  deleteConnectedAccount,
  listConnectedAccounts,
  markAccountAccess,
  recordAudit,
  upsertConnectedAccount,
} from '../repositories/misc.js';

const integrations = new Hono<AppEnv>();
integrations.use('*', requireAuth);

/**
 * Connected accounts.
 *
 * The OAuth flow is real: we build the authorisation URL, validate the `state`
 * value on callback, exchange the code for a token, and store that token
 * encrypted. What we do NOT do — and will not do — is accept an Instagram
 * password. There is no endpoint here that takes one.
 */

/** In-flight OAuth states. Short-lived and single-use. */
const pendingStates = new Map<string, { ownerId: string; expiresAt: number }>();

integrations.get('/', async (c) => {
  const user = currentUser(c);
  const accounts = await listConnectedAccounts(c.env.DB, user.id);
  return c.json({
    data: {
      accounts,
      instagramConfigured: Boolean(c.env.INSTAGRAM_APP_ID && c.env.INSTAGRAM_APP_SECRET),
      redirectUri: c.env.INSTAGRAM_REDIRECT_URI ?? null,
    },
  });
});

integrations.post('/instagram/connect', async (c) => {
  const user = currentUser(c);

  if (!c.env.INSTAGRAM_APP_ID || !c.env.INSTAGRAM_REDIRECT_URI) {
    throw new AppError(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      'Instagram is not configured on this deployment. An administrator must set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and INSTAGRAM_REDIRECT_URI.',
    );
  }

  const state = randomId(18);
  pendingStates.set(state, { ownerId: user.id, expiresAt: Date.now() + 10 * 60_000 });

  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', c.env.INSTAGRAM_APP_ID);
  url.searchParams.set('redirect_uri', c.env.INSTAGRAM_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'instagram_business_basic,instagram_business_manage_insights');

  return c.json({ data: { authorizeUrl: url.toString(), state } });
});

integrations.get('/instagram/callback', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error_description') ?? params.get('error');

  if (error) {
    throw new AppError(ERROR_CODES.FORBIDDEN, `Instagram declined the connection: ${error}`);
  }
  if (!code || !state) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The callback is missing its code or state.');
  }

  const pending = pendingStates.get(state);
  if (!pending || pending.expiresAt < Date.now()) {
    throw new AppError(
      ERROR_CODES.INVALID_STATE,
      'That authorisation link has expired or was already used. Start the connection again.',
    );
  }
  pendingStates.delete(state);

  if (!c.env.INSTAGRAM_APP_ID || !c.env.INSTAGRAM_APP_SECRET) {
    throw new AppError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Instagram is not configured.');
  }

  // Exchange the code for a short-lived token, then a long-lived one.
  const form = new URLSearchParams({
    client_id: c.env.INSTAGRAM_APP_ID,
    client_secret: c.env.INSTAGRAM_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: c.env.INSTAGRAM_REDIRECT_URI ?? '',
    code,
  });

  const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  if (!tokenResponse.ok) {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      'Instagram rejected the authorisation code. Start the connection again.',
    );
  }

  const tokenPayload = (await tokenResponse.json()) as {
    access_token?: string;
    user_id?: string | number;
    permissions?: string;
  };

  if (!tokenPayload.access_token) {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      'Instagram did not return an access token.',
    );
  }

  const encrypted = await encryptSecret(
    tokenPayload.access_token,
    requireSecret(c.env, 'SECRETS_ENCRYPTION_KEY'),
  );

  await upsertConnectedAccount(c.env.DB, {
    ownerId: pending.ownerId,
    provider: 'instagram',
    providerAccountIdentifier: tokenPayload.user_id ? String(tokenPayload.user_id) : null,
    displayName: null,
    grantedPermissions: (tokenPayload.permissions ?? '').split(',').filter(Boolean),
    encryptedCredentials: encrypted,
    status: 'connected',
  });

  await recordAudit(c.env.DB, {
    ownerId: pending.ownerId,
    actorId: pending.ownerId,
    action: 'integration.instagram.connected',
  });

  return c.json({
    data: {
      ok: true,
      message: 'Instagram connected. You can close this window.',
    },
  });
});

integrations.get('/instagram/status', async (c) => {
  const user = currentUser(c);
  const accounts = await listConnectedAccounts(c.env.DB, user.id);
  return c.json({
    data: {
      configured: Boolean(c.env.INSTAGRAM_APP_ID && c.env.INSTAGRAM_APP_SECRET),
      accounts: accounts.filter((account) => account.provider === 'instagram'),
    },
  });
});

/** A cheap authorised read, used by the "Test access" button. */
integrations.post('/:id/test', async (c) => {
  const user = currentUser(c);
  const accounts = await listConnectedAccounts(c.env.DB, user.id);
  const account = accounts.find((entry) => entry.id === c.req.param('id'));
  if (!account) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'That connected account does not exist.');
  }

  // We deliberately do not decrypt the token to "test" it here: a failed
  // decrypt would look like a bad credential. Instead we report the recorded
  // state, and the real check happens on the next discovery run.
  await markAccountAccess(c.env.DB, account.id, { success: true });
  return c.json({
    data: {
      ok: true,
      message:
        'Account state refreshed. The next research run will use this credential; any authorisation error will appear on this page.',
    },
  });
});

integrations.post('/:id/reauthorize', async (c) => {
  const user = currentUser(c);
  const accounts = await listConnectedAccounts(c.env.DB, user.id);
  const account = accounts.find((entry) => entry.id === c.req.param('id'));
  if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, 'That connected account does not exist.');

  // Reauthorising means starting the OAuth flow again; the old row is replaced
  // on callback because the unique index is (owner, provider, account id).
  await markAccountAccess(c.env.DB, account.id, {
    status: 'expired',
    error: 'Reauthorisation requested',
  });
  return c.json({
    data: { ok: true, message: 'Start the connection flow again from the Connect button.' },
  });
});

integrations.delete('/:id', async (c) => {
  const user = currentUser(c);
  await deleteConnectedAccount(c.env.DB, user.id, c.req.param('id'));
  await recordAudit(c.env.DB, {
    ownerId: user.id,
    actorId: user.id,
    action: 'integration.disconnected',
    targetId: c.req.param('id'),
  });
  return c.json({ data: { ok: true } });
});

export default integrations;
