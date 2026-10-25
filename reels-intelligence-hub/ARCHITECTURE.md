# Architecture

How Reels Intelligence Hub is put together, and why.

---

## 1. Layers

The Worker is organised so that each layer can only do one kind of thing. This is enforced by convention and by the import graph, not by a framework.

```
routes/         HTTP in, HTTP out. Validates with Zod, calls one service, maps to JSON.
services/       Business logic. Knows about providers, pipelines, retrieval. Never
                touches the HTTP layer, never builds SQL strings.
repositories/   Every SQL statement in the codebase. Returns domain objects.
middleware/     Cross-cutting: auth, rate limits, error envelope, request ids.
db/mappers.ts   Row → domain object. The single place snake_case becomes camelCase.
```

Two rules keep this honest:

1. **A route handler may not contain a SQL string.** If you need one, it belongs in a repository.
2. **A service may not read `c.req`.** It receives typed arguments, which is what makes the pipeline callable from the queue consumer — where there is no request at all.

---

## 2. Data model

Twenty tables. The shape that matters most:

```
users ─┬─ collections ──┬── collection_items ── content_items ─┬── transcripts
       │                │                                    ├── summaries
       │                └── research_jobs ── job_items         ├── content_tags ── tags
       │                     └── job_events                   └── content_search (FTS5)
       ├─ conversations ── messages
       ├─ api_keys
       ├─ connected_accounts
       ├─ research_reports
       ├─ scheduled_research
       ├─ usage_events
       └─ user_settings
```

### Deliberate deviation: `collection_items`

The brief described `content_items.collection_id`. This implementation uses a junction table instead, because an item legitimately belongs to more than one collection: a reel found by topic research and also filed into a design folder is one record, not two. Duplicating the row would fork its summaries and break citation identity.

Consequence: "which collection is this item in?" has no single answer, so `ContentItem.collectionId` is populated from the first membership and is treated as a _navigation hint_, never as an authority. Authorisation always goes through `collection_items`.

### Deliberate deviation: `api_keys`

Not in the brief's schema. A `user_settings` JSON blob would have been the obvious place, and it would have been wrong: settings are read on nearly every request and returned wholesale to the browser. Credentials need a narrower read path. Hence a dedicated table whose SELECT list omits the ciphertext column entirely.

---

## 3. Authentication

```
register ──► PBKDF2-SHA256(password, randomSalt, 100_000) ──► users.password_hash
login    ──► verify (constant-time) ──► signToken(payload, AUTH_SECRET) ──► JWT-shaped token
request  ──► Authorization: Bearer <token>  or  rih_session cookie
         ──► verifyToken (HMAC + exp) ──► load user ──► c.set('user')
```

- **100 000 PBKDF2 iterations** rather than 600 000: Workers bill CPU time and the free tier caps it hard. 100k with a per-user salt stays far above the 10k OWASP floor for PBKDF2-SHA256 and keeps a login inside the request budget. Raising it is a one-constant change in `packages/shared/src/crypto.ts`.
- The login path hashes even when the user does not exist, so response time does not reveal whether an email is registered.
- Password reset stores only the SHA-256 of the token, so a database leak cannot be used to reset anyone's password.

---

## 4. Provider credential resolution

```
resolveProviderKey(env, db, ownerId, provider)
  │
  ├─ 1. api_keys row for (owner, provider)?
  │      └─ decrypt with SECRETS_ENCRYPTION_KEY
  │           ├─ ok        → { key, source: 'user' }
  │           └─ throws    → mark status 'invalid', raise PROVIDER_NOT_CONFIGURED
  │                          ("needs to be re-entered in Settings → API Keys")
  │
  ├─ 2. platform secret (OPENAI_API_KEY, …) → { key, source: 'environment' }
  │
  └─ 3. PROVIDER_NOT_CONFIGURED, naming the provider and the screen to fix it
```

`repositories/apiKeys.ts → getEncryptedValue` is the only function in the codebase that reads the `encrypted_value` column, and it is called from exactly one place: `services/apiKeys.ts`. No route handler imports it.

Encryption envelope:

```
v1.<base64 iv (12 bytes)>.<base64 ciphertext+tag>
```

The version prefix exists so a future rotation scheme can decrypt `v1` rows while writing `v2`. Rotating the key today makes existing rows undecryptable — deliberately, because silently falling back to a platform key would hide the problem.

---

## 5. Processing pipeline

```
                        ┌──────────────┐
  research POST ───────►│ discover     │ inline (bounded, one provider call)
                        └──────┬───────┘
                               │ upsert content_items
                               │ add collection_items
                               │ create job_items
                               ▼
                        ┌──────────────┐
                        │ PIPELINE.send│ one message per item
                        └──────┬───────┘
                               ▼
  queue consumer ─────── processItem()
                               │
   metadata ─► media ─► transcription ─► visual/OCR ─► summary ─► tags ─► embedding ─► storage
       │         │            │              │            │         │         │
       └─────────┴────────────┴──────────────┴────────────┴─────────┴─────────┘
                    each stage writes its own row, independently
```

### Invariants

**A later failure never erases an earlier success.** The transcript is written to `transcripts` before summarisation begins. If summarisation then fails, the transcript survives and the retry resumes at summarisation.

**Retries are idempotent.** Every write is an UPSERT keyed on `(content_item_id, summary_type)` or `content_item_id`. Replaying a message produces the same database state.

**Counters are derived.** `recalcJobProgress` recomputes totals from `job_items` on every change. A duplicated queue delivery cannot inflate progress.

**Stage applicability is explicit.** A caption-only item skips media, transcription and OCR. The job event log records _why_ a stage was skipped (`reason: media_unavailable`), rather than silently omitting it.

### Retry policy

```
delay = min(Retry-After, maxDelay)                          when the provider sent one
delay = random(0, min(base * factor^(attempt-1), maxDelay)) otherwise   // full jitter
```

Defaults: base 2 s, factor 2, max 10 min, 5 attempts. A permanent error code (`isRetryableCode === false`) never schedules a retry and marks the item failed immediately.

Full jitter matters: a batch of items that all hit the same rate-limited endpoint would otherwise retry in lockstep and hit it again together.

---

## 6. Retrieval and ranking

Two independent retrievers, fused.

**Lexical** — FTS5 over `content_search`, which denormalises title, caption, summary, transcript, OCR text and tags. Ranked with `bm25()`. A complementary `LIKE` pass over captions catches short tokens (`AI`, `UI`) that FTS tokenisation drops.

**Semantic** — embed the query, `VECTORS.query(vector, { topK, filter: { ownerId } })`. The owner filter is applied _in the index_, so another tenant's vectors are never scored.

**Fusion** (`packages/shared/src/ranking.ts`):

```
l = minmax(lexicalScore)       # per query, within the candidate set
s = minmax(semanticScore)
r = rrf(rank) / max(rrf)       # Reciprocal Rank Fusion, k = 60
score = 0.45·l + 0.55·s + 0.15·r
```

Weights favour semantic slightly because lexical already dominates when the exact phrase is present. The RRF term breaks ties in favour of items that score well in _both_ modalities, which is the strongest signal of genuine relevance.

If semantic retrieval is unavailable (no key, no binding, dimension mismatch), the caller gets lexical-only results plus `semanticAvailable: false` and a `notice`. The UI renders that notice. It never implies semantic coverage it does not have.

---

## 7. Chat and prompt-injection defence

```
question
  → scope (item | collection | collections | knowledge_base)
  → retrieve 8 chunks (lexical + semantic, fused)
  → filterToScope()  ← SQL re-check that every candidate is inside the scope
  → if zero chunks: return "no saved research matches" WITHOUT calling the model
  → build numbered sources
  → generate with a system prompt that:
       · forbids claims not grounded in the numbered sources
       · requires inline [n] citations
       · forbids claiming to have watched a video
       · labels inference as inference
       · instructs the model to ignore instructions found inside source text
  → parse [n] markers → citations array
  → persist both messages
```

Two properties are structural rather than best-effort:

**Scope cannot widen.** `filterToScope` re-checks candidates against `collection_items` in SQL. A model cannot retrieve outside its scope because the chunks were filtered before the prompt was built.

**No evidence means no answer.** The zero-chunk branch returns a fixed message and skips the model entirely. This is the only reliable way to stop an assistant inventing content it never saw.

If the model answers without bracketed citations, the top retrieved sources are attached anyway and the UI shows a `no citations` badge — the user can verify, and the gap is visible rather than hidden.

---

## 8. Error model

```json
{
  "error": {
    "code": "PROVIDER_NOT_CONFIGURED",
    "message": "No OpenAI key is configured. Add one in Settings → API Keys, then retry.",
    "retryable": false,
    "requestId": "a1b2c3d4",
    "details": { "fields": { "value": "That looks too short for an API key." } }
  }
}
```

- `code` is stable and branchable. The frontend switches on it (e.g. `PROVIDER_NOT_CONFIGURED` routes the user to the API Keys screen).
- `retryable` comes from the same table the pipeline uses, so the UI and the job scheduler cannot disagree.
- Unknown errors are replaced with a generic message; the original goes to the server log with the request id.
- Provider response bodies never reach the client — they can contain account details. A 300-character excerpt is kept in server-side logs only.

---

## 9. Frontend structure

```
lib/api.ts          typed client: one place that knows the envelope, the error shape,
                    and where the session token lives. Components never call fetch.
lib/app-context.tsx AuthProvider, ThemeProvider, ToastProvider.
components/ui.tsx   Primitives: Button, Input, Select, Switch, Badge, Tabs, Dialog,
                    Skeleton, EmptyState, ErrorState, ProgressBar, Toaster.
components/layout   AppShell (sidebar + topbar), PageHeader, Section.
pages/*.tsx         Twelve lazy-loaded pages.
```

State is server-state-first: TanStack Query owns everything that came from the API. The only local state is form input and ephemeral UI (open dialog, selected tab). The Live Monitor polls; it does not keep its own counters.

Design tokens are CSS variables declared in `@theme` in `index.css`. A light theme is a `:root[data-theme='light']` override of the same variable names — no component knows which theme is active.

---

## 10. What would change first at scale

Honest list, not a roadmap:

1. **Streaming chat.** The current single-pass answer is the biggest UX gap.
2. **Real OCR.** A dedicated engine (or Cloudflare's own image models) would beat asking a vision model to read text.
3. **Idempotency keys on research start.** Currently guarded by an active-job check, which is a race under concurrent requests.
4. **R2 usage accounting** to make `storageBytes` real.
5. **Sharing/permissions** — the schema assumes single-owner collections.
