# Reels Intelligence Hub

**AI-powered Instagram research and knowledge platform.** Discover content, extract knowledge, and build a searchable research library you can talk to — with citations on every claim.

Built as a Cloudflare-native application: React + TypeScript on the front, Hono on Workers, D1 for relational data, R2 for files, Queues for background processing, Vectorize for semantic search, Workers AI as one of several model providers.

> **Status: functional, not production-hardened.** The application builds, type-checks, lints and passes its 79-test suite; the Worker bundles for deployment. It has **not** been run against a live D1 instance, a live queue, or a live Instagram account in this repository — see [Known limitations](#known-limitations) for exactly what that means. Nothing in this README claims otherwise.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Feature list](#feature-list)
- [Settings → API Keys](#settings--api-keys)
- [Prerequisites](#prerequisites)
- [Project structure](#project-structure)
- [Installation](#installation)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Cloudflare configuration](#cloudflare-configuration)
- [Database setup](#database-setup)
- [Instagram authorisation setup](#instagram-authorisation-setup)
- [AI provider setup](#ai-provider-setup)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Security considerations](#security-considerations)
- [Known limitations](#known-limitations)

---

## What it does

Three research workflows feed one knowledge base:

**Reels research.** Give a profile URL, an `@handle`, or a single post/reel link. The app discovers accessible media, transcribes audio, analyses visuals, summarises, tags, embeds, and files everything into a collection named after the profile.

**Design and document research.** The same pipeline, tuned for images, carousels and video frames: dominant palette, layout type, visual hierarchy, composition, CTA placement, and OCR text. Observed characteristics are stored separately from the model's interpretation.

**Topic research.** Describe what you want to learn. The active discovery provider searches what it is _permitted_ to search, results are scored and de-duplicated, and you choose what to analyse.

Every collection has its own library, search and AI chat. There is also a global search and a knowledge-base-wide chat.

The through-line is honesty about evidence: answers cite the items they came from, or state plainly that the saved research does not contain the answer. No fabricated content, no invented statistics, no claiming to have watched a video.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser — React 18 + TypeScript + Vite + Tailwind v4                │
│  TanStack Query · React Router · React Hook Form · Zod · Recharts    │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ /api/v1/*  (JSON, bearer token or cookie)
┌───────────────────────────▼──────────────────────────────────────────┐
│  Cloudflare Worker — Hono                                            │
│                                                                      │
│  routes/        thin HTTP layer, Zod validation, no business logic   │
│  services/      research · pipeline · ai · search · chat · reports   │
│                 apiKeys · dashboard                                  │
│  repositories/  every SQL statement in the codebase                  │
│  middleware/    auth, rate limiting, error envelope                  │
└──┬───────────┬───────────┬────────────┬──────────────┬───────────────┘
   │           │           │            │              │
┌──▼───┐  ┌────▼────┐ ┌────▼─────┐ ┌────▼──────┐ ┌─────▼──────┐
│ D1   │  │ R2      │ │ Queues   │ │ Vectorize │ │ Workers AI │
│ rows │  │ media   │ │ pipeline │ │ 768-dim   │ │ + 3 APIs   │
└──────┘  └─────────┘ └────┬─────┘ └───────────┘ └────────────┘
                           │ process_item
                    ┌──────▼──────────────────────────────┐
                    │ pipeline stages (each persisted)    │
                    │ metadata → media → transcription →  │
                    │ visual → summary → tags → embedding │
                    │ → storage                           │
                    └─────────────────────────────────────┘
```

Full detail, including the retrieval ranking method and the job state machine, is in [ARCHITECTURE.md](./ARCHITECTURE.md).

### Design decisions worth knowing

| Decision                                                                   | Why                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collection_items` junction table instead of `content_items.collection_id` | One item can belong to several collections (a reel found by topic search, also filed into a design folder) without duplicating the record. This is a deliberate deviation from the flat schema in the brief. |
| Job counters derived, never incremented                                    | A duplicated queue delivery or a retry cannot inflate progress. `recalcJobProgress` recomputes from `job_items` every time.                                                                                  |
| Every stage persisted independently                                        | A failed embedding does not erase a successful transcript or summary. Retries resume at the failed stage.                                                                                                    |
| Provider credentials resolved through one function                         | `resolveProviderKey` is the only place a key is decrypted. User key → platform secret → a clear error naming Settings → API Keys.                                                                            |
| Scope enforced in SQL, not in the UI                                       | Chat and search always carry `owner_id = ?` and a collection filter. Cross-tenant retrieval is impossible by construction.                                                                                   |

---

## Feature list

**Research**

- Profile, single-post, design and topic research
- Live source validation with a specific reason when a source is unsupported
- Configurable depth, transcription, visual analysis, auto-tagging, duplicate handling
- Duplicate detection on a stable source identifier, with an explicit "reprocess" opt-in

**Processing**

- Asynchronous queue pipeline with ten stages
- Bounded exponential backoff with full jitter; `Retry-After` honoured
- Permanent failures stop retrying; completed work is preserved
- Every stage and every retry recorded as a job event

**Knowledge**

- Collections with grid/list views, eight tabs, duplicate, archive, delete
- Hybrid search: FTS5 bm25 + Vectorize cosine, min-max normalised and fused 0.45/0.55 with an RRF tie-breaker
- Retrieval-augmented chat with per-answer citations and an explicit "no evidence" response
- Research reports generated only from stored summaries, with linked sources
- Tag normalisation so `Lead-Gen`, `lead gen` and `#LeadGen` collapse into one tag

**Operations**

- Live monitor with real persisted counters, per-job pause/resume/cancel/retry
- Usage and cost estimates per call, per provider, per day
- Scheduled research via Cron Triggers
- Connected accounts with real OAuth, encrypted tokens, and honest capability documentation

**Interface**

- Twelve navigation destinations, all functional
- Dark and light themes from one token set
- Skeleton, empty and error states on every data surface
- Toasts, dialogs, confirmations, responsive layout from 360px up

---

## Settings → API Keys

This is the screen for supplying your own provider credentials.

**How it works**

1. Every supported provider appears as a row, whether or not you have configured it: OpenAI, Anthropic, Google AI, AssemblyAI, Instagram Graph, Cloudflare Workers AI.
2. Paste a key and save. It is validated for _shape_ on both client and server (length, no whitespace, allowed character set), then encrypted with **AES-256-GCM** using `SECRETS_ENCRYPTION_KEY`, which exists only as a Worker secret.
3. The database stores `v1.<iv>.<ciphertext>`. The only plaintext derived from your key is `maskedPreview` — the last four characters, for display.
4. **Test** makes one small authenticated request to a read-only provider endpoint and reports the real result: accepted, rejected, rate-limited, or "no automated check exists for this provider". The stored status updates accordingly.
5. **Replace** rotates the key in place (one active key per provider per user). **Delete** removes the ciphertext immediately.

**What the browser can never see**

The API response type is `ApiKeyRecord`, which has no field capable of holding a key:

```ts
interface ApiKeyRecord {
  id: string;
  provider: string;
  label: string;
  maskedPreview: string; // ••••••••4f2a
  status: 'configured' | 'unverified' | 'invalid' | 'missing';
  fromEnvironment: boolean;
  lastVerifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

`grep -r encrypted_value apps/api/src` returns three sites: the INSERT, the single SELECT in `repositories/apiKeys.ts`, and the migration. Nothing else reads ciphertext.

**Resolution order at call time**

```
user's stored key (decrypted in the Worker, only for the owning account)
  └─ falls back to → platform env secret (OPENAI_API_KEY, …)
       └─ falls back to → PROVIDER_NOT_CONFIGURED, naming the exact screen to fix
```

So a user who brings their own key gets their own quota and their own bill, and an operator can still make the app work out of the box for everyone.

**Rotating `SECRETS_ENCRYPTION_KEY`** makes every stored key undecryptable — by design. The UI then shows those rows as `invalid` and asks for re-entry rather than silently falling back to a platform key.

---

## Prerequisites

- Node.js **20** or newer (`node --version`)
- npm 10+
- A Cloudflare account with Workers, D1, R2, Queues and Vectorize available
- `wrangler` (installed as a dev dependency; use `npx wrangler`)
- Optional: an Instagram app from Meta (for real discovery), and at least one AI provider key

---

## Project structure

```
reels-intelligence-hub/
├── apps/
│   ├── api/                        Cloudflare Worker
│   │   ├── migrations/0001_init.sql
│   │   ├── src/
│   │   │   ├── index.ts            fetch / queue / scheduled entry points
│   │   │   ├── env.ts              bindings, secrets, config status
│   │   │   ├── middleware/         auth, rate limiting, validation, errors
│   │   │   ├── repositories/       all SQL
│   │   │   ├── routes/             HTTP layer
│   │   │   └── services/           business logic
│   │   ├── tests/
│   │   └── wrangler.toml
│   └── web/                        React application
│       └── src/
│           ├── components/         UI primitives, layout, shared cards
│           ├── lib/                api client, contexts
│           └── pages/              twelve pages
├── packages/shared/                types, Zod schemas, pure utilities
│   └── src/__tests__/
├── scripts/provision-cloudflare.sh one-command Cloudflare provisioning + deploy
├── docs/                           manual QA checklist
├── ARCHITECTURE.md  API.md  DEPLOYMENT.md  SECURITY.md
├── .env.example
└── package.json                    npm workspaces
```

---

## Installation

```bash
git clone <your-repo-url> reels-intelligence-hub
cd reels-intelligence-hub
npm install
```

---

## Local development

Two processes: the Worker and the Vite dev server. Vite proxies `/api` to the Worker, so the browser sees one origin.

```bash
# 1. Local secrets for the Worker
cp .env.example apps/api/.dev.vars
#    then fill in AUTH_SECRET and SECRETS_ENCRYPTION_KEY (see below)

# 2. Generate the two required secrets
openssl rand -base64 48   # → AUTH_SECRET
openssl rand -base64 32   # → SECRETS_ENCRYPTION_KEY

# 3. Create the local database and apply migrations
npx wrangler d1 create rih-db          # copy the database_id into wrangler.toml
npm run db:migrate:local

# 4. Terminal A — the Worker on :8787
npm run dev:api

# 5. Terminal B — the frontend on :5173
npm run dev
```

Open <http://localhost:5173>, register an account, then add a provider key in **Settings → API Keys**.

To see the pipeline work end to end without Instagram credentials, set `ENABLE_DEMO_MODE = "true"` in `wrangler.toml` (it is already `true` under `[env.dev.vars]`) and tick **Use demo data** on the Reels Search page. Demo records are marked `source_provider = "demo"`, point at `example.com`, and render a **DEMO** badge — they can never be mistaken for collected Instagram content.

---

## Environment variables

Frontend (compiled into the bundle — never put secrets here):

| Variable            | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `VITE_API_BASE_URL` | API origin. Empty means same-origin (recommended in production). |

Worker secrets (`wrangler secret put <NAME>`):

| Variable                 | Required      | Purpose                                                            |
| ------------------------ | ------------- | ------------------------------------------------------------------ |
| `AUTH_SECRET`            | **yes**       | HMAC key that signs session tokens. 32+ bytes.                     |
| `SECRETS_ENCRYPTION_KEY` | **yes**       | 32-byte base64 key for AES-256-GCM. Encrypts stored provider keys. |
| `OPENAI_API_KEY`         | no            | Platform-wide OpenAI key (text, vision, embeddings, Whisper).      |
| `ANTHROPIC_API_KEY`      | no            | Platform-wide Anthropic key.                                       |
| `GOOGLE_AI_API_KEY`      | no            | Platform-wide Google AI key.                                       |
| `ASSEMBLYAI_API_KEY`     | no            | Platform-wide transcription key.                                   |
| `INSTAGRAM_APP_ID`       | for discovery | Meta app id.                                                       |
| `INSTAGRAM_APP_SECRET`   | for discovery | Meta app secret.                                                   |
| `INSTAGRAM_REDIRECT_URI` | for discovery | Must match the callback registered with Meta exactly.              |

Worker vars (`[vars]` in `wrangler.toml`, not secret):

| Variable                 | Purpose                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`            | `production` / `development`. Development returns password-reset tokens in the response body. |
| `ALLOWED_ORIGINS`        | Comma-separated CORS allow-list.                                                              |
| `ENABLE_TRANSCRIPTION`   | Feature switch for the transcription stage.                                                   |
| `ENABLE_VISUAL_ANALYSIS` | Feature switch for the vision stage.                                                          |
| `ENABLE_SEMANTIC_SEARCH` | Feature switch for embeddings + Vectorize.                                                    |
| `ENABLE_DEMO_MODE`       | Enables the clearly-labelled synthetic provider. Keep `false` in production.                  |

---

## Cloudflare configuration

`apps/api/wrangler.toml` declares every binding. Replace the `REPLACE_WITH_*` placeholders with values from your own account — they are resource identifiers, not secrets, but they are per-account, so a fresh clone must run the setup commands first.

| Binding    | Type                         | Used for                                           |
| ---------- | ---------------------------- | -------------------------------------------------- |
| `DB`       | D1                           | All relational data                                |
| `MEDIA`    | R2                           | Uploaded documents, exports, permitted media       |
| `PIPELINE` | Queue producer + consumer    | Per-item processing                                |
| `VECTORS`  | Vectorize (768 dims, cosine) | Semantic retrieval                                 |
| `AI`       | Workers AI                   | Fallback text and embedding models with no API key |

A dead-letter queue (`rih-pipeline-dlq`) is configured with `max_retries = 3`, so a poison message cannot loop forever.

A Cron Trigger (`0 3 * * *`) fires daily. It re-queues due retries and enqueues scheduled research — it never processes content itself, so a slow run cannot exhaust the cron CPU budget.

---

## Database setup

```bash
# Create (once) and copy database_id into wrangler.toml
npx wrangler d1 create rih-db

# Local
npm run db:migrate:local

# Production
npm run db:migrate:remote
```

`apps/api/migrations/0001_init.sql` creates 20 tables, 30+ indexes, an FTS5 virtual table (`content_search`) with triggers, and the `api_keys` table with its AES envelope columns. Read it — it is commented line by line, including the deliberate schema deviation noted above.

---

## Instagram authorisation setup

1. Create an app at <https://developers.facebook.com/apps> with the Instagram product.
2. Add the OAuth redirect URI. It must match `INSTAGRAM_REDIRECT_URI` character for character:
   `https://<your-worker-domain>/api/v1/integrations/instagram/callback`
3. Set the secrets:
   ```bash
   npx wrangler secret put INSTAGRAM_APP_ID --config apps/api/wrangler.toml
   npx wrangler secret put INSTAGRAM_APP_SECRET --config apps/api/wrangler.toml
   npx wrangler secret put INSTAGRAM_REDIRECT_URI --config apps/api/wrangler.toml
   ```
4. In the app, go to **Connected Accounts → Connect Instagram**. You will be sent to Instagram's own consent screen.

**What the integration can and cannot do** — the UI repeats this verbatim, because promising more would be a lie:

| Can                                                                 | Cannot                                             |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Read media for accounts that authorised this app (Business/Creator) | Read arbitrary personal accounts                   |
| Read public Business/Creator media via Business Discovery           | Read private accounts                              |
| Read a single post/reel by shortcode when permitted                 | Keyword-search Instagram (no such endpoint exists) |

There is **no endpoint that accepts an Instagram password**, and no account rotation anywhere in the codebase.

---

## AI provider setup

Two options, and they can coexist:

1. **Per user, in the app** — Settings → API Keys. This is the intended path: each user brings their own key, gets their own quota, pays their own bill.
2. **Platform-wide, as Worker secrets** — `npx wrangler secret put OPENAI_API_KEY`. Useful for a shared deployment where the operator supplies the models.

Model selection lives in Settings → AI and is capability-checked: a model is only used for a capability it declares. Changing the embedding model invalidates the Vectorize index (dimensions must stay at 768).

---

## Testing

```bash
npm test              # 79 unit tests
npm run typecheck     # all workspaces, strict mode
npm run lint          # ESLint, zero warnings tolerated
npm run build         # web build + worker dry-run bundle
```

The automated suite covers: Instagram URL normalisation and rejection, tag normalisation, retry backoff and `Retry-After` parsing, cost estimation, hybrid ranking, password hashing and verification, session token signing/expiry/tampering, the AES-GCM envelope (including rotation and tamper failures), secret masking, API-key schema validation, FTS query sanitisation, and the API-versus-SPA routing split that decides whether a deployed instance serves JSON or HTML.

It deliberately does **not** touch D1, Queues, Vectorize or any live provider — those need credentials and would make the suite slow and flaky. The flows that need them are listed as a manual checklist in [docs/QA-CHECKLIST.md](./docs/QA-CHECKLIST.md).

---

## Deployment

One command provisions everything and deploys:

```bash
npm install
npx wrangler login
npm run setup          # = bash scripts/provision-cloudflare.sh
```

`npm run setup` creates the D1 database, R2 bucket, both queues and the
Vectorize index, writes the database id into `wrangler.toml`, generates and sets
`AUTH_SECRET` and `SECRETS_ENCRYPTION_KEY`, applies migrations, builds the
frontend, type-checks the Worker and deploys it. It is safe to re-run: existing
resources are reused, existing secrets are left alone, and migrations are
idempotent.

The built frontend is uploaded **with** the Worker (`[assets]` in
`wrangler.toml`), so the UI and the API share an origin — no CORS, no separate
Pages project, and the `HttpOnly` session cookie works as designed.

Subsequent deploys, after a code change:

```bash
npm run deploy         # build:web → typecheck → wrangler deploy
```

Full walkthrough, manual steps, custom domains and rollback:
[DEPLOYMENT.md](./DEPLOYMENT.md).

## Troubleshooting

| Symptom                                                                                                  | Cause                                                                                                      | Fix                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET is not configured`                                                                          | Secret missing                                                                                             | `wrangler secret put AUTH_SECRET`                                                                                                                                                                                |
| "The server is not fully configured" on every write                                                      | `SECRETS_ENCRYPTION_KEY` missing                                                                           | Set it; the API Keys screen cannot save without it                                                                                                                                                               |
| API Keys rows show `invalid`                                                                             | Encryption key was rotated                                                                                 | Re-enter each key                                                                                                                                                                                                |
| Chat answers "no saved research matches"                                                                 | Empty scope, or no analysed items                                                                          | Save items, wait for processing, or widen the scope                                                                                                                                                              |
| Summaries fail with `PROVIDER_NOT_CONFIGURED`                                                            | No key for the selected model's provider                                                                   | Settings → API Keys, then retry the job                                                                                                                                                                          |
| "Semantic search needs an embedding provider key"                                                        | No embedding key                                                                                           | Keyword search still works; add a key for semantic                                                                                                                                                               |
| Job stuck at `queued`                                                                                    | Queue consumer not deployed or not bound                                                                   | Check `[[queues.consumers]]` and `wrangler tail`                                                                                                                                                                 |
| CORS error in the browser                                                                                | Origin not in `ALLOWED_ORIGINS`                                                                            | Add it to `[vars]` and redeploy                                                                                                                                                                                  |
| `npm install` fails with heap errors in a small container                                                | Node needs address space                                                                                   | `ulimit -v unlimited` before installing                                                                                                                                                                          |
| Cloudflare dashboard upload rejects `wrangler.toml` ("unknown file type")                                | You are uploading the repository to the **static files** panel, which cannot deploy a Worker with bindings | Don't upload the repo. Use `npm run setup`. For a terminal-free route see [DEPLOYMENT.md § 2a](./DEPLOYMENT.md)                                                                                                  |
| "This uploader does not yet support projects that require a build process… Please use `wrangler deploy`" | Same static-files panel, now with a `.js` file in the batch                                                | Cloudflare is telling you to use the CLI. Run `npm run setup`. For a terminal-free route use **Create Worker → Edit code**, not _Upload and deploy_ — see [docs/DASHBOARD-DEPLOY.md](./docs/DASHBOARD-DEPLOY.md) |

---

## Security considerations

The full threat model is in [SECURITY.md](./SECURITY.md). The headlines:

- Passwords are PBKDF2-SHA256 with a per-user salt; plaintext never touches the database.
- Sessions are HMAC-signed tokens, `HttpOnly` + `SameSite=Lax` cookies when same-origin.
- Every user-owned query filters on `owner_id` in SQL.
- Provider keys are AES-256-GCM encrypted; no endpoint can return one.
- All SQL is parameterised — there is no string interpolation of values anywhere.
- Retrieved content is treated as untrusted: the chat system prompt explicitly instructs the model to ignore embedded instructions, and a test asserts the FTS sanitiser neutralises hostile input.
- Errors return a stable code, a human message, a retryable flag and a request id — never a stack trace or a provider response body.

---

## Known limitations

Stated plainly, because a README that overclaims is worse than no README.

1. **Not run end-to-end against live infrastructure.** The suite is unit-level. D1 queries, queue delivery, Vectorize upserts and the OAuth callback have been written and type-checked but not executed against a real account in this repository. `docs/QA-CHECKLIST.md` lists exactly what to verify first.
2. **Chat is not streamed.** Answers are generated in one pass and returned complete. There is no fake typewriter effect over a buffered response.
3. **No email transport.** Password reset issues a token; in development it is returned in the response body, in production it is only logged. Wire up an email sender before relying on it.
4. **Topic search cannot search Instagram.** The Graph API has no keyword search endpoint. The UI says so rather than pretending. A different discovery provider (uploaded documents, an authorised index) would need its own adapter.
5. **No OCR engine is bundled.** "OCR text" comes from the vision model's reading of the image (`observedText`), not from Tesseract. That is documented in the visual analysis type.
6. **Scheduled research is coarse.** It re-lists recent media and relies on duplicate detection; the Graph API has no universal "since" cursor.
7. **Rate limiting is per-account and coarse** — a D1-backed fixed window. Cloudflare's rate-limiting rules are the right tool for hostile traffic; DEPLOYMENT.md explains how to enable them.
8. **`storageBytes` on the dashboard is `0`.** R2 object sizes are not listed anywhere yet; reporting a guess would be worse than reporting nothing.
9. **Multi-user sharing is not implemented.** Collections are single-owner. The schema has no sharing table.
10. **Reports export as Markdown only.** The API returns structured content; PDF export would need a rendering step that is not built.

---

## Licence

No licence file is included. Add one before publishing if you intend others to reuse this code.
