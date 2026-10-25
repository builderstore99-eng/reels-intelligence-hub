# API reference

Base path: `/api/v1`. All responses are JSON.

Two envelopes:

```jsonc
// success
{ "data": <payload>, "meta": { ... } }

// failure
{ "error": { "code": "...", "message": "...", "retryable": false, "requestId": "...", "details": {} } }
```

Authentication: `Authorization: Bearer <token>` (returned by register/login) **or** the `rih_session` cookie. Every route below `/api/v1` except `health`, `auth/register`, `auth/login`, `auth/logout`, `auth/session`, `auth/password-reset/*` and `integrations/instagram/callback` requires authentication.

---

## Health

### `GET /health`

No auth. Returns 200 when `DB`, `AUTH_SECRET` and `SECRETS_ENCRYPTION_KEY` are present, 503 otherwise.

```json
{
  "data": {
    "status": "ok",
    "environment": "production",
    "time": "2026-10-25T10:00:00.000Z",
    "missing": []
  }
}
```

---

## Auth

| Method | Path                           | Body                               | Notes                                                                   |
| ------ | ------------------------------ | ---------------------------------- | ----------------------------------------------------------------------- |
| POST   | `/auth/register`               | `{ email, password, displayName }` | 201. Returns `{ user, token }`. Password min 10 chars.                  |
| POST   | `/auth/login`                  | `{ email, password }`              | Returns `{ user, token }`. Rate-limited per account after failures.     |
| POST   | `/auth/logout`                 | —                                  | Clears the cookie.                                                      |
| GET    | `/auth/session`                | —                                  | Returns the current user, or 401.                                       |
| POST   | `/auth/password-reset/request` | `{ email }`                        | Always 202 (no account enumeration). In development returns `devToken`. |
| POST   | `/auth/password-reset/confirm` | `{ token, password }`              | 400 `INVALID_STATE` when the token is expired or used.                  |

---

## Dashboard

### `GET /dashboard`

Everything the dashboard needs, in one round trip.

```json
{
  "data": {
    "metrics": {
      "totalDiscovered": 0,
      "totalAnalyzed": 0,
      "collections": 0,
      "pendingJobs": 0,
      "failedJobs": 0,
      "storageBytes": 0,
      "aiCostUsd": 0,
      "aiCalls": 0
    },
    "collections": [],
    "jobs": [],
    "items": [],
    "events": [],
    "conversations": []
  }
}
```

`storageBytes` is `0` until R2 object sizes are listed — see README § Known limitations.

---

## Collections

| Method | Path                                                                              | Notes                                                                                                                    |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/collections?status=&type=&search=&page=&pageSize=`                              | Paginated list with live item counts.                                                                                    |
| POST   | `/collections`                                                                    | `{ name, description?, collectionType?, sourceIdentifier?, settings? }` → 201. 409 `DUPLICATE_RESOURCE` on a name clash. |
| GET    | `/collections/:id`                                                                | 404 for another user's id.                                                                                               |
| PATCH  | `/collections/:id`                                                                | `{ name?, description?, status?, settings? }`                                                                            |
| DELETE | `/collections/:id`                                                                | Cascades items, jobs, conversations.                                                                                     |
| POST   | `/collections/:id/duplicate`                                                      | Copies the collection and its memberships.                                                                               |
| GET    | `/collections/:id/items?sort=&creator=&contentType=&status=&tag=&page=&pageSize=` | Each item includes `summary` and `tags`.                                                                                 |
| DELETE | `/collections/:id/items/:itemId`                                                  | Removes membership; the item survives.                                                                                   |
| GET    | `/collections/:id/reports`                                                        | Report stubs for this collection.                                                                                        |

`collectionType`: `instagram_profile | topic_research | design_references | manual | document_library | custom`.

---

## Research

| Method | Path                        | Body                                                                 | Notes                                                                                          |
| ------ | --------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| POST   | `/research/validate-source` | `{ source }`                                                         | Cheap pre-flight. Returns `{ valid, kind, canonicalUrl, username, message }`. Creates nothing. |
| GET    | `/research/readiness`       | —                                                                    | `{ instagramConfigured, demoEnabled, aiConfigured, summary }`                                  |
| GET    | `/research/providers`       | —                                                                    | What each provider supports and does not.                                                      |
| POST   | `/research/profiles`        | `{ source, collectionName?, collectionId?, useDemoData?, options? }` | 201                                                                                            |
| POST   | `/research/designs`         | same as profiles                                                     | 201                                                                                            |
| POST   | `/research/topics`          | `{ query, collectionName?, options? }`                               | 201                                                                                            |
| GET    | `/research/:jobId/status`   | —                                                                    | `{ job, collection, progressPercent }`                                                         |

`options`:

```jsonc
{
  "maxItems": 24, // 1–200
  "summaryDepth": "standard", // brief | standard | deep
  "transcribeAudio": true,
  "analyzeVisuals": true,
  "autoTag": true,
  "skipDuplicates": true,
  "reprocessExisting": false,
}
```

Success response:

```json
{
  "data": {
    "collection": { "id": "...", "name": "@design.inspiration" },
    "job": { "id": "...", "status": "running", "progress": 0 },
    "discovered": 12,
    "skipped": 3,
    "providerUsed": "instagram",
    "warning": null
  }
}
```

`409 CONFLICT` when an active job of the same type already exists for the collection. `403 PROVIDER_NOT_CONFIGURED` / `FORBIDDEN` / `UNSUPPORTED_SOURCE` explain exactly what is missing.

---

## Content

| Method | Path                                                                    | Notes                                             |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------- |
| GET    | `/content?collectionId=&creator=&contentType=&status=&tag=&sort=&page=` | Paginated.                                        |
| GET    | `/content/:id`                                                          | `{ item, collection, summary, transcript, tags }` |
| GET    | `/content/:id/summary`                                                  | Summary or `null`.                                |
| GET    | `/content/:id/transcript`                                               | Transcript or `null`.                             |
| GET    | `/content/:id/tags`                                                     | Normalised tags.                                  |

---

## Jobs

| Method | Path                                | Notes                                     |
| ------ | ----------------------------------- | ----------------------------------------- |
| GET    | `/jobs?status=&collectionId=&page=` | Paginated.                                |
| GET    | `/jobs/monitor`                     | Live counters + the 20 most recent jobs.  |
| GET    | `/jobs/:id`                         | `{ job, items, events }`                  |
| GET    | `/jobs/:id/events`                  | Up to 200 events, newest first.           |
| POST   | `/jobs/:id/pause`                   | Only from `queued` / `running`.           |
| POST   | `/jobs/:id/resume`                  | Only from `paused`.                       |
| POST   | `/jobs/:id/cancel`                  | From `queued` / `running` / `paused`.     |
| POST   | `/jobs/:id/retry`                   | Only from `failed`. Re-arms failed items. |

Any other transition returns `400 INVALID_STATE` with a sentence explaining why.

---

## Search

### `GET /search?q=&mode=&sort=&collectionId=&creator=&contentType=&tag=&status=&page=&pageSize=`

`mode`: `hybrid` (default) | `lexical` | `semantic`. `sort`: `relevance` | `recent` | `oldest`.

```json
{
  "data": [
    {
      "id": "...",
      "score": 0.87,
      "lexicalScore": 4.2,
      "semanticScore": 0.71,
      "excerpt": "...",
      "tags": ["landing-page"],
      "caption": "...",
      "sourceUrl": "..."
    }
  ],
  "meta": {
    "total": 12,
    "semanticAvailable": true,
    "mode": "hybrid",
    "notice": null,
    "indexedItems": 240
  }
}
```

`meta.notice` is non-null when the requested mode was downgraded (for example semantic → lexical because no embedding key is configured).

Also: `GET /search/semantic` (alias forcing semantic mode), `GET /search/suggest?q=` (typeahead over collections, creators and tags).

---

## Chat

| Method | Path                                | Body                                          | Notes                                                                    |
| ------ | ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/chat/conversations?collectionId=` | —                                             | Newest first.                                                            |
| POST   | `/chat/conversations`               | `{ title?, scopeType, collectionId? }`        | 201. `scopeType`: `item \| collection \| collections \| knowledge_base`. |
| GET    | `/chat/conversations/:id`           | —                                             | `{ conversation, messages }`                                             |
| PATCH  | `/chat/conversations/:id`           | `{ title }`                                   | Rename.                                                                  |
| DELETE | `/chat/conversations/:id`           | —                                             | Deletes messages by cascade.                                             |
| POST   | `/chat/conversations/:id/messages`  | `{ content, collectionIds?, contentItemId? }` | Returns both the user message and the answer.                            |

Answer message shape:

```json
{
  "id": "...",
  "role": "assistant",
  "content": "… [1] … [2]",
  "citations": [
    {
      "contentItemId": "...",
      "label": "[1] @creator — reel",
      "url": "https://www.instagram.com/reel/…",
      "excerpt": "…",
      "score": 0.83
    }
  ],
  "modelIdentifier": "gpt-4.1-mini",
  "usage": { "inputTokens": 1820, "outputTokens": 240 }
}
```

When retrieval finds nothing, the answer is a fixed sentence and `citations` is empty — the model is not called.

Not streamed. See README § Known limitations.

---

## Settings

| Method | Path                   | Notes                                                                                          |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/settings`            | Full `SettingsPayload` with `general.displayName` mirrored from the user row.                  |
| PATCH  | `/settings`            | Any subset of `general`, `ai`, `processing`, `storage`, `notifications`. Deep-merged.          |
| GET    | `/settings/providers`  | Provider and model catalogue, with `platformConfigured` per provider.                          |
| GET    | `/settings/health`     | Eight checks: DB, R2, queue, vector, session signing, key encryption, AI providers, Instagram. |
| GET    | `/settings/storage`    | Retention settings and a note on what is stored.                                               |
| POST   | `/settings/data/purge` | `{ confirm: "DELETE ALL RESEARCH" }`. Irreversible.                                            |

### API keys

| Method | Path                                  | Body                          | Notes                                                                                  |
| ------ | ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/settings/api-keys`                  | —                             | One `ApiKeyRecord` per known provider, including `missing` and `fromEnvironment` rows. |
| PUT    | `/settings/api-keys/:provider`        | `{ provider, value, label? }` | Encrypts and stores (upsert). Returns `ApiKeyRecord`.                                  |
| PATCH  | `/settings/api-keys/:provider`        | `{ label? , value? }`         | `value` rotates the key; `label` renames it.                                           |
| DELETE | `/settings/api-keys/:provider`        | —                             | Deletes the ciphertext.                                                                |
| POST   | `/settings/api-keys/:provider/verify` | —                             | One authenticated probe against the provider.                                          |

```json
{
  "data": {
    "id": "…",
    "provider": "openai",
    "label": "personal",
    "maskedPreview": "••••••••4f2a",
    "status": "configured",
    "fromEnvironment": false,
    "lastVerifiedAt": "2026-10-25T09:12:00.000Z",
    "lastUsedAt": "2026-10-25T09:40:00.000Z",
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

Verify response:

```json
{ "data": { "ok": true, "message": "Key accepted by the provider.", "latencyMs": 214 } }
```

`unsupported: true` means no automated probe exists for that provider; the key is stored but unverified.

**There is no endpoint that returns a key.** No request parameter, no response field, no error detail contains one.

---

## Integrations

| Method | Path                               | Notes                                                                                     |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/integrations`                    | `{ accounts, instagramConfigured, redirectUri }`. Never includes tokens.                  |
| POST   | `/integrations/instagram/connect`  | Returns `{ authorizeUrl, state }`.                                                        |
| GET    | `/integrations/instagram/callback` | OAuth redirect target. Validates `state`, exchanges the code, stores the token encrypted. |
| GET    | `/integrations/instagram/status`   | Instagram accounts only.                                                                  |
| POST   | `/integrations/:id/test`           | Refreshes recorded state.                                                                 |
| POST   | `/integrations/:id/reauthorize`    | Marks the account expired so the UI prompts a reconnect.                                  |
| DELETE | `/integrations/:id`                | Deletes the account and its credentials.                                                  |

---

## Usage

| Method | Path             | Notes                                                   |
| ------ | ---------------- | ------------------------------------------------------- |
| GET    | `/usage`         | `{ summary, events }` — the last 100 metered calls.     |
| GET    | `/usage/summary` | Totals, plus breakdowns by provider, operation and day. |

```json
{
  "data": {
    "summary": {
      "totalCostUsd": 0.412,
      "totalCalls": 87,
      "totalInputTokens": 142000,
      "totalOutputTokens": 31000,
      "byProvider": [{ "provider": "openai", "calls": 87, "costUsd": 0.412 }],
      "byOperation": [{ "operation": "text", "calls": 60, "costUsd": 0.31 }],
      "byDay": [{ "day": "2026-10-24", "costUsd": 0.09, "calls": 12 }]
    }
  }
}
```

Costs are **estimates** from published per-unit prices, not billing figures.

---

## Reports

| Method | Path                     | Body                                  | Notes                                                               |
| ------ | ------------------------ | ------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/reports?collectionId=` | —                                     | Stubs, newest first.                                                |
| POST   | `/reports`               | `{ collectionId, question?, title? }` | 201. `400 INVALID_STATE` when the collection has no analysed items. |
| GET    | `/reports/:id`           | —                                     | Full Markdown content plus `sources`.                               |
| DELETE | `/reports/:id`           | —                                     |                                                                     |

Reports are generated only from stored summaries. Every section is asked for against numbered evidence, and the source list is persisted alongside the text.

---

## Schedules

| Method | Path                 | Body                                                                             | Notes                                   |
| ------ | -------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| GET    | `/schedules`         | —                                                                                |                                         |
| POST   | `/schedules`         | `{ collectionId, cadence, cron?, maxItemsPerRun, autoProcess, notify, enabled }` | `cadence`: `daily \| weekly \| custom`. |
| PATCH  | `/schedules/:id`     | `{ enabled }`                                                                    | Pause or resume.                        |
| POST   | `/schedules/:id/run` | —                                                                                | Run immediately.                        |
| DELETE | `/schedules/:id`     | —                                                                                |                                         |

---

## Error codes

| Code                      | HTTP | Retryable | Meaning                                                           |
| ------------------------- | ---- | --------- | ----------------------------------------------------------------- |
| `VALIDATION_FAILED`       | 400  | no        | Bad input; `details.fields` maps field → message.                 |
| `UNSUPPORTED_SOURCE`      | 400  | no        | Not a supported Instagram source, or the provider cannot do this. |
| `INVALID_STATE`           | 400  | no        | The action does not apply to the resource's current state.        |
| `UNAUTHENTICATED`         | 401  | no        | No or invalid token.                                              |
| `INVALID_CREDENTIALS`     | 401  | no        | Wrong email/password.                                             |
| `SESSION_EXPIRED`         | 401  | no        | Token past its `exp`.                                             |
| `FORBIDDEN`               | 403  | no        | Not yours, or the provider refused.                               |
| `PROVIDER_NOT_CONFIGURED` | 403  | no        | No usable key — fix in Settings → API Keys.                       |
| `AUTHORIZATION_EXPIRED`   | 403  | no        | OAuth token expired; reconnect the account.                       |
| `NOT_FOUND`               | 404  | no        | Missing, or not yours.                                            |
| `CONFLICT`                | 409  | no        | An equivalent job or resource is already active.                  |
| `DUPLICATE_RESOURCE`      | 409  | no        | Unique constraint.                                                |
| `RATE_LIMITED`            | 429  | yes       | Back off; `Retry-After` respected where present.                  |
| `INTERNAL_ERROR`          | 500  | yes       | Unexpected. Correlate with `requestId`.                           |
| `DATABASE_ERROR`          | 500  | yes       | D1 failure.                                                       |
| `STORAGE_ERROR`           | 500  | yes       | R2 failure.                                                       |
| `QUEUE_ERROR`             | 500  | yes       | Queue delivery failure.                                           |
| `VECTOR_ERROR`            | 500  | yes       | Vectorize failure.                                                |
| `PROVIDER_UNAVAILABLE`    | 500  | yes       | Provider outage or bad response.                                  |
| `TIMEOUT`                 | 504  | yes       | Provider did not answer in time.                                  |
