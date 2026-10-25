import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decryptSecret,
  encryptSecret,
  hashPassword,
  looksLikeApiKey,
  maskSecret,
  randomId,
  signToken,
  timingSafeEqual,
  verifyPassword,
  verifyToken,
} from '../crypto';
import { createApiKeySchema, updateApiKeySchema } from '../schemas';

/**
 * These tests cover the two things that must never silently regress: password
 * verification and the encryption envelope that protects user API keys.
 */

const KEY_A = bytesToBase64(new Uint8Array(32).fill(7));
const KEY_B = bytesToBase64(new Uint8Array(32).fill(9));

describe('password hashing', () => {
  it('produces a salted, self-describing hash', async () => {
    const hash = await hashPassword('correct horse battery');
    const parts = hash.split('$');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('sha256');
    expect(Number(parts[2])).toBeGreaterThanOrEqual(100_000);
    // Salt is random per hash.
    const second = await hashPassword('correct horse battery');
    expect(second).not.toBe(hash);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterY', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('anything', 'garbage')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'pbkdf2$sha256$x$y$z')).resolves.toBe(false);
  });

  it('refuses to hash a too-short password', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 8/);
  });
});

describe('session tokens', () => {
  const secret = 'test-secret-value-please-rotate';

  it('round-trips a payload', async () => {
    const token = await signToken({ sub: 'user-1', email: 'a@b.c', role: 'owner' }, secret);
    const result = await verifyToken(token, secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user-1');
      expect(result.payload.role).toBe('owner');
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signToken({ sub: 'user-1', email: 'a@b.c', role: 'owner' }, secret);
    const result = await verifyToken(token, 'another-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a tampered payload', async () => {
    const token = await signToken({ sub: 'user-1', email: 'a@b.c', role: 'owner' }, secret);
    const [header, , signature] = token.split('.');
    const forgedClaims = Buffer.from(
      JSON.stringify({
        sub: 'admin',
        email: 'x@y.z',
        role: 'admin',
        iat: 0,
        exp: 9999999999,
        jti: 'x',
      }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = await verifyToken(`${header}.${forgedClaims}.${signature}`, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', async () => {
    const token = await signToken(
      { sub: 'user-1', email: 'a@b.c', role: 'owner', ttlSeconds: 60 },
      secret,
      Date.now() - 120_000,
    );
    const result = await verifyToken(token, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects a malformed token', async () => {
    const result = await verifyToken('not.a.token', secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });
});

describe('provider key encryption', () => {
  it('round-trips a secret', async () => {
    const plaintext = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
    const envelope = await encryptSecret(plaintext, KEY_A);

    // The envelope must not contain the plaintext anywhere.
    expect(envelope).not.toContain(plaintext);
    expect(envelope.startsWith('v1.')).toBe(true);

    await expect(decryptSecret(envelope, KEY_A)).resolves.toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const first = await encryptSecret('same-value-here', KEY_A);
    const second = await encryptSecret('same-value-here', KEY_A);
    expect(first).not.toBe(second);
  });

  it('fails closed when the key has rotated', async () => {
    const envelope = await encryptSecret('sk-proj-abcdefghijklmnopqrstuvwxyz012345', KEY_A);
    await expect(decryptSecret(envelope, KEY_B)).rejects.toThrow();
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    const envelope = await encryptSecret('sk-proj-abcdefghijklmnopqrstuvwxyz012345', KEY_A);
    const [version, iv, cipher] = envelope.split('.');
    const tampered = `${version}.${iv}.${cipher!.slice(0, -4)}AAAA`;
    await expect(decryptSecret(tampered, KEY_A)).rejects.toThrow();
  });

  it('rejects a key that is not exactly 32 bytes', async () => {
    const shortKey = bytesToBase64(new Uint8Array(16).fill(1));
    await expect(encryptSecret('x', shortKey)).rejects.toThrow(/32 bytes/);
  });

  it('rejects an unknown envelope version', async () => {
    await expect(decryptSecret('v9.a.b', KEY_A)).rejects.toThrow(/version/i);
  });
});

describe('masking', () => {
  it('never reveals more than the last four characters', () => {
    const masked = maskSecret('sk-proj-abcdefghijklmnop');
    expect(masked.endsWith('mnop')).toBe(true);
    expect(masked.replace(/•/g, '')).toHaveLength(4);
  });

  it('fully masks short values', () => {
    expect(maskSecret('abcdef')).toBe('••••••');
    expect(maskSecret('')).toBe('');
  });
});

describe('looksLikeApiKey', () => {
  it('accepts realistic shapes and rejects obvious typos', () => {
    expect(looksLikeApiKey('sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeApiKey('AIzaSyD-1234567890abcdefghijklmnop')).toBe(true);
    expect(looksLikeApiKey('too-short')).toBe(false);
    expect(looksLikeApiKey('has spaces in it 1234567890')).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('a'.repeat(600))).toBe(false);
  });
});

describe('helpers', () => {
  it('compares strings in constant time without false positives', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
  });

  it('round-trips base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('api key schema', () => {
  it('rejects values that are too short or contain whitespace', () => {
    expect(createApiKeySchema.safeParse({ provider: 'openai', value: 'short' }).success).toBe(
      false,
    );
    expect(
      createApiKeySchema.safeParse({ provider: 'openai', value: 'has a space in it 12345' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(
      createApiKeySchema.safeParse({ provider: 'not-a-provider', value: 'sk-1234567890abcdef' })
        .success,
    ).toBe(false);
  });

  it('accepts a valid provider and key', () => {
    const result = createApiKeySchema.safeParse({
      provider: 'openai',
      value: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      label: 'personal',
    });
    expect(result.success).toBe(true);
  });

  it('allows a label-only update', () => {
    expect(updateApiKeySchema.safeParse({ label: 'renamed' }).success).toBe(true);
    expect(updateApiKeySchema.safeParse({ value: 'short' }).success).toBe(false);
  });
});
