# Deployment

Step-by-step for a first deployment to Cloudflare. Every command is copy-pasteable; placeholders are marked `<like-this>`.

---

## 0. Pre-flight

```bash
node --version          # must be >= 20
npx wrangler --version  # 3.x or newer
npx wrangler whoami     # confirm the right account
```

`wrangler whoami` failing means you are not logged in — run `npx wrangler login`. Never commit credentials; wrangler stores them outside the repo.

---

## 1. Install and build

```bash
npm install
npm run typecheck
npm test
```

If `npm install` fails with a V8 heap error in a memory-constrained container, raise the address-space limit first:

```bash
ulimit -v unlimited
npm install
```

---

## 2. One command (recommended)

```bash
npm run setup
```

That is `bash scripts/provision-cloudflare.sh`, which does everything in
sections 3–6 below and is safe to re-run:

| Step       | What it does                                                                                          | Re-run behaviour                                    |
| ---------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| D1         | `wrangler d1 create rih-db`, then writes the id into `wrangler.toml`                                  | Reuses the existing database, re-writes the same id |
| R2         | `wrangler r2 bucket create rih-media`                                                                 | Reports "already exists"                            |
| Queues     | Creates `rih-pipeline` and `rih-pipeline-dlq`                                                         | Reports "reusing"                                   |
| Vectorize  | Creates `rih-embeddings` at 768 dims / cosine                                                         | Reports "already exists"                            |
| Secrets    | Generates `AUTH_SECRET` (48 bytes) and `SECRETS_ENCRYPTION_KEY` (32 bytes) via Node crypto, sets them | **Leaves existing secrets untouched**               |
| Migrations | `wrangler d1 migrations apply rih-db --remote`                                                        | Idempotent                                          |
| Build      | `VITE_API_BASE_URL="" npm run build:web`                                                              | Overwrites `apps/web/dist`                          |
| Deploy     | `wrangler deploy`                                                                                     | Replaces the current Worker version                 |

At the end it prints the Worker URL, the health-check URL, and — **once** — any
secrets it generated. Copy them somewhere safe. Losing
`SECRETS_ENCRYPTION_KEY` makes every stored provider key undecryptable; users
would have to re-enter them.

Override resource names without editing anything:

```bash
DB_NAME=my-db BUCKET_NAME=my-bucket npm run setup
```

---

## 2a. Why you cannot deploy this by dragging the repo into the dashboard

The dashboard's **Upload and deploy → drag and drop your static files** panel
deploys static assets. This application is a Worker with five bindings and a
database schema, so that panel cannot deploy it — it would store 99 source files
as static content and serve nothing usable.

The rejection of `wrangler.toml` ("unknown file type") is a symptom, not the
problem: that uploader accepts only recognised web file types, and `.toml` is not
one of them. `wrangler.toml` should never be uploaded anyway — it configures the
CLI.

If you have no terminal at all, generate a paste-able bundle instead:

```bash
npm run bundle:paste
```

This writes `dashboard-deploy/worker.js` (one ES module, ~473 KB) and
`dashboard-deploy/schema.sql`, with step-by-step dashboard instructions in
`dashboard-deploy/README-DASHBOARD.md`. It works, but every future code change
means re-pasting the bundle and re-uploading the frontend by hand.

---

## 3. Manual: create the resources

If you would rather do it by hand, or the script fails partway:

```bash
# D1 — copy the printed database_id into apps/api/wrangler.toml
npx wrangler d1 create rih-db

# R2 — private bucket by default
npx wrangler r2 bucket create rih-media

# Queues
npx wrangler queues create rih-pipeline
npx wrangler queues create rih-pipeline-dlq

# Vectorize — dimensions and metric are fixed at creation
npx wrangler vectorize create rih-embeddings --dimensions=768 --metric=cosine
```

In `apps/api/wrangler.toml`, replace `REPLACE_WITH_D1_DATABASE_ID` with the id
printed by `d1 create`.

---

## 4. Manual: migrations

```bash
npm run db:migrate:remote
```

Creates all 20 tables, the indexes, the FTS5 virtual table and its triggers.

Verify:

```bash
npx wrangler d1 execute rih-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

---

## 5. Manual: secrets

```bash
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 32   # SECRETS_ENCRYPTION_KEY

npx wrangler secret put AUTH_SECRET --config apps/api/wrangler.toml
npx wrangler secret put SECRETS_ENCRYPTION_KEY --config apps/api/wrangler.toml
```

`SECRETS_ENCRYPTION_KEY` **must decode to exactly 32 bytes**. The Worker rejects
anything else with a clear message rather than silently using a weak key.

Optional platform-wide provider keys — skip these if every user will bring their
own key in Settings → API Keys:

```bash
npx wrangler secret put OPENAI_API_KEY --config apps/api/wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY --config apps/api/wrangler.toml
npx wrangler secret put GOOGLE_AI_API_KEY --config apps/api/wrangler.toml
npx wrangler secret put ASSEMBLYAI_API_KEY --config apps/api/wrangler.toml
```

Instagram, for real discovery:

```bash
npx wrangler secret put INSTAGRAM_APP_ID --config apps/api/wrangler.toml
npx wrangler secret put INSTAGRAM_APP_SECRET --config apps/api/wrangler.toml
npx wrangler secret put INSTAGRAM_REDIRECT_URI --config apps/api/wrangler.toml
# https://<worker-url>/api/v1/integrations/instagram/callback
```

---

## 6. Manual: build and deploy

```bash
npm run deploy
```

Which is:

```bash
VITE_API_BASE_URL="" npm run build:web      # same-origin: empty base URL
npm run typecheck --workspace @rih/api
wrangler deploy --config apps/api/wrangler.toml
```

### How the frontend is served

`apps/api/wrangler.toml` declares:

```toml
[assets]
directory = "../web/dist"
binding = "ASSETS"
```

The built SPA is uploaded with the Worker. Cloudflare serves any request that
matches a real file; everything else reaches the Worker, which:

1. returns a JSON `404` for an unmatched `/api/*` path — never the HTML shell;
2. serves the file from `ASSETS` when one exists;
3. serves `index.html` for a navigation request, so React Router resolves
   client-side routes like `/collections/abc`.

`apps/api/tests/spa.test.ts` covers all of these branches, including that an
unknown API route returns JSON rather than HTML. That is the failure mode that
would otherwise break a deployment silently.

Because the frontend and API share an origin, `ALLOWED_ORIGINS` only needs to
list development origins. It becomes relevant again if you front the Worker with
a custom domain that the browser calls directly.

### Alternative: frontend on Cloudflare Pages

```bash
VITE_API_BASE_URL="https://reels-intelligence-hub-api.<subdomain>.workers.dev" \
  npm run build:web
npx wrangler pages deploy apps/web/dist --project-name reels-intelligence-hub
```

Then set `ALLOWED_ORIGINS` to the Pages URL and redeploy the Worker. Authentication
falls back to the bearer token in `localStorage`, since cookies cannot cross
origins. Prefer the same-origin setup above.

### Custom domain

Add to `wrangler.toml` and redeploy:

```toml
routes = [{ pattern = "research.example.com", custom_domain = true }]
```

---

## 7. Post-deploy checks

```bash
# Health — must be 200 with status "ok"
curl -s https://<worker-url>/api/v1/health | jq

# A route that requires auth must 401, not 500
curl -s -o /dev/null -w "%{http_code}\n" https://<worker-url>/api/v1/collections

# Tail logs while you exercise the app
npx wrangler tail --config apps/api/wrangler.toml
```

Then in the browser:

1. Register an account.
2. **Settings → Integrations** — every check should read `ok` except Instagram if you skipped it.
3. **Settings → API Keys** — add a key, press Test, confirm it reports accepted or "no automated check".
4. Reels Search → enable demo data if Instagram is not configured → start a run.
5. **Live Monitor** — watch stages advance.
6. Open the collection, then Chat, and ask a question. Confirm citations appear.

`docs/QA-CHECKLIST.md` has the full list.

---

## 8. Rate limiting (recommended)

The Worker's built-in limiter is a coarse per-account fixed window stored in D1. It protects against accidental hammering, not hostile traffic. Add a Cloudflare rate-limiting rule in front:

Dashboard → Security → WAF → Rate limiting rules:

| Field           | Value                                              |
| --------------- | -------------------------------------------------- |
| Expression      | `(http.request.uri.path matches "^/api/v1/auth/")` |
| Requests        | 10 per 1 minute                                    |
| Action          | Block, 60 s                                        |
| Characteristics | IP                                                 |

Repeat for `/api/v1/chat/` (30/min) and `/api/v1/research/` (20/min).

---

## 9. Cron

`wrangler.toml` already declares `crons = ["0 3 * * *"]`. No extra setup. Confirm it registered:

```bash
npx wrangler deployments list --config apps/api/wrangler.toml
```

The handler re-queues due retries and enqueues scheduled research. It does not process content itself — that keeps it inside the cron CPU budget.

---

## 10. Local development with remote resources

To develop against real D1/R2/Vectorize while running locally:

```bash
npx wrangler dev --config apps/api/wrangler.toml --remote
```

This uses production resources. Be deliberate: it writes real rows. For everyday work prefer `--local`, which uses a SQLite file under `.wrangler/` that `npm run db:migrate:local` seeds.

---

## 11. Rolling back

```bash
npx wrangler deployments list --config apps/api/wrangler.toml
npx wrangler rollback --config apps/api/wrangler.toml
```

Rolling back the Worker does **not** roll back migrations. Migrations in this repository are additive and forward-only; write a new migration rather than editing `0001_init.sql` after it has been applied anywhere.

---

## 12. What still needs doing after a deploy

Be honest with yourself about this list:

- [ ] An email sender for password resets (currently the token is only logged in production)
- [ ] Cloudflare rate-limiting rules
- [ ] A licence file
- [ ] Real end-to-end verification of the OAuth callback against your Meta app
- [ ] Cloudflare rate-limiting rules on `/api/v1/auth/`, `/chat/` and `/research/`
