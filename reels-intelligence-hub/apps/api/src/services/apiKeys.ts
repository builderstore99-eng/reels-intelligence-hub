import {
  AppError,
  ERROR_CODES,
  decryptSecret,
  encryptSecret,
  getProvider,
  looksLikeApiKey,
  maskSecret,
  PROVIDERS,
  type ApiKeyRecord,
} from '@rih/shared';
import type { Env } from '../env.js';
import { envKeyForProvider, requireSecret } from '../env.js';
import {
  deleteApiKey,
  findApiKey,
  getEncryptedValue,
  listApiKeys,
  markApiKeyUsed,
  setApiKeyStatus,
  updateApiKeyLabel,
  upsertApiKey,
} from '../repositories/apiKeys.js';

/**
 * Provider credential management.
 *
 * This module is the single gateway between "a key the user pasted into
 * Settings → API Keys" and "a call to a provider". Nothing else in the codebase
 * may read a credential.
 *
 * Resolution order for every provider call:
 *   1. the user's own stored key (encrypted at rest, decrypted here only),
 *   2. the platform-wide env secret, if the operator supplied one,
 *   3. a PROVIDER_NOT_CONFIGURED error that names the exact screen to fix.
 *
 * That order is deliberate: a user who brings their own key gets their own
 * quota and their own bill, and an operator can still make the app work
 * out-of-the-box for everyone.
 */

export type KeySource = 'user' | 'environment';

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

export async function resolveProviderKey(
  env: Env,
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<ResolvedKey> {
  // 1. User-supplied key.
  const encrypted = await getEncryptedValue(db, ownerId, provider);
  if (encrypted) {
    const encryptionKey = requireSecret(env, 'SECRETS_ENCRYPTION_KEY');
    try {
      const plaintext = await decryptSecret(encrypted, encryptionKey);
      if (plaintext.trim().length > 0) {
        await markApiKeyUsed(db, ownerId, provider);
        return { key: plaintext, source: 'user' };
      }
    } catch {
      // Tampered ciphertext, or the operator rotated SECRETS_ENCRYPTION_KEY.
      // Either way the stored value is unusable — mark it so the UI tells the
      // user to re-enter it rather than silently falling back.
      await setApiKeyStatus(db, ownerId, provider, 'invalid');
      throw new AppError(
        ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        `Your ${getProvider(provider)?.label ?? provider} key could not be decrypted — it needs to be re-entered in Settings → API Keys.`,
      );
    }
  }

  // 2. Platform-wide secret.
  const envKey = envKeyForProvider(env, provider);
  if (envKey && envKey.trim().length > 0) {
    return { key: envKey, source: 'environment' };
  }

  // 3. Nothing available.
  const definition = getProvider(provider);
  throw new AppError(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    definition
      ? `No ${definition.label} key is configured. Add one in Settings → API Keys, then retry.`
      : `No credentials are configured for "${provider}". Add one in Settings → API Keys.`,
  );
}

/** Whether a usable credential exists, without decrypting or returning it. */
export async function hasProviderKey(
  env: Env,
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<boolean> {
  const stored = await findApiKey(db, ownerId, provider);
  if (stored && stored.status !== 'invalid') return true;
  return Boolean(envKeyForProvider(env, provider));
}

/* -------------------------------------------------------------- listing --- */

/**
 * The API Keys screen shows every known provider, whether or not the user has
 * configured it, so the UI can render "Not configured / Add key" rows without a
 * second round trip.
 */
export async function listProviderKeys(
  env: Env,
  db: D1Database,
  ownerId: string,
): Promise<ApiKeyRecord[]> {
  const stored = await listApiKeys(db, ownerId);
  const byProvider = new Map(stored.map((record) => [record.provider, record]));

  return PROVIDERS.map((definition) => {
    const record = byProvider.get(definition.slug);
    const envConfigured = Boolean(envKeyForProvider(env, definition.slug));

    if (record) {
      return {
        ...record,
        // A user key always wins, even when an env key also exists — say so
        // explicitly instead of pretending the env key is in play.
        fromEnvironment: false,
      };
    }

    if (envConfigured) {
      return {
        id: `env:${definition.slug}`,
        provider: definition.slug,
        label: 'Platform key',
        maskedPreview: '••••••••env',
        status: 'configured',
        fromEnvironment: true,
        lastVerifiedAt: null,
        lastUsedAt: null,
        createdAt: '',
        updatedAt: '',
      };
    }

    return {
      id: `missing:${definition.slug}`,
      provider: definition.slug,
      label: '',
      maskedPreview: '',
      status: 'missing',
      fromEnvironment: false,
      lastVerifiedAt: null,
      lastUsedAt: null,
      createdAt: '',
      updatedAt: '',
    };
  });
}

/* ---------------------------------------------------------------- write --- */

export async function saveProviderKey(
  env: Env,
  db: D1Database,
  ownerId: string,
  input: { provider: string; value: string; label?: string },
): Promise<ApiKeyRecord> {
  const definition = getProvider(input.provider);
  if (!definition) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Unknown provider.');
  }

  const value = input.value.trim();
  if (!looksLikeApiKey(value)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `That does not look like a ${definition.label} key. ${definition.keyHint}.`,
    );
  }

  const encryptionKey = requireSecret(env, 'SECRETS_ENCRYPTION_KEY');
  const encryptedValue = await encryptSecret(value, encryptionKey);

  await upsertApiKey(db, {
    ownerId,
    provider: input.provider,
    label: input.label?.trim() || definition.label,
    encryptedValue,
    // Only the masked tail is ever stored in plaintext, and it is derived here
    // so no other code path can accidentally persist more than that.
    maskedPreview: maskSecret(value),
    status: 'unverified',
  });

  const record = await findApiKey(db, ownerId, input.provider);
  if (!record) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'The key was saved but could not be read back.');
  }
  return record;
}

export async function renameProviderKey(
  db: D1Database,
  ownerId: string,
  provider: string,
  label: string,
): Promise<void> {
  const existing = await findApiKey(db, ownerId, provider);
  if (!existing) throw new AppError(ERROR_CODES.NOT_FOUND, 'No key is stored for that provider.');
  await updateApiKeyLabel(db, ownerId, provider, label);
}

export async function removeProviderKey(
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<void> {
  await deleteApiKey(db, ownerId, provider);
}

/* ---------------------------------------------------------------- verify -- */

export interface VerifyResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  /** True when the provider has no cheap authenticated probe implemented. */
  unsupported?: boolean;
}

/**
 * Actively test a credential.
 *
 * This makes one small authenticated request to a read-only endpoint. It is the
 * only way to distinguish "the key is stored" from "the key works", and it is
 * what the Test button in Settings reports. Network failures are reported as
 * such — never as success.
 */
export async function verifyProviderKey(
  env: Env,
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<VerifyResult> {
  const started = Date.now();
  let resolved: ResolvedKey;

  try {
    resolved = await resolveProviderKey(env, db, ownerId, provider);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof AppError ? error.message : 'No usable key was found.',
      latencyMs: Date.now() - started,
    };
  }

  const probe = probeFor(provider, resolved.key);
  if (!probe) {
    return {
      ok: false,
      unsupported: true,
      message:
        'No automated verification is available for this provider. The key is stored and will be used on the next call.',
      latencyMs: Date.now() - started,
    };
  }

  let response: Response;
  try {
    response = await fetch(probe.url, { method: 'GET', headers: probe.headers });
  } catch {
    return {
      ok: false,
      message: 'Could not reach the provider from this Worker. Check the network and try again.',
      latencyMs: Date.now() - started,
    };
  }

  const latencyMs = Date.now() - started;

  if (response.ok) {
    // Only user-owned rows get a status update; env keys are the operator's.
    if (resolved.source === 'user') {
      await setApiKeyStatus(db, ownerId, provider, 'configured', { verified: true });
    }
    return { ok: true, message: 'Key accepted by the provider.', latencyMs };
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    if (resolved.source === 'user') {
      await setApiKeyStatus(db, ownerId, provider, 'invalid', { verified: true });
    }
    return {
      ok: false,
      message: `The provider rejected this key (HTTP ${status}). It may be revoked, expired, or missing a required permission.`,
      latencyMs,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      message:
        'The provider rate-limited the check (HTTP 429). The key may still be valid — try again shortly.',
      latencyMs,
    };
  }

  return {
    ok: false,
    message: `The provider returned HTTP ${status} for the verification request.`,
    latencyMs,
  };
}

interface Probe {
  url: string;
  headers: Record<string, string>;
}

function probeFor(provider: string, key: string): Probe | null {
  switch (provider) {
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${key}` },
      };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      };
    case 'google-ai':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        headers: {},
      };
    case 'assemblyai':
      return {
        url: 'https://api.assemblyai.com/v2/transcript?limit=1',
        headers: { authorization: key },
      };
    default:
      return null;
  }
}
