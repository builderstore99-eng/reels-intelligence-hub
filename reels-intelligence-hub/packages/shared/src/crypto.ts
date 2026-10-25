/**
 * Cryptography primitives.
 *
 * Everything here runs on the standard Web Crypto API so the exact same code
 * executes in a Cloudflare Worker and in Node 20 (which exposes
 * `globalThis.crypto`). No Node-only `crypto` imports, no native deps.
 *
 * Three distinct jobs, three distinct keys:
 *
 *  1. Password hashing  — PBKDF2-SHA256, per-user random salt. Never reversible.
 *  2. Session tokens    — HMAC-SHA256 signed compact token (AUTH_SECRET).
 *  3. Provider secrets  — AES-256-GCM envelope around user-supplied API keys
 *                         (SECRETS_ENCRYPTION_KEY). This is what makes the
 *                         Settings → API Keys screen safe to store.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ base64 */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** URL-safe random identifier, 16 bytes of entropy by default. */
export function randomId(bytes = 16): string {
  return bytesToBase64Url(randomBytes(bytes));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare a fixed number of bytes so length does not leak via timing.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/* --------------------------------------------------------------- passwords */

/**
 * PBKDF2 iteration count. Higher is better, but Workers bill CPU time and the
 * free tier caps it hard; 100k keeps a login round-trip comfortably inside the
 * request budget while staying far above the 10k OWASP floor for PBKDF2-SHA256
 * used together with a per-user salt.
 */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

export interface PasswordHash {
  /** Encoded as `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`. */
  hash: string;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const salt = randomBytes(16);
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 256);
  return [
    'pbkdf2',
    'sha256',
    String(PBKDF2_ITERATIONS),
    bytesToBase64(salt),
    bytesToBase64(derived),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5) return false;
  const [scheme, digest, iterRaw, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== 'pbkdf2' || digest !== 'sha256') return false;
  const iterations = Number.parseInt(iterRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);
  const derived = await pbkdf2(password, salt, iterations, expected.length * 8);
  return timingSafeEqual(bytesToBase64(derived), bytesToBase64(expected));
}

/* ------------------------------------------------------------------ tokens */

export interface TokenPayload {
  sub: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  /** Issued-at, seconds. */
  iat: number;
  /** Expiry, seconds. */
  exp: number;
  jti: string;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Compact `header.payload.signature` token. Not a full JWT — same shape. */
export async function signToken(
  payload: Omit<TokenPayload, 'iat' | 'exp' | 'jti'> & { ttlSeconds?: number },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const ttl = payload.ttlSeconds ?? 60 * 60 * 24 * 7;
  const body: TokenPayload = {
    sub: payload.sub,
    email: payload.email,
    role: payload.role,
    iat,
    exp: iat + ttl,
    jti: randomId(12),
  };
  const header = bytesToBase64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = bytesToBase64Url(enc.encode(JSON.stringify(body)));
  const signingInput = `${header}.${claims}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export async function verifyToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, claims, signature] = parts as [string, string, string];

  let expectedSig: Uint8Array;
  try {
    expectedSig = base64UrlToBytes(signature);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    expectedSig as unknown as BufferSource,
    enc.encode(`${header}.${claims}`),
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(dec.decode(base64UrlToBytes(claims))) as TokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

/* --------------------------------------------------------- provider secrets */

/**
 * AES-256-GCM.
 *
 * Stored format: `v1.<ivB64>.<ciphertextB64>` where ciphertext includes the
 * GCM authentication tag. The version prefix means a future key-rotation
 * scheme can decrypt old rows while writing new ones with `v2.`.
 */
const SECRET_VERSION = 'v1';

async function aesKey(rawKeyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawKeyB64);
  if (raw.length !== 32) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256). Generate one with: openssl rand -base64 32',
    );
  }
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    enc.encode(plaintext),
  );
  return `${SECRET_VERSION}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

/**
 * Throws when the payload was tampered with or the key has rotated. Callers
 * must treat that as "key unavailable — ask the user to re-enter it", never as
 * "key is empty".
 */
export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== SECRET_VERSION) {
    throw new Error('Unsupported secret envelope version.');
  }
  const [, ivB64, cipherB64] = parts as [string, string, string];
  const key = await aesKey(keyB64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) as unknown as BufferSource },
    key,
    base64ToBytes(cipherB64) as unknown as BufferSource,
  );
  return dec.decode(plain);
}

/* ------------------------------------------------------------------ masking */

/**
 * Mask a secret for display. Never returns enough characters to reconstruct
 * the value: at most the last 4 characters, and only for values long enough
 * that 4 characters is a small fraction of the whole.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length);
  return `${'•'.repeat(8)}${trimmed.slice(-4)}`;
}

/**
 * Cheap structural sanity check before a key is stored, so obvious typos
 * ("sk-", 3 characters) are caught in the UI instead of at first use.
 * This is a shape check, not a validity check — only the provider can do that.
 */
export function looksLikeApiKey(value: string): boolean {
  const v = value.trim();
  if (v.length < 16 || v.length > 512) return false;
  if (/\s/.test(v)) return false;
  return /^[A-Za-z0-9_\-.+/=:]+$/.test(v);
}
