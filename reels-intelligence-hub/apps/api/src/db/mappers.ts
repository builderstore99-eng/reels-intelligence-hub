import {
  DEFAULT_COLLECTION_SETTINGS,
  type ApiKeyRecord,
  type ApiKeyStatus,
  type ChatMessage,
  type Citation,
  type Collection,
  type CollectionSettings,
  type CollectionStatus,
  type CollectionType,
  type ConnectedAccount,
  type ContentItem,
  type ContentType,
  type Conversation,
  type JobEvent,
  type JobItem,
  type JobItemStatus,
  type JobStatus,
  type JobType,
  type PipelineStage,
  type ProcessingStatus,
  type ResearchJob,
  type ScheduledResearch,
  type SourceReference,
  type Summary,
  type Transcript,
  type TranscriptSegment,
  type UsageEvent,
  type User,
  type UserRole,
  type VisualAnalysis,
} from '@rih/shared';

/**
 * Row → domain mappers.
 *
 * D1 returns snake_case rows with integer booleans and JSON-as-TEXT. Every
 * conversion happens here and nowhere else, so a schema change breaks the
 * build in one file instead of silently producing `undefined` in the UI.
 */

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function nullableStr(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: Row, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function bool(row: Row, key: string, fallback = false): boolean {
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** Parse a JSON column defensively — bad JSON degrades to the fallback. */
function json<T>(row: Row, key: string, fallback: T): T {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toUser(row: Row): User {
  return {
    id: str(row, 'id'),
    email: str(row, 'email'),
    displayName: str(row, 'display_name'),
    role: (str(row, 'role') || 'owner') as UserRole,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toCollection(row: Row): Collection {
  const settings = json<Partial<CollectionSettings>>(row, 'settings_json', {});
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    name: str(row, 'name'),
    normalizedName: str(row, 'normalized_name'),
    description: nullableStr(row, 'description'),
    collectionType: (str(row, 'collection_type') || 'manual') as CollectionType,
    sourceIdentifier: nullableStr(row, 'source_identifier'),
    settings: { ...DEFAULT_COLLECTION_SETTINGS, ...settings },
    status: (str(row, 'status') || 'active') as CollectionStatus,
    itemCount: num(row, 'item_count'),
    analyzedCount: num(row, 'analyzed_count'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
    lastActivityAt: nullableStr(row, 'last_activity_at'),
  };
}

export function toContentItem(row: Row): ContentItem {
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    collectionId: str(row, 'collection_id'),
    sourceProvider: str(row, 'source_provider') || 'instagram',
    sourceIdentifier: str(row, 'source_identifier'),
    sourceUrl: str(row, 'source_url'),
    creatorIdentifier: nullableStr(row, 'creator_identifier'),
    contentType: (str(row, 'content_type') || 'reel') as ContentType,
    caption: nullableStr(row, 'caption'),
    publishedAt: nullableStr(row, 'published_at'),
    thumbnailReference: nullableStr(row, 'thumbnail_reference'),
    metadata: json<Record<string, unknown>>(row, 'metadata_json', {}),
    processingStatus: (str(row, 'processing_status') || 'discovered') as ProcessingStatus,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toTranscript(row: Row): Transcript {
  return {
    id: str(row, 'id'),
    contentItemId: str(row, 'content_item_id'),
    text: str(row, 'text'),
    language: nullableStr(row, 'language'),
    segments: json<TranscriptSegment[]>(row, 'segments_json', []),
    provider: nullableStr(row, 'provider'),
    createdAt: str(row, 'created_at'),
  };
}

export function toSummary(row: Row): Summary {
  return {
    id: str(row, 'id'),
    contentItemId: str(row, 'content_item_id'),
    summaryType: str(row, 'summary_type') || 'standard',
    title: nullableStr(row, 'title'),
    shortSummary: nullableStr(row, 'short_summary'),
    detailedSummary: nullableStr(row, 'detailed_summary'),
    mainPoints: json<string[]>(row, 'main_points_json', []),
    takeaways: json<string[]>(row, 'takeaways_json', []),
    visualAnalysis: json<VisualAnalysis | null>(row, 'visual_analysis_json', null),
    sourceReferences: json<SourceReference[]>(row, 'source_references_json', []),
    modelIdentifier: nullableStr(row, 'model_identifier'),
    createdAt: str(row, 'created_at'),
  };
}

export function toResearchJob(row: Row): ResearchJob {
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    collectionId: str(row, 'collection_id'),
    jobType: (str(row, 'job_type') || 'profile_reels') as JobType,
    status: (str(row, 'status') || 'queued') as JobStatus,
    totalItems: num(row, 'total_items'),
    completedItems: num(row, 'completed_items'),
    failedItems: num(row, 'failed_items'),
    skippedItems: num(row, 'skipped_items'),
    progress: num(row, 'progress'),
    configuration: json<Record<string, unknown>>(row, 'configuration_json', {}),
    errorSummary: nullableStr(row, 'error_summary'),
    createdAt: str(row, 'created_at'),
    startedAt: nullableStr(row, 'started_at'),
    completedAt: nullableStr(row, 'completed_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toJobItem(row: Row): JobItem {
  return {
    id: str(row, 'id'),
    jobId: str(row, 'job_id'),
    contentItemId: nullableStr(row, 'content_item_id'),
    stage: (str(row, 'stage') || 'discovery') as PipelineStage,
    status: (str(row, 'status') || 'pending') as JobItemStatus,
    attempts: num(row, 'attempts'),
    nextRetryAt: nullableStr(row, 'next_retry_at'),
    errorCode: nullableStr(row, 'error_code'),
    errorMessage: nullableStr(row, 'error_message'),
    startedAt: nullableStr(row, 'started_at'),
    completedAt: nullableStr(row, 'completed_at'),
  };
}

export function toJobEvent(row: Row): JobEvent {
  return {
    id: str(row, 'id'),
    jobId: str(row, 'job_id'),
    eventType: str(row, 'event_type'),
    message: str(row, 'message'),
    metadata: json<Record<string, unknown>>(row, 'metadata_json', {}),
    createdAt: str(row, 'created_at'),
  };
}

export function toConversation(row: Row): Conversation {
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    collectionId: nullableStr(row, 'collection_id'),
    title: str(row, 'title'),
    scopeType: (str(row, 'scope_type') || 'collection') as Conversation['scopeType'],
    messageCount: num(row, 'message_count'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toChatMessage(row: Row): ChatMessage {
  return {
    id: str(row, 'id'),
    conversationId: str(row, 'conversation_id'),
    role: (str(row, 'role') || 'user') as ChatMessage['role'],
    content: str(row, 'content'),
    citations: json<Citation[]>(row, 'citations_json', []),
    modelIdentifier: nullableStr(row, 'model_identifier'),
    usage: json<ChatMessage['usage']>(row, 'usage_json', null),
    createdAt: str(row, 'created_at'),
  };
}

export function toConnectedAccount(row: Row): ConnectedAccount {
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    provider: str(row, 'provider') || 'instagram',
    providerAccountIdentifier: nullableStr(row, 'provider_account_identifier'),
    displayName: nullableStr(row, 'display_name'),
    status: (str(row, 'status') || 'connected') as ConnectedAccount['status'],
    grantedPermissions: json<string[]>(row, 'granted_permissions_json', []),
    lastSuccessfulAccess: nullableStr(row, 'last_successful_access'),
    lastError: nullableStr(row, 'last_error'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toUsageEvent(row: Row): UsageEvent {
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    collectionId: nullableStr(row, 'collection_id'),
    jobId: nullableStr(row, 'job_id'),
    provider: str(row, 'provider'),
    modelIdentifier: str(row, 'model_identifier'),
    operationType: str(row, 'operation_type'),
    inputUnits: num(row, 'input_units'),
    outputUnits: num(row, 'output_units'),
    durationMs: num(row, 'duration_ms'),
    estimatedCost: num(row, 'estimated_cost'),
    createdAt: str(row, 'created_at'),
  };
}

export function toScheduledResearch(row: Row): ScheduledResearch {
  return {
    id: str(row, 'id'),
    ownerId: str(row, 'owner_id'),
    collectionId: str(row, 'collection_id'),
    cadence: (str(row, 'cadence') || 'weekly') as ScheduledResearch['cadence'],
    cron: nullableStr(row, 'cron'),
    maxItemsPerRun: num(row, 'max_items_per_run', 24),
    autoProcess: bool(row, 'auto_process', true),
    notify: bool(row, 'notify', true),
    enabled: bool(row, 'enabled', true),
    lastRunAt: nullableStr(row, 'last_run_at'),
    nextRunAt: nullableStr(row, 'next_run_at'),
    lastRunStatus: nullableStr(row, 'last_run_status'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

/**
 * The API-key mapper is deliberately the only place that reads
 * `encrypted_value` — and it does not: it reads `masked_preview` only. There is
 * no code path that maps ciphertext into an API response.
 */
export function toApiKeyRecord(row: Row, fromEnvironment = false): ApiKeyRecord {
  return {
    id: str(row, 'id'),
    provider: str(row, 'provider'),
    label: str(row, 'label'),
    maskedPreview: str(row, 'masked_preview'),
    status: (str(row, 'status') || 'unverified') as ApiKeyStatus,
    fromEnvironment,
    lastVerifiedAt: nullableStr(row, 'last_verified_at'),
    lastUsedAt: nullableStr(row, 'last_used_at'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}
