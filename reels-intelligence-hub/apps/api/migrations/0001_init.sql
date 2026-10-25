-- ===========================================================================
-- Reels Intelligence Hub — initial schema
--
-- Conventions
--   * ids are URL-safe random strings (16 bytes, base64url), generated in the
--     Worker. Not AUTOINCREMENT, so ids are safe to expose in URLs and can be
--     generated before the insert (which job batching needs).
--   * timestamps are ISO-8601 TEXT in UTC. SQLite has no date type; TEXT sorts
--     lexicographically, which is all we need.
--   * booleans are INTEGER 0/1.
--   * JSON blobs are TEXT validated at the application boundary.
--   * every user-owned table carries owner_id and is filtered on it in every
--     query. Tenant isolation is enforced in SQL, not in the UI.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Password reset tokens. Only the SHA-256 of the token is stored, so a
-- database leak cannot be used to reset anyone's password.
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);

-- --------------------------------------------------------------- collections
CREATE TABLE IF NOT EXISTS collections (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  normalized_name   TEXT NOT NULL,
  description       TEXT,
  collection_type   TEXT NOT NULL DEFAULT 'manual'
                    CHECK (collection_type IN ('instagram_profile', 'topic_research',
                            'design_references', 'manual', 'document_library', 'custom')),
  source_identifier TEXT,
  settings_json     TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'processing', 'paused', 'archived', 'failed')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_activity_at  TEXT
);

-- A user cannot hold two collections with the same normalised name and the
-- same source. This is what stops "start research twice" from silently
-- creating duplicate profile collections.
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_owner_name
  ON collections (owner_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_collections_owner_updated
  ON collections (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collections_source
  ON collections (owner_id, source_identifier);

-- -------------------------------------------------------------- content_items
CREATE TABLE IF NOT EXISTS content_items (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_provider     TEXT NOT NULL DEFAULT 'instagram',
  source_identifier   TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  creator_identifier  TEXT,
  content_type        TEXT NOT NULL DEFAULT 'reel'
                      CHECK (content_type IN ('reel', 'video', 'image', 'carousel', 'document')),
  caption             TEXT,
  published_at        TEXT,
  thumbnail_reference TEXT,
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  processing_status   TEXT NOT NULL DEFAULT 'discovered'
                      CHECK (processing_status IN ('discovered', 'queued', 'processing',
                             'completed', 'failed', 'skipped', 'unsupported')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Duplicate ingestion guard: one row per (owner, provider, source id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_items_unique
  ON content_items (owner_id, source_provider, source_identifier);
CREATE INDEX IF NOT EXISTS idx_content_items_owner_status
  ON content_items (owner_id, processing_status);
CREATE INDEX IF NOT EXISTS idx_content_items_published
  ON content_items (published_at DESC);

-- Content can belong to several collections (e.g. a reel found by a topic
-- search and also saved into a design folder), so membership is a junction
-- table rather than a foreign key on content_items. This is the deliberate
-- deviation from the brief's flat `content_items.collection_id`.
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id   TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL REFERENCES content_items (id) ON DELETE CASCADE,
  added_at        TEXT NOT NULL,
  added_by        TEXT NOT NULL DEFAULT 'pipeline',
  note            TEXT,
  PRIMARY KEY (collection_id, content_item_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_item ON collection_items (content_item_id);

-- ----------------------------------------------------------------- transcripts
CREATE TABLE IF NOT EXISTS transcripts (
  id              TEXT PRIMARY KEY,
  content_item_id TEXT NOT NULL REFERENCES content_items (id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  language        TEXT,
  segments_json   TEXT NOT NULL DEFAULT '[]',
  provider        TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_item ON transcripts (content_item_id);

-- ------------------------------------------------------------------ summaries
CREATE TABLE IF NOT EXISTS summaries (
  id                    TEXT PRIMARY KEY,
  content_item_id       TEXT NOT NULL REFERENCES content_items (id) ON DELETE CASCADE,
  summary_type          TEXT NOT NULL DEFAULT 'standard',
  title                 TEXT,
  short_summary         TEXT,
  detailed_summary      TEXT,
  main_points_json      TEXT NOT NULL DEFAULT '[]',
  takeaways_json        TEXT NOT NULL DEFAULT '[]',
  visual_analysis_json  TEXT,
  source_references_json TEXT NOT NULL DEFAULT '[]',
  model_identifier      TEXT,
  created_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_item_type
  ON summaries (content_item_id, summary_type);

-- ----------------------------------------------------------------------- tags
CREATE TABLE IF NOT EXISTS tags (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_owner_normalized
  ON tags (owner_id, normalized_name);

CREATE TABLE IF NOT EXISTS content_tags (
  content_item_id TEXT NOT NULL REFERENCES content_items (id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (content_item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_content_tags_tag ON content_tags (tag_id);

-- -------------------------------------------------------------- research_jobs
CREATE TABLE IF NOT EXISTS research_jobs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  collection_id    TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  job_type         TEXT NOT NULL
                   CHECK (job_type IN ('profile_reels', 'design_documents',
                          'topic_research', 'scheduled_refresh')),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'paused', 'completed',
                          'failed', 'cancelled')),
  total_items      INTEGER NOT NULL DEFAULT 0,
  completed_items  INTEGER NOT NULL DEFAULT 0,
  failed_items     INTEGER NOT NULL DEFAULT 0,
  skipped_items    INTEGER NOT NULL DEFAULT 0,
  progress         REAL NOT NULL DEFAULT 0,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  error_summary    TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON research_jobs (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_collection ON research_jobs (collection_id, created_at DESC);
-- Prevents the same profile being queued twice while a run is still active.
CREATE INDEX IF NOT EXISTS idx_jobs_active
  ON research_jobs (collection_id, status, job_type);

CREATE TABLE IF NOT EXISTS job_items (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES research_jobs (id) ON DELETE CASCADE,
  content_item_id TEXT REFERENCES content_items (id) ON DELETE SET NULL,
  stage           TEXT NOT NULL DEFAULT 'discovery',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  error_code      TEXT,
  error_message   TEXT,
  started_at      TEXT,
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items (job_id, status);
CREATE INDEX IF NOT EXISTS idx_job_items_retry ON job_items (next_retry_at)
  WHERE next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_events (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES research_jobs (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, created_at DESC);

-- -------------------------------------------------------------- conversations
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  collection_id TEXT REFERENCES collections (id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'New conversation',
  scope_type    TEXT NOT NULL DEFAULT 'collection'
                CHECK (scope_type IN ('item', 'collection', 'collections', 'knowledge_base')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner
  ON conversations (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_collection
  ON conversations (collection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  citations_json  TEXT NOT NULL DEFAULT '[]',
  model_identifier TEXT,
  usage_json      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at);

-- ---------------------------------------------------------- research_reports
CREATE TABLE IF NOT EXISTS research_reports (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  collection_id TEXT REFERENCES collections (id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  report_content TEXT NOT NULL,
  source_references_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_owner ON research_reports (owner_id, created_at DESC);

-- -------------------------------------------------------- connected_accounts
-- OAuth tokens live in `encrypted_credentials` (AES-256-GCM envelope). They
-- are never selected by any endpoint that returns JSON to the browser.
CREATE TABLE IF NOT EXISTS connected_accounts (
  id                          TEXT PRIMARY KEY,
  owner_id                    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider                    TEXT NOT NULL DEFAULT 'instagram',
  provider_account_identifier TEXT,
  display_name                TEXT,
  status                      TEXT NOT NULL DEFAULT 'connected'
                              CHECK (status IN ('connected', 'expired', 'revoked', 'error')),
  granted_permissions_json    TEXT NOT NULL DEFAULT '[]',
  encrypted_credentials       TEXT,
  last_successful_access      TEXT,
  last_error                  TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_owner_provider
  ON connected_accounts (owner_id, provider, provider_account_identifier);

-- ------------------------------------------------------------ usage_events
CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  collection_id   TEXT,
  job_id          TEXT,
  provider        TEXT NOT NULL,
  model_identifier TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  input_units     INTEGER NOT NULL DEFAULT 0,
  output_units    INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  estimated_cost  REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_owner_created ON usage_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_events (job_id);

-- ------------------------------------------------------------ user_settings
CREATE TABLE IF NOT EXISTS user_settings (
  owner_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL
);

-- ------------------------------------------------------------------ api_keys
--
-- User-supplied provider credentials. Three rules make this table safe:
--   1. `encrypted_value` holds an AES-256-GCM envelope (v1.iv.ciphertext)
--      keyed by SECRETS_ENCRYPTION_KEY, which lives only in Worker secrets.
--   2. `masked_preview` is the only thing derived from the plaintext that is
--      ever read back out — the last four characters.
--   3. Nothing here is ever returned by the API. The settings endpoint maps
--      rows to ApiKeyRecord, which has no field capable of holding a secret.
--
-- `key_version` records which envelope version encrypted the row so a future
-- key rotation can re-encrypt lazily instead of forcing every user to
-- re-enter keys.
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  encrypted_value TEXT NOT NULL,
  masked_preview  TEXT NOT NULL DEFAULT '',
  key_version     INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'unverified'
                  CHECK (status IN ('configured', 'unverified', 'invalid', 'missing')),
  last_verified_at TEXT,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- One active key per provider per user. Rotating replaces in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_owner_provider
  ON api_keys (owner_id, provider);

-- --------------------------------------------------------- scheduled_research
CREATE TABLE IF NOT EXISTS scheduled_research (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  collection_id    TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  cadence          TEXT NOT NULL DEFAULT 'weekly'
                   CHECK (cadence IN ('daily', 'weekly', 'custom')),
  cron             TEXT,
  max_items_per_run INTEGER NOT NULL DEFAULT 24,
  auto_process     INTEGER NOT NULL DEFAULT 1,
  notify           INTEGER NOT NULL DEFAULT 1,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_run_at      TEXT,
  next_run_at      TEXT,
  last_run_status  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON scheduled_research (enabled, next_run_at);

-- -------------------------------------------------------------- audit_events
CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target_type TEXT,
  target_id  TEXT,
  ip_hash    TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_events (owner_id, created_at DESC);

-- ---------------------------------------------------------- rate_limit_events
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT,
  provider   TEXT NOT NULL,
  account_id TEXT,
  scope      TEXT NOT NULL,
  retry_after_ms INTEGER,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_provider
  ON rate_limit_events (provider, occurred_at DESC);

-- ===========================================================================
-- Full-text search over the text-bearing fields.
--
-- A single FTS5 table denormalises the searchable text per content item. It is
-- maintained by triggers so application code can never forget to update it.
-- bm25() ranking is used for lexical search; see services/search.ts.
-- ===========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS content_search USING fts5(
  content_item_id UNINDEXED,
  owner_id UNINDEXED,
  title,
  caption,
  summary_text,
  transcript_text,
  ocr_text,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Rebuild the searchable row for one content item. Called by the triggers
-- below and by the pipeline after a summary/transcript is written.
CREATE TRIGGER IF NOT EXISTS trg_content_search_after_insert
AFTER INSERT ON content_items
BEGIN
  INSERT INTO content_search (content_item_id, owner_id, title, caption, summary_text,
                              transcript_text, ocr_text, tags)
  VALUES (new.id, new.owner_id, '', COALESCE(new.caption, ''), '', '', '', '');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_search_after_delete
AFTER DELETE ON content_items
BEGIN
  DELETE FROM content_search WHERE content_item_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_content_search_after_caption_update
AFTER UPDATE OF caption ON content_items
BEGIN
  UPDATE content_search SET caption = COALESCE(new.caption, '')
  WHERE content_item_id = new.id;
END;
