#!/usr/bin/env bash
#
# Provision every Cloudflare resource this project needs, wire the ids into
# wrangler.toml, set the required secrets, apply migrations, build and deploy.
#
#   bash scripts/provision-cloudflare.sh
#
# Safe to re-run: existing resources are reused, existing secrets are left
# alone, and migrations are idempotent. The only destructive step is the final
# `wrangler deploy`, which replaces the currently deployed Worker version.
#
# Requirements: node >= 20, npx, an authenticated wrangler (`npx wrangler login`).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override any of these with environment variables.
# ---------------------------------------------------------------------------
DB_NAME="${DB_NAME:-rih-db}"
BUCKET_NAME="${BUCKET_NAME:-rih-media}"
QUEUE_NAME="${QUEUE_NAME:-rih-pipeline}"
DLQ_NAME="${DLQ_NAME:-rih-pipeline-dlq}"
INDEX_NAME="${INDEX_NAME:-rih-embeddings}"
INDEX_DIMENSIONS="${INDEX_DIMENSIONS:-768}"
WORKER_NAME="${WORKER_NAME:-reels-intelligence-hub-api}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT_DIR/apps/api/wrangler.toml"
cd "$ROOT_DIR"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
step "Checking the environment"

command -v node >/dev/null || die "node is not installed. Install Node.js 20 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required, found $(node --version)."
ok "node $(node --version)"

[ -f "$CONFIG" ] || die "apps/api/wrangler.toml not found — run this from the repository root."
ok "wrangler.toml found"

if ! npx wrangler whoami >/dev/null 2>&1; then
  die "wrangler is not authenticated. Run: npx wrangler login"
fi
ACCOUNT="$(npx wrangler whoami 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1 || true)"
ok "wrangler authenticated${ACCOUNT:+ as $ACCOUNT}"

[ -d node_modules ] || die "Dependencies are not installed. Run: npm install"

# ---------------------------------------------------------------------------
# 1. D1
# ---------------------------------------------------------------------------
step "D1 database: $DB_NAME"

DB_ID="$(node -e '
const { execSync } = require("node:child_process");
try {
  const out = execSync("npx wrangler d1 list --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const start = out.indexOf("[");
  const list = JSON.parse(out.slice(start));
  const match = list.find((d) => d.name === process.argv[1]);
  if (match) process.stdout.write(match.uuid ?? match.id ?? "");
} catch { /* not created yet */ }
' "$DB_NAME" 2>/dev/null || true)"

if [ -z "$DB_ID" ]; then
  CREATE_OUT="$(npx wrangler d1 create "$DB_NAME" 2>&1 || true)"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -oE '"database_id"[^"]*"[0-9a-fA-F-]{36}"' | grep -oE '[0-9a-fA-F-]{36}' | head -1 || true)"
  if [ -z "$DB_ID" ]; then
    printf '%s\n' "$CREATE_OUT" | head -20
    die "Could not create or find the D1 database. Check the output above."
  fi
  ok "created $DB_NAME ($DB_ID)"
else
  ok "reusing $DB_NAME ($DB_ID)"
fi

# Write the id into wrangler.toml, replacing the placeholder if present.
node -e '
const fs = require("node:fs");
const [file, id] = process.argv.slice(1);
const src = fs.readFileSync(file, "utf8");
const next = src.replace(/^database_id\s*=\s*".*"$/m, `database_id = "${id}"`);
if (next === src && !src.includes(`database_id = "${id}"`)) {
  console.error("database_id line not found in wrangler.toml");
  process.exit(1);
}
fs.writeFileSync(file, next);
' "$CONFIG" "$DB_ID"
ok "wrangler.toml → database_id = $DB_ID"

# ---------------------------------------------------------------------------
# 2. R2
# ---------------------------------------------------------------------------
step "R2 bucket: $BUCKET_NAME"
if npx wrangler r2 bucket create "$BUCKET_NAME" >/dev/null 2>&1; then
  ok "created"
else
  ok "already exists (reusing)"
fi

# ---------------------------------------------------------------------------
# 3. Queues
# ---------------------------------------------------------------------------
step "Queues"
for queue in "$QUEUE_NAME" "$DLQ_NAME"; do
  if npx wrangler queues create "$queue" >/dev/null 2>&1; then
    ok "created $queue"
  else
    ok "reusing $queue"
  fi
done

# ---------------------------------------------------------------------------
# 4. Vectorize
# ---------------------------------------------------------------------------
step "Vectorize index: $INDEX_NAME (${INDEX_DIMENSIONS} dims, cosine)"
if npx wrangler vectorize create "$INDEX_NAME" \
     --dimensions="$INDEX_DIMENSIONS" --metric=cosine >/dev/null 2>&1; then
  ok "created"
else
  ok "already exists (reusing)"
fi
warn "Vector dimensions are fixed at creation. The default embedding models produce ${INDEX_DIMENSIONS}."

# ---------------------------------------------------------------------------
# 5. Secrets
# ---------------------------------------------------------------------------
step "Worker secrets"

existing_secrets="$(npx wrangler secret list --config "$CONFIG" 2>/dev/null || true)"

gen_secret() {
  # 48 bytes for AUTH_SECRET, 32 for the AES key. openssl when available,
  # otherwise Node's crypto — both produce base64.
  node -e 'process.stdout.write(require("node:crypto").randomBytes(Number(process.argv[1])).toString("base64"))' "$1"
}

NEW_AUTH_SECRET=""
NEW_ENCRYPTION_KEY=""

if printf '%s' "$existing_secrets" | grep -q 'AUTH_SECRET'; then
  ok "AUTH_SECRET already set (left untouched)"
else
  NEW_AUTH_SECRET="$(gen_secret 48)"
  printf '%s' "$NEW_AUTH_SECRET" | npx wrangler secret put AUTH_SECRET --config "$CONFIG" >/dev/null
  ok "AUTH_SECRET generated and set"
fi

if printf '%s' "$existing_secrets" | grep -q 'SECRETS_ENCRYPTION_KEY'; then
  ok "SECRETS_ENCRYPTION_KEY already set (left untouched)"
else
  NEW_ENCRYPTION_KEY="$(gen_secret 32)"
  printf '%s' "$NEW_ENCRYPTION_KEY" | npx wrangler secret put SECRETS_ENCRYPTION_KEY --config "$CONFIG" >/dev/null
  ok "SECRETS_ENCRYPTION_KEY generated and set"
fi

warn "Provider keys are optional — users can add their own in Settings → API Keys."
warn "Instagram needs INSTAGRAM_APP_ID / _APP_SECRET / _REDIRECT_URI before real discovery works."

# ---------------------------------------------------------------------------
# 6. Migrations
# ---------------------------------------------------------------------------
step "Applying D1 migrations (remote)"
npx wrangler d1 migrations apply "$DB_NAME" --remote --config "$CONFIG"
ok "schema up to date"

# ---------------------------------------------------------------------------
# 7. Build + deploy
# ---------------------------------------------------------------------------
step "Building the frontend"
# Same-origin API: an empty base URL keeps every request relative.
VITE_API_BASE_URL="" npm run build:web
ok "apps/web/dist built"

step "Type-checking the Worker"
(cd apps/api && npx tsc --noEmit)
ok "no type errors"

step "Deploying $WORKER_NAME"
DEPLOY_LOG="$(mktemp)"
set +e
npx wrangler deploy --config "$CONFIG" 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_STATUS="${PIPESTATUS[0]}"
set -e
[ "$DEPLOY_STATUS" -eq 0 ] || die "Deployment failed. The output above has the reason."

WORKER_URL="$(grep -oE 'https://[A-Za-z0-9._-]+workers\.dev' "$DEPLOY_LOG" | head -1 || true)"
rm -f "$DEPLOY_LOG"

printf '\n\033[1;32m────────────────────────────────────────────────────────────\033[0m\n'
printf '\033[1;32m  Deployed\033[0m\n'
printf '\033[1;32m────────────────────────────────────────────────────────────\033[0m\n'
printf '  Worker : %s\n' "$WORKER_NAME"
if [ -n "$WORKER_URL" ]; then
  printf '  URL    : %s\n' "$WORKER_URL"
  printf '  Health : %s/api/v1/health\n' "$WORKER_URL"
else
  printf '  URL    : see the deploy output above\n'
fi

if [ -n "$NEW_AUTH_SECRET" ] || [ -n "$NEW_ENCRYPTION_KEY" ]; then
  printf '\n\033[1;33m  Store these now — they are shown once.\033[0m\n'
  [ -n "$NEW_AUTH_SECRET" ] && printf '  AUTH_SECRET             = %s\n' "$NEW_AUTH_SECRET"
  [ -n "$NEW_ENCRYPTION_KEY" ] && printf '  SECRETS_ENCRYPTION_KEY  = %s\n' "$NEW_ENCRYPTION_KEY"
  printf '\n  Losing SECRETS_ENCRYPTION_KEY makes every stored provider key\n'
  printf '  undecryptable; users would have to re-enter them in Settings.\n'
fi

printf '\n  Next:\n'
printf '    1. Open the URL above and register the first account.\n'
printf '    2. Settings → API Keys: add a provider key and press Test.\n'
printf '    3. Settings → Integrations: every check should read "ok".\n'
printf '    4. Add ALLOWED_ORIGINS in wrangler.toml if you front this with a\n'
printf '       custom domain, then re-run: npm run deploy\n\n'
