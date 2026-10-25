# Manual QA checklist

The automated suite covers pure logic only. Everything below needs a real
deployment (or `wrangler dev --local` plus a real provider key) and has **not**
been executed in this repository. Work top to bottom; each step says what
"pass" looks like.

## Deploy

- [ ] `npm run setup` completes without error and prints the Worker URL
- [ ] `curl -s <url>/api/v1/health` → 200 with `"status": "ok"`
- [ ] `curl -s -o /dev/null -w "%{http_code}" <url>/api/v1/collections` → 401 (not 500, not HTML)
- [ ] Opening `<url>/collections/anything` directly in the browser loads the app (SPA fallback), not a 404 page
- [ ] Opening `<url>/api/v1/nope` returns JSON, not the HTML shell

## Setup

- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean, zero warnings
- [ ] `npm test` — 79 passing
- [ ] `npm run deploy:dry-run` — web bundle built and the Worker (with its assets) bundles cleanly
- [ ] `npm run db:migrate:local` — migrations apply without error
- [ ] `wrangler d1 execute rih-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"` — 20 tables plus `content_search`

## Authentication

- [ ] Register with a 9-character password → rejected client-side and server-side
- [ ] Register with a valid password → redirected to the dashboard
- [ ] Reload the page → still signed in
- [ ] Sign out → redirected to `/login`; visiting `/collections` redirects back to `/login`
- [ ] Wrong password → "That email and password combination is not correct." (never "no such user")
- [ ] Password reset request for a non-existent email → same 202 response as for a real one
- [ ] Password reset confirm with a used token → "invalid or has expired"

## Settings → API Keys

- [ ] Every provider appears, with `not configured` where no key exists
- [ ] Save a key shorter than 16 characters → inline field error, nothing stored
- [ ] Save a realistic key → row shows `••••••••` plus the last four characters
- [ ] Reload the page → the masked value persists; the full key is nowhere in the network response (check DevTools → Network → Response)
- [ ] Test a valid key → "Key accepted by the provider" with a latency figure
- [ ] Test an invalid key → "The provider rejected this key (HTTP 401)" and the badge becomes `invalid`
- [ ] Test a provider with no probe (e.g. Instagram Graph) → "No automated verification is available"
- [ ] Replace a key → old value gone, status back to `unverified`
- [ ] Delete a key → row returns to `not configured`
- [ ] With `SECRETS_ENCRYPTION_KEY` unset → the screen disables saving and names the secret to set
- [ ] Rotate `SECRETS_ENCRYPTION_KEY` and restart → stored keys show `invalid` and ask for re-entry

## Research

- [ ] Paste `https://example.com/x` → "Only Instagram sources are supported…", Start disabled
- [ ] Paste `https://instagram.com/explore/` → rejected as a reserved route
- [ ] Paste `@design.inspiration` → valid; message names the handle
- [ ] Start research with no Instagram configured and no demo data → clear `PROVIDER_NOT_CONFIGURED` toast pointing at the setup
- [ ] Enable demo mode, tick "Use demo data", start → collection created, items discovered
- [ ] Start the same run again → `409` explaining a job is already active
- [ ] With no AI key configured → items are discovered but each fails with a message naming Settings → API Keys

## Pipeline and monitor

- [ ] Live Monitor shows waiting → processing → completed as items are worked through
- [ ] Refresh the page mid-run → counters are unchanged (they come from D1, not memory)
- [ ] Pause a running job → status becomes `paused`, no further items start
- [ ] Resume → processing continues
- [ ] Cancel → status `cancelled`, in-flight item finishes but no new one starts
- [ ] Force a failure (bad key) → item is `failed` with a retry scheduled, then re-queued
- [ ] After retries are exhausted → `failed` permanently, and the error is readable
- [ ] An item whose summary failed but whose transcript succeeded → transcript is still present

## Collections

- [ ] Create a collection with a name that already exists → `409` with a helpful message
- [ ] Rename, duplicate, archive, restore, delete → all reflected immediately
- [ ] Grid and list views both render
- [ ] Item detail dialog shows caption, summary, main points, visual analysis, tags
- [ ] Interpretation is visually separated from observed characteristics

## Search

- [ ] Search with no items saved → "Nothing in your 0 saved items matches"
- [ ] Keyword search finds a word from a caption
- [ ] With no embedding key → notice reads "Semantic search needs an embedding provider key…" and results still return
- [ ] With an embedding key → `semanticAvailable` is true and conceptually-related items rank
- [ ] Filters (content type, sort) change the result set
- [ ] Hostile input (`"); DROP TABLE`) returns results or an empty set — never a 500

## Chat

- [ ] Ask a question in a collection with no items → "There is no saved research in this scope that matches that question."
- [ ] Ask a question with items present → answer contains `[n]` markers and the Sources panel lists matching items
- [ ] An answer with no bracketed citations shows a `no citations` badge
- [ ] Conversation title auto-fills from the first question
- [ ] Rename and delete a conversation
- [ ] A second user cannot open the first user's conversation by URL (404)

## Reports

- [ ] Generate a report on an empty collection → `400` explaining there is nothing to report on
- [ ] Generate on a populated collection → sections present, `[n]` citations resolve to the source list
- [ ] Copy as Markdown puts the full text on the clipboard

## Connected accounts

- [ ] With Instagram unset → banner explains what an administrator must set
- [ ] Connect → redirected to Instagram's consent screen with a `state` parameter
- [ ] Callback with a stale `state` → "that authorisation link has expired"
- [ ] After connecting, the account shows status, permissions, last success
- [ ] Disconnect → row removed; research against that account now fails with a clear message

## Cross-tenant isolation

- [ ] User B cannot GET user A's collection id (404)
- [ ] User B cannot POST a message into user A's conversation (404)
- [ ] User B cannot pause user A's job (404)
- [ ] User B's search returns only B's items
