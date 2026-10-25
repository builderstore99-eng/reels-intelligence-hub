# Security

What is protected, how, and where the remaining risk is. Read the last section — it is the important one.

---

## 1. Threat model

The realistic adversaries for this application:

| Adversary                               | Goal                                                    | Primary defence                                                                      |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Another registered user                 | Read someone else's research                            | `owner_id` filter in every query; scope re-checked in SQL before retrieval           |
| Anonymous internet                      | Reach the API                                           | Bearer token / cookie required on every data route                                   |
| Curious user with DevTools              | Obtain a provider API key                               | Keys are never returned by any endpoint; only a masked tail leaves the Worker        |
| Someone with a database dump            | Recover passwords or provider keys                      | PBKDF2 hashes with per-user salt; AES-256-GCM envelopes whose key is a Worker secret |
| Hostile content in a saved caption      | Prompt-inject the assistant into leaking data or acting | System prompt instruction + structural scope enforcement + no-tools design           |
| Someone who finds a reset link in a log | Take over an account                                    | Only the SHA-256 of the reset token is stored; single use; one-hour expiry           |

Out of scope: a compromised Cloudflare account, a compromised operator workstation, and anything that requires the ability to read Worker secrets.

---

## 2. Authentication

**Passwords.** PBKDF2-SHA256, per-user 16-byte random salt, 100 000 iterations, encoded as `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`. Verification is constant-time across a fixed number of bytes, so length does not leak through timing.

100 000 rather than the OWASP-recommended 600 000 is a deliberate, documented trade-off: Workers bill CPU time and the free tier caps it aggressively. Raising `PBKDF2_ITERATIONS` in `packages/shared/src/crypto.ts` is a one-line change with no other consequences.

**Password policy.** Minimum 10 characters, maximum 200, and a rejection list for the handful of passwords in every breach corpus. No character-class requirements — they push people toward `Passw0rd!`.

**Sessions.** HMAC-SHA256 signed compact tokens carrying `sub`, `email`, `role`, `iat`, `exp`, `jti`. Seven-day TTL. Delivered both as a bearer token and as a cookie:

```
rih_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure
```

`HttpOnly` keeps it out of reach of JavaScript; `SameSite=Lax` blocks cross-site form POSTs; `Secure` is added whenever the request arrived over HTTPS. The bearer token exists because a cross-origin frontend (Pages + Workers) cannot rely on cookies — that is an honest trade-off, and the cookie path is preferred when same-origin.

**Password reset.** The token is generated with 24 bytes of entropy, and only its SHA-256 is stored. Single use, one hour. The request endpoint always returns 202, so it cannot be used to enumerate registered emails.

**Registration.** Email uniqueness is enforced by a `UNIQUE` index, and the duplicate case returns `409 DUPLICATE_RESOURCE` rather than revealing whether the address exists in a different form.

---

## 3. Authorisation and tenant isolation

Every user-owned table carries `owner_id`. Every repository method that reads or writes one takes the caller's `user.id` as an argument, and there is no method that accepts a resource id alone.

```ts
// The pattern used throughout:
await getCollection(db, user.id, collectionId); // throws NOT_FOUND for another user
```

Beyond the repositories, two places re-check independently:

- **Search and chat retrieval** filter on `ownerId` inside the Vectorize query (`filter: { ownerId }`), so another tenant's vectors are never scored, and `filterToScope` re-checks candidate ids against `collection_items` in SQL before the prompt is built.
- **Job controls** load the job through `getJob(db, user.id, jobId)` before any transition.

`NOT_FOUND` is returned for resources that exist but belong to someone else. This is intentional: a `403` would confirm the resource exists.

---

## 4. Provider credentials

The single most sensitive thing a user hands this application is an API key, so the read path is narrow by construction.

**Write path**

```
browser → PUT /settings/api-keys/:provider
        → shape check (length, no whitespace, allowed charset)
        → AES-256-GCM(SECRETS_ENCRYPTION_KEY, random 12-byte IV)
        → api_keys.encrypted_value = "v1.<iv>.<ciphertext+tag>"
        → api_keys.masked_preview = "••••••••4f2a"
```

**Read path**

```
repositories/apiKeys.ts  →  SELECT <explicit column list WITHOUT encrypted_value>
                            → toApiKeyRecord()  → browser

services/apiKeys.ts      →  getEncryptedValue()  → decrypt  → provider HTTP call
                            (the only caller; never a route handler)
```

`grep -rn "encrypted_value" apps/api/src` returns exactly three sites: the INSERT, the single SELECT, and nothing else. The migration is the fourth, outside `src`.

**Failure modes, all fail-closed**

| Situation                                 | Behaviour                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Tampered ciphertext                       | GCM authentication fails → key marked `invalid`, error asks for re-entry |
| `SECRETS_ENCRYPTION_KEY` rotated          | Same as above — never a silent fallback to a platform key                |
| Key deleted mid-flight                    | `PROVIDER_NOT_CONFIGURED` with the exact screen to fix                   |
| `SECRETS_ENCRYPTION_KEY` missing entirely | The Settings screen disables saving and says which secret to set         |

**Logging.** Audit rows record `api_key.saved`, `api_key.rotated`, `api_key.deleted` with the provider slug. Never the value, never a prefix, never a length.

---

## 5. Injection

**SQL.** Every statement is parameterised through `db/client.ts`. There is no string interpolation of a value anywhere in the codebase — only of structural fragments (`WHERE` clause lists, `ORDER BY` choices) which are built from a fixed allow-list, never from user input.

**FTS5.** User text becomes an FTS expression only through `toFtsQuery`, which strips every character except `[a-z0-9]`, quotes each token, caps the count at 12, and prefix-matches only the last one. `apps/api/tests/search.test.ts` asserts that hostile input (`"); DROP TABLE content_search; --`) produces only quoted tokens.

**Prompt injection.** Retrieved captions, transcripts and OCR text are untrusted. Three layers:

1. The system prompt states that source text is data, that embedded instructions must be ignored, and that suspicious instructions should be _reported_ rather than followed.
2. The assistant has no tools. It cannot execute anything, read secrets, or call an endpoint, so a successful injection yields text at worst.
3. Scope is enforced before the prompt is built, so even a fully compromised prompt cannot widen retrieval.

**Path traversal.** Uploads, when enabled, use server-generated R2 keys (`<ownerId>/<random>`), never a user-supplied filename.

---

## 6. Input and output validation

- Every request body and query string is parsed with a Zod schema at the route boundary. Failures return `400 VALIDATION_FAILED` with a field → message map.
- External provider responses are parsed into typed shapes and treated as untrusted: a malformed model response raises `PROVIDER_UNAVAILABLE` rather than being persisted.
- The AI summary pipeline requires valid JSON and recovers it from code fences, but never guesses at missing fields — they become `null`.
- Responses never include a stack trace, a provider response body, or an internal identifier. Provider bodies are truncated to 300 characters and kept in server-side logs only.

---

## 7. Secrets management

| Secret                    | Where it lives                                      | Rotating it                                             |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `AUTH_SECRET`             | Worker secret                                       | Invalidates all sessions (users sign in again).         |
| `SECRETS_ENCRYPTION_KEY`  | Worker secret                                       | Invalidates every stored provider key (users re-enter). |
| Provider API keys         | `api_keys` table, AES-GCM                           | Per user, in the app.                                   |
| Instagram app credentials | Worker secret                                       | Requires reconnecting accounts.                         |
| OAuth access tokens       | `connected_accounts.encrypted_credentials`, AES-GCM | Per account, via reconnect.                             |

`.env.example` contains placeholder names only. `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `.dev.vars`, and `.wrangler/`.

**No credential is ever hardcoded**, in source or in a migration.

---

## 8. Denial of service and rate limits

Two layers:

1. **In-app**, a D1-backed fixed window keyed on `(actor, bucket)`: login failures 10/min, research start 20/min, chat 30/min, API-key writes 20/min, key verification 10/min. Coarse by design — it stops accidental loops, not a determined attacker.
2. **Cloudflare rate-limiting rules** in front of `/api/v1/auth/`, `/api/v1/chat/` and `/api/v1/research/`. `DEPLOYMENT.md` § 8 has the exact configuration. This is the layer that matters for hostile traffic.

Bounded work everywhere else: 50 MB media ceiling, 200 items per run, 12 000-character transcript slice per summary, 8 000-character embedding input, 3000-token report cap, 90-second transcription poll budget, `max_retries = 3` with a dead-letter queue.

---

## 9. Platform limits and lawful access

The Instagram integration is written to respect the platform rather than work around it:

- Only official OAuth and the Graph API. No scraping, no session-cookie reuse, no password collection.
- No account rotation, ever. `grep -ri "rotate" apps/api/src` returns nothing about accounts.
- A `403` produces a clear "the account may be private, or permissions may not cover it" — it is never retried with different credentials.
- `Retry-After` is honoured, and rate limits pause the job rather than increasing pressure.
- Media retention is opt-in (`storage.keepOriginalMedia`, default off). Source links and derived text are always kept.

---

## 10. What is _not_ protected

Stated plainly, because a security document that only lists strengths is a marketing document.

1. **No CSRF token.** `SameSite=Lax` blocks cross-site form POSTs and the API requires `content-type: application/json`, which a simple form POST cannot send. That is adequate for the current design but is not a substitute for a CSRF token if cookie auth is ever extended to `SameSite=None`.
2. **Bearer tokens in `localStorage`.** The cross-origin deployment mode stores the token in `localStorage`, which is readable by any XSS on the origin. Same-origin (cookie-only) is the safer configuration and is the recommended deployment.
3. **No 2FA.** Not implemented.
4. **No audit UI.** `audit_events` is written but only readable in the database.
5. **Rate limiting is coarse.** Per-account, not per-IP, and stored in D1. A distributed attacker is Cloudflare's problem, not this Worker's.
6. **The in-memory OAuth `state` map** lives in a Worker isolate. A cold start between `connect` and `callback` loses the state and the user sees "that authorisation link has expired". It fails safe, but it is a correctness wart; a D1 or KV-backed state store would fix it.
7. **Dependency scanning is not wired up.** No Dependabot config, no `npm audit` in CI.
8. **The suite has not been run against live infrastructure.** Security properties are asserted at the unit level (crypto, token handling, FTS sanitisation) but the D1 query layer has not been exercised end to end in this repository.

---

## 11. Reporting a problem

This repository ships without a security contact. Before publishing, add one here — a `SECURITY.md` with no address is worse than none, because it implies a channel that does not exist.
