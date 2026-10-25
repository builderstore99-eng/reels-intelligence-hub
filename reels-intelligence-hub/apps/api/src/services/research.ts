import {
  AppError,
  collectionNameForSource,
  ERROR_CODES,
  parseInstagramSource,
  randomId,
  type Collection,
  type JobType,
  type ResearchJob,
  type SettingsPayload,
} from '@rih/shared';
import type { Env, PipelineMessage } from '../env.js';
import { isDemoEnabled } from './instagram.js';
import { demoProvider, instagramGraphProvider } from './instagram.js';
import {
  addItemToCollection,
  createCollection,
  findCollectionBySource,
  getCollection,
  touchCollection,
} from '../repositories/collections.js';
import { upsertItem } from '../repositories/content.js';
import {
  addJobItem,
  createJob,
  findActiveJob,
  recalcJobProgress,
  recordEvent,
  setJobStatus,
} from '../repositories/jobs.js';
import { getSettings } from '../repositories/misc.js';

/**
 * Research orchestration.
 *
 * The flow for every research type is the same shape:
 *
 *   validate → authorise → resolve collection → create job → discover items
 *   → persist items → enqueue one message per item → return immediately.
 *
 * Discovery happens inline because it is bounded (one paginated provider call),
 * and doing it inline means the user gets a truthful "found N items" answer
 * before the request returns. All the expensive work — transcription, vision,
 * summarisation, embeddings — happens in the queue.
 */

export type ResearchKind = JobType;

export interface ResearchOptions {
  maxItems: number;
  reprocessExisting: boolean;
  summaryDepth: 'brief' | 'standard' | 'deep';
  transcribeAudio: boolean;
  analyzeVisuals: boolean;
  autoTag: boolean;
  skipDuplicates: boolean;
}

export const DEFAULT_RESEARCH_OPTIONS: ResearchOptions = {
  maxItems: 24,
  reprocessExisting: false,
  summaryDepth: 'standard',
  transcribeAudio: true,
  analyzeVisuals: true,
  autoTag: true,
  skipDuplicates: true,
};

export interface StartResearchInput {
  kind: ResearchKind;
  source?: string;
  query?: string;
  collectionName?: string;
  collectionId?: string;
  accountId?: string;
  useDemoData?: boolean;
  options?: Partial<ResearchOptions>;
}

export interface StartResearchResult {
  collection: Collection;
  job: ResearchJob;
  discovered: number;
  skipped: number;
  providerUsed: string;
  /** Set when some or all discovery failed but the job still exists. */
  warning: string | null;
}

export async function startResearch(
  env: Env,
  db: D1Database,
  ownerId: string,
  input: StartResearchInput,
): Promise<StartResearchResult> {
  const options: ResearchOptions = { ...DEFAULT_RESEARCH_OPTIONS, ...(input.options ?? {}) };

  if (options.maxItems < 1 || options.maxItems > 200) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Choose between 1 and 200 items per run.');
  }

  const settings = await getSettings(db, ownerId);
  const useDemo = Boolean(input.useDemoData) && isDemoEnabled(env);
  const provider = useDemo ? demoProvider : instagramGraphProvider;

  /* 1. Resolve the collection. ------------------------------------------- */
  let collection: Collection;
  let sourceIdentifier: string | null = null;

  if (input.collectionId) {
    collection = await getCollection(db, ownerId, input.collectionId);
  } else if (input.kind === 'topic_research') {
    const name = input.collectionName?.trim() || (input.query ?? 'Topic research').slice(0, 80);
    collection = await createCollection(db, ownerId, {
      name,
      collectionType: 'topic_research',
      settings: {
        summaryDepth: options.summaryDepth,
        transcribeAudio: options.transcribeAudio,
        analyzeVisuals: options.analyzeVisuals,
        autoTag: options.autoTag,
        skipDuplicates: options.skipDuplicates,
      },
    });
  } else {
    const parsed = parseInstagramSource(input.source ?? '');
    if (!parsed) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_SOURCE,
        'That source is not a supported Instagram profile or post URL.',
      );
    }
    sourceIdentifier = parsed.sourceIdentifier;
    const existing = await findCollectionBySource(db, ownerId, sourceIdentifier);
    const name = input.collectionName?.trim() || collectionNameForSource(parsed);

    if (existing && settings.general.defaultCollectionBehavior === 'reuse') {
      collection = existing;
    } else {
      collection = await createCollection(db, ownerId, {
        name,
        collectionType:
          input.kind === 'design_documents' ? 'design_references' : 'instagram_profile',
        sourceIdentifier,
        settings: {
          summaryDepth: options.summaryDepth,
          transcribeAudio: options.transcribeAudio,
          analyzeVisuals: options.analyzeVisuals,
          autoTag: options.autoTag,
          skipDuplicates: options.skipDuplicates,
        },
      });
    }
  }

  /* 2. Refuse to double-queue the same collection. ----------------------- */
  const jobType: JobType = input.kind;
  const active = await findActiveJob(db, collection.id, jobType);
  if (active) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      `A ${jobType.replace('_', ' ')} job is already running for "${collection.name}". Wait for it to finish, or pause it on the Live Monitor first.`,
      { details: { jobId: active.id } },
    );
  }

  /* 3. Create the job. --------------------------------------------------- */
  const job = await createJob(db, {
    ownerId,
    collectionId: collection.id,
    jobType,
    configuration: {
      ...options,
      source: input.source ?? null,
      query: input.query ?? null,
      provider: provider.slug,
    },
  });

  await recordEvent(db, {
    jobId: job.id,
    eventType: 'job_created',
    message: `Job created for ${provider.slug} ${input.kind.replace('_', ' ')}.`,
  });

  /* 4. Discover. --------------------------------------------------------- */
  const discovered: Array<Awaited<ReturnType<typeof upsertItem>>['item']> = [];
  let skipped = 0;
  let warning: string | null = null;

  try {
    await setJobStatus(db, job.id, 'running');
    await touchCollection(db, collection.id, 'processing');

    const items =
      input.kind === 'topic_research'
        ? await (provider.searchTopic?.(env, db, ownerId, input.query ?? '', options.maxItems) ??
            Promise.reject(
              new AppError(
                ERROR_CODES.UNSUPPORTED_SOURCE,
                `${provider.slug} does not support topic search.`,
              ),
            ))
        : await provider.discover(env, db, ownerId, {
            source: input.source ?? '',
            maxItems: options.maxItems,
            useDemoData: useDemo,
            ...(input.accountId ? { accountId: input.accountId } : {}),
          });

    if (items.length === 0) {
      warning = 'The provider returned no accessible items for this source.';
      await recordEvent(db, {
        jobId: job.id,
        eventType: 'job_failed',
        message: warning,
      });
      await setJobStatus(db, job.id, 'completed', { errorSummary: warning });
      await touchCollection(db, collection.id, 'active');
      return {
        collection: await getCollection(db, ownerId, collection.id),
        job: (await recalcJobProgress(db, job.id)) ?? job,
        discovered: 0,
        skipped: 0,
        providerUsed: provider.slug,
        warning,
      };
    }

    await recordEvent(db, {
      jobId: job.id,
      eventType: 'item_discovered',
      message: `Discovered ${items.length} accessible item${items.length === 1 ? '' : 's'}.`,
      metadata: { provider: provider.slug },
    });

    for (const item of items.slice(0, options.maxItems)) {
      const { item: stored, created } = await upsertItem(db, ownerId, {
        sourceProvider: item.sourceProvider,
        sourceIdentifier: item.sourceIdentifier,
        sourceUrl: item.sourceUrl,
        creatorIdentifier: item.creatorIdentifier,
        contentType: item.contentType,
        caption: item.caption,
        publishedAt: item.publishedAt,
        thumbnailReference: item.thumbnailReference,
        metadata: { ...item.metadata, mediaUrl: item.mediaUrl },
      });

      if (!created && !options.reprocessExisting) {
        // Already analysed: attach to the collection but do not re-queue.
        await addItemToCollection(db, collection.id, stored.id, 'discovery');
        skipped += 1;
        await recordEvent(db, {
          jobId: job.id,
          eventType: 'duplicate_detected',
          message: `Skipped an item that was already saved (${stored.sourceIdentifier}).`,
          metadata: { contentItemId: stored.id },
        });
        continue;
      }

      await addItemToCollection(db, collection.id, stored.id, 'discovery');
      const jobItemId = await addJobItem(db, {
        jobId: job.id,
        contentItemId: stored.id,
        stage: 'metadata',
      });
      discovered.push(stored);

      const message: PipelineMessage = {
        type: 'process_item',
        jobId: job.id,
        jobItemId,
        contentItemId: stored.id,
        ownerId,
        attempt: 1,
        enqueuedAt: new Date().toISOString(),
      };
      await env.PIPELINE.send(message);
    }
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(ERROR_CODES.INTERNAL_ERROR, 'Discovery failed unexpectedly.');

    await recordEvent(db, {
      jobId: job.id,
      eventType: 'job_failed',
      message: appError.message,
      metadata: { code: appError.code, retryable: appError.retryable },
    });
    await setJobStatus(db, job.id, 'failed', { errorSummary: appError.message });
    await touchCollection(db, collection.id, 'active');
    throw appError;
  }

  const updated = await recalcJobProgress(db, job.id);

  await recordEvent(db, {
    jobId: job.id,
    eventType: 'processing_started',
    message: `Queued ${discovered.length} item${discovered.length === 1 ? '' : 's'} for processing.`,
    metadata: { skipped },
  });

  if (discovered.length === 0 && skipped > 0) {
    warning = 'Every discovered item was already saved in this collection.';
    await setJobStatus(db, job.id, 'completed', { errorSummary: warning });
    await touchCollection(db, collection.id, 'active');
  }

  return {
    collection: await getCollection(db, ownerId, collection.id),
    job: updated ?? job,
    discovered: discovered.length,
    skipped,
    providerUsed: provider.slug,
    warning,
  };
}

/** Health of the research subsystem, surfaced on Settings → Integrations. */
export interface ResearchReadiness {
  instagramConfigured: boolean;
  demoEnabled: boolean;
  aiConfigured: boolean;
  summary: string;
}

export async function researchReadiness(
  env: Env,
  db: D1Database,
  ownerId: string,
  settings: SettingsPayload,
): Promise<ResearchReadiness> {
  const instagramConfigured = Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
  const demoEnabled = isDemoEnabled(env);

  const { hasProviderKey } = await import('./apiKeys.js');
  const providerForText = settings.ai.textModel.startsWith('@cf/')
    ? 'cloudflare'
    : settings.ai.textModel.startsWith('claude')
      ? 'anthropic'
      : settings.ai.textModel.startsWith('gemini')
        ? 'google-ai'
        : 'openai';
  const aiConfigured =
    providerForText === 'cloudflare'
      ? true
      : await hasProviderKey(env, db, ownerId, providerForText);

  const summary =
    !instagramConfigured && !demoEnabled
      ? 'No discovery provider is available. Configure Instagram, or enable demo mode for evaluation.'
      : !aiConfigured
        ? 'Discovery works, but no AI key is configured — items will be collected and left unanalysed. Add a key in Settings → API Keys.'
        : 'Ready. Discovery and AI analysis are both configured.';

  return { instagramConfigured, demoEnabled, aiConfigured, summary };
}

/** Convenience for the cron handler. */
export function newMessageId(): string {
  return randomId(12);
}
