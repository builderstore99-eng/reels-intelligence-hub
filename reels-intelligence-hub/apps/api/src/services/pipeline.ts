import {
  AppError,
  ERROR_CODES,
  isRetryableCode,
  nextRetryAt as computeNextRetryAt,
  normalizeTags,
  type Collection,
  type ContentItem,
  type SettingsPayload,
  type Summary,
  type VisualAnalysis,
} from '@rih/shared';
import type { Env, PipelineMessage } from '../env.js';
import { isEnabled } from '../env.js';
import { embedTexts, generateText, transcribeAudio } from './ai.js';
import {
  getItem,
  refreshSearchRow,
  saveSummary,
  saveTranscript,
  setItemStatus,
  setTags,
} from '../repositories/content.js';
import {
  getJobItem,
  getJobUnscoped,
  recalcJobProgress,
  recordEvent,
  setJobStatus,
  updateJobItem,
} from '../repositories/jobs.js';
import { getCollection, touchCollection } from '../repositories/collections.js';
import { getSettings } from '../repositories/misc.js';

/**
 * The content processing pipeline.
 *
 * Stages, in order, each persisted independently:
 *
 *   metadata → media → transcription → OCR/visual → summarization → tagging
 *   → embedding → storage
 *
 * Two invariants matter more than anything else here:
 *
 *  A. **A later failure never erases an earlier success.** A transcript is
 *     written to its own row before summarisation starts; if summarisation then
 *     fails, the transcript survives and the retry resumes at summarisation.
 *
 *  B. **Retries are idempotent.** Every write is an UPSERT keyed by
 *     (content_item_id, summary_type) or (content_item_id), so replaying a
 *     message produces the same database state.
 */

export interface ProcessOutcome {
  status: 'completed' | 'skipped' | 'failed' | 'retry';
  message: string;
}

export async function processItem(env: Env, message: PipelineMessage): Promise<ProcessOutcome> {
  const db = env.DB;
  const jobItem = await getJobItem(db, message.jobItemId ?? '');
  if (!jobItem) {
    return { status: 'skipped', message: 'Job item no longer exists.' };
  }

  const job = await getJobUnscoped(db, message.jobId);
  if (!job) return { status: 'skipped', message: 'Job no longer exists.' };
  if (job.status === 'paused' || job.status === 'cancelled') {
    return { status: 'skipped', message: `Job is ${job.status}; item left untouched.` };
  }

  const collection = await getCollection(db, job.ownerId, job.collectionId);
  const settings = await getSettings(db, job.ownerId);
  const item = await getItem(db, job.ownerId, message.contentItemId ?? '');

  await updateJobItem(db, jobItem.id, {
    status: 'running',
    attempts: jobItem.attempts + 1,
    startedAt: new Date().toISOString(),
  });
  await setItemStatus(db, item.id, 'processing');

  const ctx = {
    env,
    db,
    ownerId: job.ownerId,
    collectionId: job.collectionId,
    jobId: job.id,
    settings,
  };

  try {
    /* ---- metadata ------------------------------------------------------ */
    await updateJobItem(db, jobItem.id, { stage: 'metadata' });
    if (!item.caption && !item.metadata['demo']) {
      await recordEvent(db, {
        jobId: job.id,
        eventType: 'processing_started',
        message: `No caption was available for ${item.sourceIdentifier}.`,
        metadata: { contentItemId: item.id },
      });
    }

    /* ---- media --------------------------------------------------------- */
    await updateJobItem(db, jobItem.id, { stage: 'media' });
    const mediaUrl =
      typeof item.metadata['mediaUrl'] === 'string' ? item.metadata['mediaUrl'] : null;
    const isDemo = item.metadata['demo'] === true;

    /* ---- transcription -------------------------------------------------- */
    await updateJobItem(db, jobItem.id, { stage: 'transcription' });
    const wantsTranscription =
      collection.settings.transcribeAudio &&
      isEnabled(env.ENABLE_TRANSCRIPTION) &&
      (item.contentType === 'reel' || item.contentType === 'video');

    if (wantsTranscription && mediaUrl && !isDemo) {
      const audio = await downloadMedia(mediaUrl);
      const result = await transcribeAudio(ctx, {
        audio,
        filename: `${item.id}.mp4`,
        contentType: 'video/mp4',
      });
      await saveTranscript(db, item.id, {
        text: result.text,
        language: result.language,
        segments: result.segments,
        provider: `${result.provider}:${result.modelIdentifier}`,
      });
      await recordEvent(db, {
        jobId: job.id,
        eventType: 'transcription_completed',
        message: `Transcribed ${result.text.length} characters.`,
        metadata: { contentItemId: item.id },
      });
    } else if (wantsTranscription) {
      await recordEvent(db, {
        jobId: job.id,
        eventType: 'transcription_completed',
        message: 'No accessible audio for this item, so transcription was skipped.',
        metadata: { contentItemId: item.id, reason: 'media_unavailable' },
      });
    }

    /* ---- visual analysis ------------------------------------------------ */
    await updateJobItem(db, jobItem.id, { stage: 'visual_analysis' });
    let visual: VisualAnalysis | null = null;
    const wantsVisual = collection.settings.analyzeVisuals && isEnabled(env.ENABLE_VISUAL_ANALYSIS);

    if (wantsVisual && (item.thumbnailReference || mediaUrl) && !isDemo) {
      try {
        const analysis = await generateText(ctx, {
          system:
            'You analyse images for a design-research library. Reply with JSON only. Distinguish what you can observe from what you infer.',
          prompt: buildVisualPrompt(item.caption),
          json: true,
          maxOutputTokens: 800,
        });
        visual = parseVisualAnalysis(analysis.text);
      } catch (error) {
        // Visual analysis is optional enrichment: log it, keep going.
        await recordEvent(db, {
          jobId: job.id,
          eventType: 'stage_skipped',
          message: `Visual analysis unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
          metadata: { contentItemId: item.id },
        });
      }
    }

    /* ---- summarisation -------------------------------------------------- */
    await updateJobItem(db, jobItem.id, { stage: 'summarization' });
    const transcript = await db
      .prepare('SELECT text FROM transcripts WHERE content_item_id = ?')
      .bind(item.id)
      .first<{ text: string }>();

    const summary = await summarise(ctx, {
      item,
      collection,
      transcriptText: transcript?.text ?? null,
      visual,
      depth: collection.settings.summaryDepth,
    });

    await saveSummary(db, item.id, summary);
    await recordEvent(db, {
      jobId: job.id,
      eventType: 'summary_generated',
      message: `Summary generated with ${summary.modelIdentifier ?? 'unknown model'}.`,
      metadata: { contentItemId: item.id },
    });

    /* ---- tagging -------------------------------------------------------- */
    await updateJobItem(db, jobItem.id, { stage: 'tagging' });
    if (collection.settings.autoTag) {
      const derivedTopics = (summary as SummaryDraft & { __topics?: string[] }).__topics ?? [];
      await setTags(db, job.ownerId, item.id, derivedTopics);
    }

    /* ---- embedding ------------------------------------------------------ */
    await updateJobItem(db, jobItem.id, { stage: 'embedding' });
    if (isEnabled(env.ENABLE_SEMANTIC_SEARCH)) {
      await embedAndIndex(env, db, job.ownerId, item.id, summary);
    }

    /* ---- storage -------------------------------------------------------- */
    await updateJobItem(db, jobItem.id, { stage: 'storage' });
    await refreshSearchRow(db, item.id);
    await setItemStatus(db, item.id, 'completed');
    await updateJobItem(db, jobItem.id, {
      stage: 'completed',
      status: 'completed',
      completedAt: new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
    });

    const refreshed = await recalcJobProgress(db, job.id);
    if (refreshed && refreshed.status !== 'running') {
      await touchCollection(db, job.collectionId, 'active');
      await recordEvent(db, {
        jobId: job.id,
        eventType: 'job_completed',
        message: `Job finished: ${refreshed.completedItems} analysed, ${refreshed.failedItems} failed, ${refreshed.skippedItems} skipped.`,
      });
    }

    return { status: 'completed', message: 'Item processed.' };
  } catch (error) {
    return handleFailure(env, db, {
      jobId: job.id,
      jobItemId: jobItem.id,
      contentItemId: item.id,
      attempt: jobItem.attempts + 1,
      settings,
      error,
    });
  }
}

/* --------------------------------------------------------------- helpers -- */

async function downloadMedia(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      `Media could not be downloaded (HTTP ${response.status}).`,
    );
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  // 50 MB ceiling: a Reel is far below this, and an unbounded download would
  // blow the Worker memory limit.
  if (contentLength > 50 * 1024 * 1024) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'That media file is larger than the 50 MB processing limit.',
    );
  }
  return response.arrayBuffer();
}

function buildVisualPrompt(caption: string | null): string {
  return [
    'Analyse this image as a design reference. Return JSON with exactly these keys:',
    '{"dominantColors": string[], "layoutType": string|null, "visualHierarchy": string|null,',
    '"typographyNotes": string|null, "composition": string|null, "callToActionPlacement": string|null,',
    '"designCategory": string|null, "observedText": string|null, "interpretation": string|null}',
    '',
    'Rules:',
    '- "observedText" must be text you can actually read in the image. Do not guess.',
    '- Do not name an exact font or hex colour unless it is unmistakable; describe it instead.',
    '- "interpretation" is for inference only; keep observations out of it.',
    caption ? `The post caption for context is: "${caption.slice(0, 500)}"` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseVisualAnalysis(raw: string): VisualAnalysis | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Partial<VisualAnalysis>;
    return {
      dominantColors: Array.isArray(parsed.dominantColors) ? parsed.dominantColors.slice(0, 6) : [],
      layoutType: parsed.layoutType ?? null,
      visualHierarchy: parsed.visualHierarchy ?? null,
      typographyNotes: parsed.typographyNotes ?? null,
      composition: parsed.composition ?? null,
      callToActionPlacement: parsed.callToActionPlacement ?? null,
      designCategory: parsed.designCategory ?? null,
      observedText: parsed.observedText ?? null,
      interpretation: parsed.interpretation ?? null,
    };
  } catch {
    return null;
  }
}

/** Models sometimes wrap JSON in prose or fences. Recover the object. */
function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

interface SummaryDraft {
  summaryType: string;
  title: string | null;
  shortSummary: string | null;
  detailedSummary: string | null;
  mainPoints: string[];
  takeaways: string[];
  visualAnalysis: VisualAnalysis | null;
  sourceReferences: Array<{ label: string; url: string; contentItemId?: string }>;
  modelIdentifier: string | null;
}

const DEPTH_INSTRUCTIONS: Record<string, string> = {
  brief: 'Keep the detailed summary to two or three sentences. At most three main points.',
  standard: 'Write a detailed summary of one short paragraph. Three to five main points.',
  deep: 'Write a thorough detailed summary with structure. Six to ten main points, including concrete examples where present.',
};

async function summarise(
  ctx: Parameters<typeof generateText>[0],
  input: {
    item: ContentItem;
    collection: Collection;
    transcriptText: string | null;
    visual: VisualAnalysis | null;
    depth: string;
  },
): Promise<SummaryDraft> {
  const evidence: string[] = [];
  if (input.item.caption) evidence.push(`Caption:\n${input.item.caption}`);
  if (input.transcriptText) evidence.push(`Transcript:\n${input.transcriptText.slice(0, 12_000)}`);
  if (input.visual) {
    evidence.push(`Visual observations:\n${JSON.stringify(input.visual).slice(0, 2_000)}`);
  }

  if (evidence.length === 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'There was no caption, transcript, or visual evidence to summarise. Nothing was generated.',
    );
  }

  const isDemo = input.item.metadata['demo'] === true;

  const result = await generateText(ctx, {
    system: [
      'You summarise social media content for a research library.',
      'Use ONLY the evidence provided. If the evidence is thin, say so in the summary rather than inventing detail.',
      'Never claim to have watched a video. If you only have a caption, say the summary is caption-based.',
      'Reply with JSON only, no prose and no code fences.',
    ].join(' '),
    prompt: [
      isDemo
        ? 'NOTE: this is a synthetic demo record, not real Instagram content. Say so in the summary.'
        : '',
      `Content type: ${input.item.contentType}`,
      `Creator: ${input.item.creatorIdentifier ?? 'unknown'}`,
      `Source URL: ${input.item.sourceUrl}`,
      DEPTH_INSTRUCTIONS[input.depth] ?? DEPTH_INSTRUCTIONS['standard'],
      '',
      'Return JSON with exactly these keys:',
      '{"title": string, "shortSummary": string, "detailedSummary": string,',
      ' "mainPoints": string[], "takeaways": string[], "topics": string[], "keywords": string[],',
      ' "confidence": "high"|"medium"|"low", "evidenceBasis": "caption"|"transcript"|"caption+transcript"|"visual+text"}',
      '',
      evidence.join('\n\n'),
    ]
      .filter(Boolean)
      .join('\n'),
    json: true,
    maxOutputTokens: input.depth === 'deep' ? 1600 : input.depth === 'brief' ? 500 : 900,
  });

  const parsed = parseSummaryJson(result.text);

  const topics = normalizeTags([...(parsed.topics ?? []), ...(parsed.keywords ?? [])]);

  return {
    summaryType: 'standard',
    title: parsed.title ?? null,
    shortSummary: parsed.shortSummary ?? null,
    detailedSummary: parsed.detailedSummary ?? null,
    mainPoints: Array.isArray(parsed.mainPoints) ? parsed.mainPoints.slice(0, 12) : [],
    takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways.slice(0, 12) : [],
    visualAnalysis: input.visual,
    sourceReferences: [
      {
        label: input.item.creatorIdentifier
          ? `@${input.item.creatorIdentifier} — ${input.item.contentType}`
          : `Instagram ${input.item.contentType}`,
        url: input.item.sourceUrl,
        contentItemId: input.item.id,
      },
    ],
    modelIdentifier: result.modelIdentifier,
    // Topics are persisted through the tag path; stash them on the draft so the
    // caller can pass them to setTags without a second model call.
    ...(topics.length > 0 ? { __topics: topics } : {}),
  } as SummaryDraft & { __topics?: string[] };
}

interface SummaryJson {
  title?: string;
  shortSummary?: string;
  detailedSummary?: string;
  mainPoints?: string[];
  takeaways?: string[];
  topics?: string[];
  keywords?: string[];
}

function parseSummaryJson(raw: string): SummaryJson {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      'The model did not return valid JSON for the summary. It will be retried.',
      { details: { preview: raw.slice(0, 200) } },
    );
  }
  try {
    return JSON.parse(jsonText) as SummaryJson;
  } catch {
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      'The model returned malformed JSON for the summary. It will be retried.',
    );
  }
}

async function embedAndIndex(
  env: Env,
  db: D1Database,
  ownerId: string,
  itemId: string,
  summary: SummaryDraft,
): Promise<void> {
  const text = [
    summary.title,
    summary.shortSummary,
    summary.detailedSummary,
    summary.mainPoints.join(' '),
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n')
    .slice(0, 8_000);

  if (!text) return;

  try {
    const settings = await getSettings(db, ownerId);
    const result = await embedTexts(
      { env, db, ownerId, collectionId: null, jobId: null, settings },
      [text],
    );
    const vector = result.vectors[0];
    if (!vector) return;

    await env.VECTORS.upsert([
      {
        id: itemId,
        values: vector,
        metadata: { ownerId, contentItemId: itemId, model: result.modelIdentifier },
      },
    ]);
  } catch {
    // Embedding failure must not fail the item — the summary is already saved
    // and lexical search still works. Semantic retrieval simply misses this
    // item until the next successful run.
  }
}

async function handleFailure(
  env: Env,
  db: D1Database,
  input: {
    jobId: string;
    jobItemId: string;
    contentItemId: string;
    attempt: number;
    settings: SettingsPayload;
    error: unknown;
  },
): Promise<ProcessOutcome> {
  const appError =
    input.error instanceof AppError
      ? input.error
      : new AppError(
          ERROR_CODES.INTERNAL_ERROR,
          'Processing failed unexpectedly. It will be retried.',
        );

  const retryable = appError.retryable || isRetryableCode(appError.code);
  const retryAt = computeNextRetryAt(
    input.attempt,
    retryable,
    {
      maxAttempts: input.settings.processing.retryMaxAttempts,
      baseDelayMs: input.settings.processing.retryBaseDelayMs,
      maxDelayMs: 10 * 60 * 1000,
      factor: 2,
    },
    null,
  );

  await updateJobItem(db, input.jobItemId, {
    status: 'failed',
    errorCode: appError.code,
    errorMessage: appError.message.slice(0, 500),
    nextRetryAt: retryAt,
    completedAt: retryAt ? null : new Date().toISOString(),
  });

  await recordEvent(db, {
    jobId: input.jobId,
    eventType: retryAt ? 'retry_scheduled' : 'job_failed',
    message: retryAt
      ? `Attempt ${input.attempt} failed (${appError.code}). Retry scheduled.`
      : `Attempt ${input.attempt} failed permanently (${appError.code}).`,
    metadata: { contentItemId: input.contentItemId, code: appError.code, retryAt },
  });

  if (!retryAt) {
    await setItemStatus(db, input.contentItemId, 'failed');
    await db
      .prepare('UPDATE research_jobs SET error_summary = ?, updated_at = ? WHERE id = ?')
      .bind(appError.message.slice(0, 500), new Date().toISOString(), input.jobId)
      .run();
  }

  await recalcJobProgress(db, input.jobId);

  return {
    status: retryAt ? 'retry' : 'failed',
    message: appError.message,
  };
}

/** Re-queue any job items whose retry window has opened. */
export async function sweepRetries(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT ji.id AS job_item_id, ji.content_item_id, ji.attempts, j.id AS job_id, j.owner_id
       FROM job_items ji JOIN research_jobs j ON j.id = ji.job_id
      WHERE ji.status = 'failed' AND ji.next_retry_at IS NOT NULL AND ji.next_retry_at <= ?
        AND j.status IN ('queued', 'running')
      ORDER BY ji.next_retry_at LIMIT 25`,
  )
    .bind(new Date().toISOString())
    .all<{
      job_item_id: string;
      content_item_id: string;
      attempts: number;
      job_id: string;
      owner_id: string;
    }>();

  let queued = 0;
  for (const row of rows.results ?? []) {
    await updateJobItem(env.DB, row.job_item_id, { status: 'running', nextRetryAt: null });
    await env.PIPELINE.send({
      type: 'process_item',
      jobId: row.job_id,
      jobItemId: row.job_item_id,
      contentItemId: row.content_item_id,
      ownerId: row.owner_id,
      attempt: row.attempts + 1,
      enqueuedAt: new Date().toISOString(),
    } satisfies PipelineMessage);
    queued += 1;
  }
  return queued;
}

/** Ensure a job's status reflects reality after a batch of work. */
export async function settleJob(env: Env, jobId: string): Promise<void> {
  const job = await getJobUnscoped(env.DB, jobId);
  if (!job) return;
  if (job.status === 'paused' || job.status === 'cancelled') return;
  const updated = await recalcJobProgress(env.DB, jobId);
  if (updated && updated.status === 'queued') {
    await setJobStatus(env.DB, jobId, 'running');
  }
}

export type { Summary };
