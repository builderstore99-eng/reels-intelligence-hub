import { AppError, ERROR_CODES, randomId, type ApiKeyStatus } from '@rih/shared';
import { all, first, nowIso, run } from '../db/client.js';
import { toApiKeyRecord } from '../db/mappers.js';

/**
 * API keys repository.
 *
 * The security-critical detail: `listApiKeys` selects an explicit column list
 * that does not include `encrypted_value`. The only function that reads
 * ciphertext is `getEncryptedValue`, and it is called from exactly one place
 * (`services/apiKeys.ts → resolveProviderKey`), never from a route handler.
 * Grep for `encrypted_value` in this repo and you will find it in three spots:
 * this file's INSERT/UPDATE, this file's single SELECT, and the migration.
 */

const PUBLIC_COLUMNS = `id, owner_id, provider, label, masked_preview, key_version, status,
  last_verified_at, last_used_at, created_at, updated_at`;

export async function listApiKeys(db: D1Database, ownerId: string) {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE owner_id = ? ORDER BY provider`,
    [ownerId],
  );
  return rows.map((row) => toApiKeyRecord(row));
}

export async function findApiKey(db: D1Database, ownerId: string, provider: string) {
  const row = await first<Record<string, unknown>>(
    db,
    `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE owner_id = ? AND provider = ?`,
    [ownerId, provider],
  );
  return row ? toApiKeyRecord(row) : null;
}

/**
 * Create or replace the key for a provider. Replacing is intentional: a user
 * has exactly one active credential per provider, so "rotate" is an upsert and
 * there is never an ambiguous "which key did it use?" question in the logs.
 */
export async function upsertApiKey(
  db: D1Database,
  input: {
    ownerId: string;
    provider: string;
    label: string;
    encryptedValue: string;
    maskedPreview: string;
    status?: ApiKeyStatus;
  },
): Promise<void> {
  const now = nowIso();
  const existing = await first<{ id: string }>(
    db,
    'SELECT id FROM api_keys WHERE owner_id = ? AND provider = ?',
    [input.ownerId, input.provider],
  );

  if (existing) {
    await run(
      db,
      `UPDATE api_keys
          SET label = ?, encrypted_value = ?, masked_preview = ?, key_version = 1,
              status = ?, last_verified_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ?`,
      [
        input.label,
        input.encryptedValue,
        input.maskedPreview,
        input.status ?? 'unverified',
        now,
        existing.id,
        input.ownerId,
      ],
    );
    return;
  }

  await run(
    db,
    `INSERT INTO api_keys
       (id, owner_id, provider, label, encrypted_value, masked_preview, key_version,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      randomId(),
      input.ownerId,
      input.provider,
      input.label,
      input.encryptedValue,
      input.maskedPreview,
      input.status ?? 'unverified',
      now,
      now,
    ],
  );
}

export async function updateApiKeyLabel(
  db: D1Database,
  ownerId: string,
  provider: string,
  label: string,
): Promise<void> {
  await run(
    db,
    'UPDATE api_keys SET label = ?, updated_at = ? WHERE owner_id = ? AND provider = ?',
    [label, nowIso(), ownerId, provider],
  );
}

export async function deleteApiKey(
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<void> {
  const result = await run(db, 'DELETE FROM api_keys WHERE owner_id = ? AND provider = ?', [
    ownerId,
    provider,
  ]);
  if (result.changes === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'No key is stored for that provider.');
  }
}

/**
 * Read the ciphertext envelope for one provider.
 *
 * @internal — the caller must be `services/apiKeys.ts`. Do not call this from a
 * route handler: the return value is the only thing in the system that can be
 * decrypted back into a live credential.
 */
export async function getEncryptedValue(
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<string | null> {
  const row = await first<{ encrypted_value: string }>(
    db,
    'SELECT encrypted_value FROM api_keys WHERE owner_id = ? AND provider = ?',
    [ownerId, provider],
  );
  return row?.encrypted_value ?? null;
}

export async function setApiKeyStatus(
  db: D1Database,
  ownerId: string,
  provider: string,
  status: ApiKeyStatus,
  options?: { verified?: boolean },
): Promise<void> {
  const now = nowIso();
  if (options?.verified) {
    await run(
      db,
      'UPDATE api_keys SET status = ?, last_verified_at = ?, updated_at = ? WHERE owner_id = ? AND provider = ?',
      [status, now, now, ownerId, provider],
    );
  } else {
    await run(
      db,
      'UPDATE api_keys SET status = ?, updated_at = ? WHERE owner_id = ? AND provider = ?',
      [status, now, ownerId, provider],
    );
  }
}

export async function markApiKeyUsed(
  db: D1Database,
  ownerId: string,
  provider: string,
): Promise<void> {
  await run(db, 'UPDATE api_keys SET last_used_at = ? WHERE owner_id = ? AND provider = ?', [
    nowIso(),
    ownerId,
    provider,
  ]);
}
