import { Hono } from 'hono';
import {
  AppError,
  ERROR_CODES,
  PROVIDERS,
  MODELS,
  createApiKeySchema,
  getProvider,
  settingsSchema,
  updateApiKeySchema,
} from '@rih/shared';
import type { AppEnv } from '../env.js';
import { describeConfig } from '../env.js';
import { parse, readJson } from '../middleware/validate.js';
import { currentUser, enforceRateLimit, requireAuth } from '../middleware/auth.js';
import { getSettings, saveSettings, recordAudit, listUsage } from '../repositories/misc.js';
import { updateUserProfile } from '../repositories/users.js';
import {
  listProviderKeys,
  removeProviderKey,
  renameProviderKey,
  saveProviderKey,
  verifyProviderKey,
} from '../services/apiKeys.js';
import { researchReadiness } from '../services/research.js';
import { run } from '../db/client.js';

const settings = new Hono<AppEnv>();
settings.use('*', requireAuth);

/* ------------------------------------------------------------- preferences */

settings.get('/', async (c) => {
  const user = currentUser(c);
  const payload = await getSettings(c.env.DB, user.id);
  return c.json({
    data: {
      ...payload,
      // The display name lives on the user row, not in settings JSON, so keep
      // the single source of truth and mirror it into the payload.
      general: { ...payload.general, displayName: user.displayName },
    },
  });
});

settings.patch('/', async (c) => {
  const user = currentUser(c);
  const body = parse(settingsSchema, await readJson(c.req.raw));

  if (body.general?.displayName) {
    await updateUserProfile(c.env.DB, user.id, { displayName: body.general.displayName });
  }

  const saved = await saveSettings(c.env.DB, user.id, body);
  await recordAudit(c.env.DB, {
    ownerId: user.id,
    actorId: user.id,
    action: 'settings.updated',
    metadata: { sections: Object.keys(body) },
  });

  return c.json({ data: saved });
});

/** Provider + model catalogue for the Settings → AI and API Keys screens. */
settings.get('/providers', (c) => {
  const config = describeConfig(c.env);
  return c.json({
    data: {
      providers: PROVIDERS.map((provider) => ({
        ...provider,
        platformConfigured:
          Boolean(config.providers[provider.slug]) ||
          (provider.slug === 'cloudflare' && config.bindings.ai),
      })),
      models: MODELS,
    },
  });
});

/* ----------------------------------------------------------------- health */

settings.get('/health', async (c) => {
  const user = currentUser(c);
  const config = describeConfig(c.env);
  const userSettings = await getSettings(c.env.DB, user.id);
  const readiness = await researchReadiness(c.env, c.env.DB, user.id, userSettings);
  const keys = await listProviderKeys(c.env, c.env.DB, user.id);

  const checks = [
    {
      name: 'Database',
      status: config.bindings.db ? ('ok' as const) : ('unavailable' as const),
      detail: config.bindings.db
        ? 'D1 binding present.'
        : 'The DB binding is missing from wrangler.toml.',
    },
    {
      name: 'Object storage',
      status: config.bindings.media ? ('ok' as const) : ('not_configured' as const),
      detail: config.bindings.media
        ? 'R2 binding present.'
        : 'No R2 bucket is bound; exports and uploads are disabled.',
    },
    {
      name: 'Processing queue',
      status: config.bindings.pipeline ? ('ok' as const) : ('not_configured' as const),
      detail: config.bindings.pipeline
        ? 'Queue producer bound.'
        : 'No queue is bound, so background processing cannot start.',
    },
    {
      name: 'Vector index',
      status: config.bindings.vectors ? ('ok' as const) : ('not_configured' as const),
      detail: config.bindings.vectors
        ? 'Vectorize binding present.'
        : 'No Vectorize index is bound; semantic search falls back to keyword search.',
    },
    {
      name: 'Frontend assets',
      status: config.bindings.assets ? ('ok' as const) : ('not_configured' as const),
      detail: config.bindings.assets
        ? 'The built SPA is served by this Worker, same-origin as the API.'
        : 'No assets binding — the API works, but the UI must be served separately. Run npm run build:web and redeploy.',
    },
    {
      name: 'Session signing',
      status: config.authSecret ? ('ok' as const) : ('unavailable' as const),
      detail: config.authSecret
        ? 'AUTH_SECRET is set.'
        : 'AUTH_SECRET is missing — authentication cannot work.',
    },
    {
      name: 'Key encryption',
      status: config.encryptionKey ? ('ok' as const) : ('unavailable' as const),
      detail: config.encryptionKey
        ? 'SECRETS_ENCRYPTION_KEY is set; API keys can be stored.'
        : 'SECRETS_ENCRYPTION_KEY is missing — the API Keys screen cannot save anything.',
    },
    {
      name: 'AI providers',
      status: readiness.aiConfigured ? ('ok' as const) : ('not_configured' as const),
      detail: readiness.summary,
    },
    {
      name: 'Instagram',
      status: config.instagram ? ('ok' as const) : ('not_configured' as const),
      detail: config.instagram
        ? 'Instagram app credentials are set. Connect an account on Connected Accounts.'
        : 'INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are not set.',
    },
  ];

  return c.json({
    data: {
      environment: c.env.ENVIRONMENT,
      demoMode: config.bindings.db && c.env.ENABLE_DEMO_MODE === 'true',
      checks,
      configuredProviders: keys.filter((k) => k.status !== 'missing').map((k) => k.provider),
    },
  });
});

/* ---------------------------------------------------------------- api keys */

/**
 * Settings → API Keys.
 *
 * The response shape is `ApiKeyRecord[]`, which has no field capable of holding
 * a secret. `maskedPreview` is the last four characters; that is all the browser
 * ever sees of a stored key.
 */
settings.get('/api-keys', async (c) => {
  const user = currentUser(c);
  const keys = await listProviderKeys(c.env, c.env.DB, user.id);
  return c.json({ data: keys });
});

settings.put('/api-keys/:provider', async (c) => {
  const user = currentUser(c);
  await enforceRateLimit(c.env, user.id, 'api-key-write', 20);

  const provider = c.req.param('provider');
  const raw = (await readJson(c.req.raw)) as Record<string, unknown>;
  const body = parse(createApiKeySchema, { ...raw, provider });

  const record = await saveProviderKey(c.env, c.env.DB, user.id, {
    provider,
    value: body.value,
    ...(body.label ? { label: body.label } : {}),
  });

  // Audit without the value: we record that a key changed and for which
  // provider, never any part of the key itself.
  await recordAudit(c.env.DB, {
    ownerId: user.id,
    actorId: user.id,
    action: 'api_key.saved',
    targetType: 'provider',
    targetId: provider,
  });

  return c.json({ data: record }, 201);
});

settings.patch('/api-keys/:provider', async (c) => {
  const user = currentUser(c);
  const body = parse(updateApiKeySchema, await readJson(c.req.raw));
  const provider = c.req.param('provider');

  if (body.value) {
    // A new value means a rotation: re-encrypt, reset verification state.
    const record = await saveProviderKey(c.env, c.env.DB, user.id, {
      provider,
      value: body.value,
      ...(body.label ? { label: body.label } : {}),
    });
    await recordAudit(c.env.DB, {
      ownerId: user.id,
      actorId: user.id,
      action: 'api_key.rotated',
      targetType: 'provider',
      targetId: provider,
    });
    return c.json({ data: record });
  }

  if (body.label !== undefined) {
    await renameProviderKey(c.env.DB, user.id, provider, body.label);
  }

  const keys = await listProviderKeys(c.env, c.env.DB, user.id);
  const updated = keys.find((key) => key.provider === provider);
  if (!updated) throw new AppError(ERROR_CODES.NOT_FOUND, 'No key is stored for that provider.');
  return c.json({ data: updated });
});

settings.delete('/api-keys/:provider', async (c) => {
  const user = currentUser(c);
  const provider = c.req.param('provider');
  await removeProviderKey(c.env.DB, user.id, provider);
  await recordAudit(c.env.DB, {
    ownerId: user.id,
    actorId: user.id,
    action: 'api_key.deleted',
    targetType: 'provider',
    targetId: provider,
  });
  return c.json({ data: { ok: true, provider } });
});

settings.post('/api-keys/:provider/verify', async (c) => {
  const user = currentUser(c);
  await enforceRateLimit(c.env, user.id, 'api-key-verify', 10);

  const provider = c.req.param('provider');
  if (!getProvider(provider)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Unknown provider.');
  }

  const result = await verifyProviderKey(c.env, c.env.DB, user.id, provider);
  return c.json({ data: result });
});

/* ------------------------------------------------------- storage & deletion */

settings.get('/storage', async (c) => {
  const user = currentUser(c);
  const settingsPayload = await getSettings(c.env.DB, user.id);
  const usage = await listUsage(c.env.DB, user.id, 1);

  return c.json({
    data: {
      retentionDays: settingsPayload.storage.retentionDays,
      keepOriginalMedia: settingsPayload.storage.keepOriginalMedia,
      // Object counts come from R2 only when a listing has been performed; we
      // report what we can actually observe rather than a guess.
      recentUsageEvents: usage.length,
      note: 'Media files are only stored when a connected account permits retention. Deleting a collection removes its items and their derived text.',
    },
  });
});

/**
 * Delete all research data for the account.
 *
 * Destructive and irreversible, so it requires an explicit confirmation string
 * in the body. This is the data-deletion workflow required by the security
 * brief, and it is the user's own data only.
 */
settings.post('/data/purge', async (c) => {
  const user = currentUser(c);
  const body = (await readJson(c.req.raw)) as { confirm?: string };

  if (body.confirm !== 'DELETE ALL RESEARCH') {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Type "DELETE ALL RESEARCH" to confirm. Nothing was deleted.',
    );
  }

  await run(c.env.DB, 'DELETE FROM collections WHERE owner_id = ?', [user.id]);
  await run(c.env.DB, 'DELETE FROM content_items WHERE owner_id = ?', [user.id]);
  await run(c.env.DB, 'DELETE FROM tags WHERE owner_id = ?', [user.id]);
  await run(c.env.DB, 'DELETE FROM conversations WHERE owner_id = ?', [user.id]);
  await run(c.env.DB, 'DELETE FROM research_reports WHERE owner_id = ?', [user.id]);
  await run(c.env.DB, 'DELETE FROM scheduled_research WHERE owner_id = ?', [user.id]);
  await run(c.env.DB, 'DELETE FROM usage_events WHERE owner_id = ?', [user.id]);

  await recordAudit(c.env.DB, {
    ownerId: user.id,
    actorId: user.id,
    action: 'data.purged',
  });

  return c.json({ data: { ok: true } });
});

export default settings;
