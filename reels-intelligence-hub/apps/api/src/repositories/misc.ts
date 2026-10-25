import {
  DEFAULT_COLLECTION_SETTINGS,
  randomId,
  type ConnectedAccount,
  type ScheduledResearch,
  type SettingsPayload,
  type UsageEvent,
} from '@rih/shared';
import { all, first, nowIso, run } from '../db/client.js';
import { toConnectedAccount, toScheduledResearch, toUsageEvent } from '../db/mappers.js';

/** Smaller repositories grouped together: usage, settings, accounts, schedules, audit. */

/* ------------------------------------------------------------------ usage */

export async function recordUsage(
  db: D1Database,
  input: {
    ownerId: string;
    collectionId: string | null;
    jobId: string | null;
    provider: string;
    modelIdentifier: string;
    operationType: string;
    inputUnits?: number;
    outputUnits?: number;
    durationMs?: number;
    estimatedCost?: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO usage_events
       (id, owner_id, collection_id, job_id, provider, model_identifier, operation_type,
        input_units, output_units, duration_ms, estimated_cost, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      input.ownerId,
      input.collectionId,
      input.jobId,
      input.provider,
      input.modelIdentifier,
      input.operationType,
      input.inputUnits ?? 0,
      input.outputUnits ?? 0,
      input.durationMs ?? 0,
      input.estimatedCost ?? 0,
      nowIso(),
    ],
  );
}

export async function listUsage(
  db: D1Database,
  ownerId: string,
  limit = 100,
): Promise<UsageEvent[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    'SELECT * FROM usage_events WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?',
    [ownerId, limit],
  );
  return rows.map(toUsageEvent);
}

export interface UsageSummary {
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalAudioSeconds: number;
  byProvider: Array<{ provider: string; calls: number; costUsd: number }>;
  byOperation: Array<{ operation: string; calls: number; costUsd: number }>;
  byDay: Array<{ day: string; costUsd: number; calls: number }>;
}

export async function usageSummary(db: D1Database, ownerId: string): Promise<UsageSummary> {
  const totals = await first<{
    total_cost: number;
    total_calls: number;
    input_units: number;
    output_units: number;
  }>(
    db,
    `SELECT COALESCE(SUM(estimated_cost), 0) AS total_cost,
            COUNT(*) AS total_calls,
            COALESCE(SUM(input_units), 0) AS input_units,
            COALESCE(SUM(output_units), 0) AS output_units
       FROM usage_events WHERE owner_id = ?`,
    [ownerId],
  );

  const byProvider = await all<{ provider: string; calls: number; cost_usd: number }>(
    db,
    `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(estimated_cost), 0) AS cost_usd
       FROM usage_events WHERE owner_id = ? GROUP BY provider ORDER BY cost_usd DESC`,
    [ownerId],
  );

  const byOperation = await all<{ operation: string; calls: number; cost_usd: number }>(
    db,
    `SELECT operation_type AS operation, COUNT(*) AS calls,
            COALESCE(SUM(estimated_cost), 0) AS cost_usd
       FROM usage_events WHERE owner_id = ? GROUP BY operation_type ORDER BY cost_usd DESC`,
    [ownerId],
  );

  const byDay = await all<{ day: string; cost_usd: number; calls: number }>(
    db,
    `SELECT substr(created_at, 1, 10) AS day,
            COALESCE(SUM(estimated_cost), 0) AS cost_usd,
            COUNT(*) AS calls
       FROM usage_events
      WHERE owner_id = ? AND created_at >= ?
      GROUP BY day ORDER BY day ASC`,
    [ownerId, new Date(Date.now() - 29 * 86_400_000).toISOString()],
  );

  return {
    totalCostUsd: totals?.total_cost ?? 0,
    totalCalls: totals?.total_calls ?? 0,
    totalInputTokens: totals?.input_units ?? 0,
    totalOutputTokens: totals?.output_units ?? 0,
    totalAudioSeconds: 0,
    byProvider: byProvider.map((r) => ({
      provider: r.provider,
      calls: r.calls,
      costUsd: r.cost_usd,
    })),
    byOperation: byOperation.map((r) => ({
      operation: r.operation,
      calls: r.calls,
      costUsd: r.cost_usd,
    })),
    byDay: byDay.map((r) => ({ day: r.day, costUsd: r.cost_usd, calls: r.calls })),
  };
}

/* --------------------------------------------------------------- settings */

export const DEFAULT_SETTINGS: SettingsPayload = {
  general: {
    displayName: '',
    theme: 'dark',
    language: 'en',
    defaultCollectionBehavior: 'reuse',
    defaultSummaryDepth: DEFAULT_COLLECTION_SETTINGS.summaryDepth,
  },
  ai: {
    defaultProvider: 'openai',
    textModel: 'gpt-4.1-mini',
    embeddingModel: 'text-embedding-3-small',
    transcriptionModel: 'whisper-1',
    visionModel: 'gpt-4.1-mini',
  },
  processing: {
    maxConcurrency: 3,
    retryMaxAttempts: 5,
    retryBaseDelayMs: 2000,
    maxItemsPerRun: 24,
    cooldownSeconds: 30,
  },
  storage: {
    retentionDays: 365,
    keepOriginalMedia: false,
  },
  notifications: {
    jobCompletion: true,
    jobFailure: true,
    researchUpdates: true,
    usageThresholdUsd: 25,
    reauthorizationRequests: true,
  },
};

export async function getSettings(db: D1Database, ownerId: string): Promise<SettingsPayload> {
  const row = await first<{ settings_json: string }>(
    db,
    'SELECT settings_json FROM user_settings WHERE owner_id = ?',
    [ownerId],
  );

  let stored: Partial<SettingsPayload> = {};
  if (row?.settings_json) {
    try {
      stored = JSON.parse(row.settings_json) as Partial<SettingsPayload>;
    } catch {
      stored = {};
    }
  }

  // Deep-merge so a settings row written by an older version still renders.
  return {
    general: { ...DEFAULT_SETTINGS.general, ...(stored.general ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) },
    processing: { ...DEFAULT_SETTINGS.processing, ...(stored.processing ?? {}) },
    storage: { ...DEFAULT_SETTINGS.storage, ...(stored.storage ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(stored.notifications ?? {}) },
  };
}

/** A patch where each section may itself be partial. */
export type SettingsPatch = {
  [K in keyof SettingsPayload]?: Partial<SettingsPayload[K]>;
};

export async function saveSettings(
  db: D1Database,
  ownerId: string,
  patch: SettingsPatch,
): Promise<SettingsPayload> {
  const current = await getSettings(db, ownerId);
  const merged: SettingsPayload = {
    general: { ...current.general, ...(patch.general ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    processing: { ...current.processing, ...(patch.processing ?? {}) },
    storage: { ...current.storage, ...(patch.storage ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  };

  await run(
    db,
    `INSERT INTO user_settings (owner_id, settings_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (owner_id) DO UPDATE SET settings_json = excluded.settings_json,
       updated_at = excluded.updated_at`,
    [ownerId, JSON.stringify(merged), nowIso()],
  );
  return merged;
}

/* -------------------------------------------------------- connected accounts */

export async function listConnectedAccounts(
  db: D1Database,
  ownerId: string,
): Promise<ConnectedAccount[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT id, owner_id, provider, provider_account_identifier, display_name, status,
            granted_permissions_json, last_successful_access, last_error, created_at, updated_at
       FROM connected_accounts WHERE owner_id = ? ORDER BY created_at DESC`,
    [ownerId],
  );
  return rows.map(toConnectedAccount);
}

export async function upsertConnectedAccount(
  db: D1Database,
  input: {
    ownerId: string;
    provider: string;
    providerAccountIdentifier: string | null;
    displayName: string | null;
    grantedPermissions: string[];
    encryptedCredentials: string | null;
    status?: ConnectedAccount['status'];
  },
): Promise<void> {
  const now = nowIso();
  const existing = await first<{ id: string }>(
    db,
    `SELECT id FROM connected_accounts
      WHERE owner_id = ? AND provider = ? AND provider_account_identifier IS ?`,
    [input.ownerId, input.provider, input.providerAccountIdentifier],
  );

  if (existing) {
    await run(
      db,
      `UPDATE connected_accounts
          SET display_name = ?, granted_permissions_json = ?, encrypted_credentials = ?,
              status = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`,
      [
        input.displayName,
        JSON.stringify(input.grantedPermissions),
        input.encryptedCredentials,
        input.status ?? 'connected',
        now,
        existing.id,
      ],
    );
    return;
  }

  await run(
    db,
    `INSERT INTO connected_accounts
       (id, owner_id, provider, provider_account_identifier, display_name, status,
        granted_permissions_json, encrypted_credentials, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      input.ownerId,
      input.provider,
      input.providerAccountIdentifier,
      input.displayName,
      input.status ?? 'connected',
      JSON.stringify(input.grantedPermissions),
      input.encryptedCredentials,
      now,
      now,
    ],
  );
}

export async function getEncryptedAccountCredentials(
  db: D1Database,
  ownerId: string,
  accountId: string,
): Promise<string | null> {
  const row = await first<{ encrypted_credentials: string | null }>(
    db,
    'SELECT encrypted_credentials FROM connected_accounts WHERE id = ? AND owner_id = ?',
    [accountId, ownerId],
  );
  return row?.encrypted_credentials ?? null;
}

export async function markAccountAccess(
  db: D1Database,
  accountId: string,
  patch: { status?: ConnectedAccount['status']; error?: string | null; success?: boolean },
): Promise<void> {
  const now = nowIso();
  if (patch.success) {
    await run(
      db,
      'UPDATE connected_accounts SET last_successful_access = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ?',
      [now, patch.status ?? 'connected', now, accountId],
    );
  } else {
    await run(
      db,
      'UPDATE connected_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
      [patch.status ?? 'error', patch.error ?? null, now, accountId],
    );
  }
}

export async function deleteConnectedAccount(
  db: D1Database,
  ownerId: string,
  accountId: string,
): Promise<void> {
  await run(db, 'DELETE FROM connected_accounts WHERE id = ? AND owner_id = ?', [
    accountId,
    ownerId,
  ]);
}

/* ---------------------------------------------------------------- schedules */

export async function listSchedules(db: D1Database, ownerId: string): Promise<ScheduledResearch[]> {
  const rows = await all<Record<string, unknown>>(
    db,
    'SELECT * FROM scheduled_research WHERE owner_id = ? ORDER BY created_at DESC',
    [ownerId],
  );
  return rows.map(toScheduledResearch);
}

export async function createSchedule(
  db: D1Database,
  input: {
    ownerId: string;
    collectionId: string;
    cadence: 'daily' | 'weekly' | 'custom';
    cron: string | null;
    maxItemsPerRun: number;
    autoProcess: boolean;
    notify: boolean;
    enabled: boolean;
    nextRunAt: string | null;
  },
): Promise<void> {
  const now = nowIso();
  await run(
    db,
    `INSERT INTO scheduled_research
       (id, owner_id, collection_id, cadence, cron, max_items_per_run, auto_process,
        notify, enabled, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      input.ownerId,
      input.collectionId,
      input.cadence,
      input.cron,
      input.maxItemsPerRun,
      input.autoProcess ? 1 : 0,
      input.notify ? 1 : 0,
      input.enabled ? 1 : 0,
      input.nextRunAt,
      now,
      now,
    ],
  );
}

export async function setScheduleEnabled(
  db: D1Database,
  ownerId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  await run(
    db,
    'UPDATE scheduled_research SET enabled = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [enabled ? 1 : 0, nowIso(), scheduleId, ownerId],
  );
}

export async function deleteSchedule(
  db: D1Database,
  ownerId: string,
  scheduleId: string,
): Promise<void> {
  await run(db, 'DELETE FROM scheduled_research WHERE id = ? AND owner_id = ?', [
    scheduleId,
    ownerId,
  ]);
}

export async function listDueSchedules(db: D1Database, limit = 20) {
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT * FROM scheduled_research
      WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at ASC LIMIT ?`,
    [nowIso(), limit],
  );
  return rows.map(toScheduledResearch);
}

export async function markScheduleRun(
  db: D1Database,
  scheduleId: string,
  nextRunAt: string | null,
  status: string,
): Promise<void> {
  const now = nowIso();
  await run(
    db,
    'UPDATE scheduled_research SET last_run_at = ?, next_run_at = ?, last_run_status = ?, updated_at = ? WHERE id = ?',
    [now, nextRunAt, status, now, scheduleId],
  );
}

/* -------------------------------------------------------------------- audit */

export async function recordAudit(
  db: D1Database,
  input: {
    ownerId: string | null;
    actorId: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO audit_events
       (id, owner_id, actor_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomId(),
      input.ownerId,
      input.actorId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    ],
  );
}
