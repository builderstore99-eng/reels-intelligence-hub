import { AppError, ERROR_CODES, type User } from '@rih/shared';
import { first, nowIso, run } from '../db/client.js';
import { toUser } from '../db/mappers.js';
import { randomId } from '@rih/shared';

/** Users repository. Password material never leaves this module. */

export interface UserRowWithHash extends User {
  passwordHash: string;
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRowWithHash | null> {
  const row = await first<Record<string, unknown>>(db, 'SELECT * FROM users WHERE email = ?', [
    email.toLowerCase(),
  ]);
  if (!row) return null;
  return { ...toUser(row), passwordHash: String(row['password_hash'] ?? '') };
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await first<Record<string, unknown>>(db, 'SELECT * FROM users WHERE id = ?', [id]);
  return row ? toUser(row) : null;
}

export async function createUser(
  db: D1Database,
  input: { email: string; displayName: string; passwordHash: string },
): Promise<User> {
  const existing = await first<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', [
    input.email,
  ]);
  if (existing) {
    throw new AppError(
      ERROR_CODES.DUPLICATE_RESOURCE,
      'An account with that email already exists.',
    );
  }

  const id = randomId();
  const now = nowIso();
  await run(
    db,
    `INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'owner', ?, ?)`,
    [id, input.email.toLowerCase(), input.displayName, input.passwordHash, now, now],
  );

  // Every user gets a settings row up front so the settings page never has to
  // handle "no settings yet".
  await run(
    db,
    'INSERT OR IGNORE INTO user_settings (owner_id, settings_json, updated_at) VALUES (?, ?, ?)',
    [id, '{}', now],
  );

  return {
    id,
    email: input.email.toLowerCase(),
    displayName: input.displayName,
    role: 'owner',
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  patch: { displayName?: string },
): Promise<void> {
  if (patch.displayName === undefined) return;
  await run(db, 'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [
    patch.displayName,
    nowIso(),
    userId,
  ]);
}

export async function updateUserPassword(
  db: D1Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    passwordHash,
    nowIso(),
    userId,
  ]);
}

/* -------------------------------------------------------- password resets */

export async function createPasswordReset(
  db: D1Database,
  userId: string,
  tokenHash: string,
  expiresAt: string,
): Promise<void> {
  await run(
    db,
    'INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [randomId(), userId, tokenHash, expiresAt, nowIso()],
  );
}

export async function consumePasswordReset(
  db: D1Database,
  tokenHash: string,
): Promise<string | null> {
  const row = await first<{
    id: string;
    user_id: string;
    expires_at: string;
    used_at: string | null;
  }>(db, 'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?', [
    tokenHash,
  ]);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  await run(db, 'UPDATE password_resets SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
  return row.user_id;
}
