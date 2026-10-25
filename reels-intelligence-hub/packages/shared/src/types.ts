/**
 * Domain types shared by the Worker and the web client.
 *
 * These mirror the D1 schema in apps/api/migrations. When a column changes,
 * change it here too — the Worker maps rows into these shapes in one place
 * (`apps/api/src/db/mappers.ts`) so drift is caught by the compiler.
 */

export type UserRole = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export type CollectionType =
  | 'instagram_profile'
  | 'topic_research'
  | 'design_references'
  | 'manual'
  | 'document_library'
  | 'custom';

export type CollectionStatus = 'active' | 'processing' | 'paused' | 'archived' | 'failed';

export interface Collection {
  id: string;
  ownerId: string;
  name: string;
  normalizedName: string;
  description: string | null;
  collectionType: CollectionType;
  sourceIdentifier: string | null;
  settings: CollectionSettings;
  status: CollectionStatus;
  itemCount: number;
  analyzedCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
}

export type SummaryDepth = 'brief' | 'standard' | 'deep';

export interface CollectionSettings {
  summaryDepth: SummaryDepth;
  transcribeAudio: boolean;
  analyzeVisuals: boolean;
  autoTag: boolean;
  skipDuplicates: boolean;
}

export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  summaryDepth: 'standard',
  transcribeAudio: true,
  analyzeVisuals: true,
  autoTag: true,
  skipDuplicates: true,
};

export type ContentType = 'reel' | 'video' | 'image' | 'carousel' | 'document';
export type ProcessingStatus =
  'discovered' | 'queued' | 'processing' | 'completed' | 'failed' | 'skipped' | 'unsupported';

export interface ContentItem {
  id: string;
  ownerId: string;
  collectionId: string;
  sourceProvider: string;
  sourceIdentifier: string;
  sourceUrl: string;
  creatorIdentifier: string | null;
  contentType: ContentType;
  caption: string | null;
  publishedAt: string | null;
  thumbnailReference: string | null;
  metadata: Record<string, unknown>;
  processingStatus: ProcessingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Summary {
  id: string;
  contentItemId: string;
  summaryType: string;
  title: string | null;
  shortSummary: string | null;
  detailedSummary: string | null;
  mainPoints: string[];
  takeaways: string[];
  visualAnalysis: VisualAnalysis | null;
  sourceReferences: SourceReference[];
  modelIdentifier: string | null;
  createdAt: string;
}

export interface VisualAnalysis {
  dominantColors: string[];
  layoutType: string | null;
  visualHierarchy: string | null;
  typographyNotes: string | null;
  composition: string | null;
  callToActionPlacement: string | null;
  designCategory: string | null;
  observedText: string | null;
  /** Everything in `interpretation` is AI opinion, not observation. */
  interpretation: string | null;
}

export interface SourceReference {
  label: string;
  url: string;
  contentItemId?: string;
}

export interface Transcript {
  id: string;
  contentItemId: string;
  text: string;
  language: string | null;
  segments: TranscriptSegment[];
  provider: string | null;
  createdAt: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Tag {
  id: string;
  name: string;
  normalizedName: string;
  count?: number;
}

export type JobType = 'profile_reels' | 'design_documents' | 'topic_research' | 'scheduled_refresh';
export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ResearchJob {
  id: string;
  ownerId: string;
  collectionId: string;
  jobType: JobType;
  status: JobStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  progress: number;
  configuration: Record<string, unknown>;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type PipelineStage =
  | 'discovery'
  | 'metadata'
  | 'media'
  | 'transcription'
  | 'ocr'
  | 'visual_analysis'
  | 'summarization'
  | 'tagging'
  | 'embedding'
  | 'storage'
  | 'completed';

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'discovery',
  'metadata',
  'media',
  'transcription',
  'ocr',
  'visual_analysis',
  'summarization',
  'tagging',
  'embedding',
  'storage',
  'completed',
] as const;

export type JobItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface JobItem {
  id: string;
  jobId: string;
  contentItemId: string | null;
  stage: PipelineStage;
  status: JobItemStatus;
  attempts: number;
  nextRetryAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobEvent {
  id: string;
  jobId: string;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type ChatScope = 'item' | 'collection' | 'collections' | 'knowledge_base';

export interface Conversation {
  id: string;
  ownerId: string;
  collectionId: string | null;
  title: string;
  scopeType: ChatScope;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Citation {
  contentItemId: string;
  label: string;
  url: string;
  excerpt: string;
  score: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: Citation[];
  modelIdentifier: string | null;
  usage: UsageUnits | null;
  createdAt: string;
}

export interface UsageUnits {
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
}

export interface ResearchReport {
  id: string;
  ownerId: string;
  collectionId: string | null;
  title: string;
  reportContent: string;
  sourceReferences: SourceReference[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedAccount {
  id: string;
  ownerId: string;
  provider: string;
  providerAccountIdentifier: string | null;
  displayName: string | null;
  status: 'connected' | 'expired' | 'revoked' | 'error';
  grantedPermissions: string[];
  lastSuccessfulAccess: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------ API keys --- */

export type ApiKeyStatus = 'configured' | 'unverified' | 'invalid' | 'missing';

/**
 * The shape returned to the browser. Note what is absent: there is no field
 * that can hold the plaintext or the ciphertext of a key. Only a masked
 * preview of the last four characters ever leaves the Worker.
 */
export interface ApiKeyRecord {
  id: string;
  provider: string;
  label: string;
  /** e.g. `••••••••4f2a`. Empty when the value could not be decrypted. */
  maskedPreview: string;
  status: ApiKeyStatus;
  /** True when the key came from a platform env var rather than the user. */
  fromEnvironment: boolean;
  lastVerifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageEvent {
  id: string;
  ownerId: string;
  collectionId: string | null;
  jobId: string | null;
  provider: string;
  modelIdentifier: string;
  operationType: string;
  inputUnits: number;
  outputUnits: number;
  durationMs: number;
  estimatedCost: number;
  createdAt: string;
}

export interface ScheduledResearch {
  id: string;
  ownerId: string;
  collectionId: string;
  cadence: 'daily' | 'weekly' | 'custom';
  cron: string | null;
  maxItemsPerRun: number;
  autoProcess: boolean;
  notify: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/* --------------------------------------------------------------- misc ---- */

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DashboardMetrics {
  totalDiscovered: number;
  totalAnalyzed: number;
  collections: number;
  pendingJobs: number;
  failedJobs: number;
  storageBytes: number;
  aiCostUsd: number;
  aiCalls: number;
}

export interface HealthCheck {
  name: string;
  status: 'ok' | 'degraded' | 'unavailable' | 'not_configured';
  detail: string;
}

export interface SettingsPayload {
  general: {
    displayName: string;
    theme: 'dark' | 'light' | 'system';
    language: string;
    defaultCollectionBehavior: 'reuse' | 'always_new';
    defaultSummaryDepth: SummaryDepth;
  };
  ai: {
    defaultProvider: string;
    textModel: string;
    embeddingModel: string;
    transcriptionModel: string;
    visionModel: string;
  };
  processing: {
    maxConcurrency: number;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    maxItemsPerRun: number;
    cooldownSeconds: number;
  };
  storage: {
    retentionDays: number;
    keepOriginalMedia: boolean;
  };
  notifications: {
    jobCompletion: boolean;
    jobFailure: boolean;
    researchUpdates: boolean;
    usageThresholdUsd: number;
    reauthorizationRequests: boolean;
  };
}
