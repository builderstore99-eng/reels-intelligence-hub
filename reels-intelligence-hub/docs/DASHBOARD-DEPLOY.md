# Deploying from the Cloudflare dashboard (no terminal)

You only need this if you genuinely cannot run a terminal. It is slower and more
error-prone than `npm run setup`, and it is easier to get wrong.

## First: are you in the right panel?

Cloudflare has **two** different "deploy" flows in the dashboard and only one of
them can host this Worker. If you have seen either of these errors, you are in
the wrong one:

| Error you saw                                                                                                                                           | What it means                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1 are unknown — wrangler.toml`                                                                                                                         | You uploaded the repository to the **static files** uploader. That panel only accepts recognised web file types; `.toml` has no MIME type, so it is rejected.                       |
| `This uploader does not yet support projects that require a build process. At least one JavaScript file was found. Please use wrangler deploy instead.` | Same panel, now with a `.js` file in the batch. The panel refuses anything that looks like a Worker script. **This is Cloudflare itself telling you this panel cannot do the job.** |

The panel in question is **Workers & Pages → Upload and deploy → "Drag and drop
your static files"**. It is for static sites with no build step and no bindings.
It will never accept this project.

### What this project actually needs

| It needs                                    | The static upload panel provides |
| ------------------------------------------- | -------------------------------- |
| A Worker script (TypeScript, bundled)       | Nothing — it only stores files   |
| A D1 database with 20 tables                | Nothing                          |
| An R2 bucket, two Queues, a Vectorize index | Nothing                          |
| `AUTH_SECRET`, `SECRETS_ENCRYPTION_KEY`     | Nothing                          |

### The correct deploy

```bash
npm install
npx wrangler login
npm run setup
```

If you can run those three commands, stop reading — that is the supported path,
it takes about three minutes, and Cloudflare's own error message recommends it.

If you cannot run a terminal at all, the **Create Worker → Edit code** route
below is the one that works. It is a different entry point from the panel you
have been using.

---

## The dashboard-only path

Two files in this folder do the work:

- `worker.js` — the entire Worker, bundled into one ES module (473 KB)
- `schema.sql` — the complete database schema

### Step 1 — Create the D1 database

Dashboard → **Storage & Databases → D1 SQL Database → Create**.

Name it `rih-db`. Copy the **Database ID** shown afterwards.

### Step 2 — Apply the schema

Open the database → **Console** tab. Paste the entire contents of `schema.sql`
and run it. It creates 20 tables, the indexes, the full-text search table and
its triggers.

Verify by running:

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

You should see `api_keys`, `collections`, `content_items`, `content_search`,
`research_jobs`, `usage_events` and the rest.

### Step 3 — Create the other resources

- **R2 → Create bucket** → name it `rih-media` (leave it private)
- **Queues → Create queue** → `rih-pipeline`
- **Queues → Create queue** → `rih-pipeline-dlq`
- **Vectorize → Create index** → name `rih-embeddings`, dimensions **768**, metric **cosine**

### Step 4 — Create the Worker (not "Upload and deploy")

Dashboard → **Workers & Pages → Create application → Create Worker** → name it
`reels-intelligence-hub-api` → **Deploy**.

Then, on the Worker's page: **Edit code** (some accounts label it _Quick edit_).

Delete the placeholder `Hello World` line, paste **all** of `worker.js`, and
press **Deploy**.

Use this flow, not "Upload and deploy". The difference matters: _Edit code_
accepts a module you paste and deploys it directly; _Upload and deploy_ expects a
pre-built static site and rejects anything containing JavaScript.

> `worker.js` is ~472 KB. The editor accepts it, but it will be sluggish to
> open. If the browser struggles, the CLI path is genuinely the better option.

In **Settings → Runtime**:

- Compatibility date: `2025-01-15`
- Compatibility flags: leave empty (the bundle uses no Node built-ins)

### Step 5 — Add the five bindings

**Settings → Bindings → Add**, one at a time. The variable names must match
exactly — they are what the code reads:

| Type            | Variable name | Resource              |
| --------------- | ------------- | --------------------- |
| D1 database     | `DB`          | `rih-db`              |
| R2 bucket       | `MEDIA`       | `rih-media`           |
| Queue           | `PIPELINE`    | `rih-pipeline`        |
| Vectorize index | `VECTORS`     | `rih-embeddings`      |
| Workers AI      | `AI`          | (no resource to pick) |

Add the Queue **consumer** too: **Settings → Triggers → Queues → Add** →
queue `rih-pipeline`, batch size 10, max retries 3, dead-letter queue
`rih-pipeline-dlq`. Without this, research starts but nothing ever processes.

### Step 6 — Add the variables and secrets

**Settings → Variables and Secrets**:

Plain-text variables:

```
ENVIRONMENT=production
ALLOWED_ORIGINS=*
ENABLE_TRANSCRIPTION=true
ENABLE_VISUAL_ANALYSIS=true
ENABLE_SEMANTIC_SEARCH=true
ENABLE_DEMO_MODE=false
```

Encrypted secrets — generate each with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
(or any password manager's generator):

| Name                     | Value                        |
| ------------------------ | ---------------------------- |
| `AUTH_SECRET`            | 48 random bytes, base64      |
| `SECRETS_ENCRYPTION_KEY` | **exactly 32 bytes**, base64 |

`SECRETS_ENCRYPTION_KEY` must decode to 32 bytes — the Worker refuses anything
else rather than quietly using a weak key. Save both; losing the encryption key
makes every stored provider API key undecryptable.

### Step 7 — Check it

Open `https://reels-intelligence-hub-api.<your-subdomain>.workers.dev/api/v1/health`.

It should return `{"data":{"status":"ok",...}}`. If it returns
`"status":"degraded"`, the `missing` array names the secret you have not set.

**The UI is not deployed by this path.** The dashboard route gives you a working
API only. To get the interface you would have to rebuild the frontend with the
Worker URL baked in, then upload it as a Pages project:

```bash
VITE_API_BASE_URL="https://reels-intelligence-hub-api.<subdomain>.workers.dev" \
  npm run build:web
# then: Pages → Create → Upload assets → drag the CONTENTS of apps/web/dist
```

and set `ALLOWED_ORIGINS` on the Worker to the Pages URL. A `dist` built with an
empty base URL calls `/api` on its own origin and will fail — that is why the
rebuild is required.

Much better: switch to `npm run setup`, which uploads the built frontend with
the Worker so both share an origin and none of this applies.

### Step 8 — Cron (optional)

**Settings → Triggers → Cron Triggers → Add** → `0 3 * * *`.

---

## Honest comparison

|                                  | `npm run setup`  | Dashboard                                   |
| -------------------------------- | ---------------- | ------------------------------------------- |
| Time                             | ~3 minutes       | ~25 minutes                                 |
| Bindings wired correctly         | automatic        | manual, easy to mistype                     |
| Secrets generated                | automatic        | you generate and paste                      |
| Frontend included                | yes, same origin | no — separate Pages deploy                  |
| Re-deploying after a code change | `npm run deploy` | re-paste the bundle, re-upload the frontend |
| Migrations on the next change    | automatic        | paste SQL by hand                           |

The dashboard path is viable, but every future change means doing all of it
again. The CLI path exists precisely so you do not have to.
