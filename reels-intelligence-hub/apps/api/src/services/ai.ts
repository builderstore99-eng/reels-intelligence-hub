import {
  AppError,
  EMBEDDING_DIMENSIONS,
  ERROR_CODES,
  estimateCostUsd,
  estimateTokens,
  getModel,
  getProvider,
  isRetryableCode,
  type SettingsPayload,
} from '@rih/shared';
import type { Env } from '../env.js';
import { resolveProviderKey } from './apiKeys.js';
import { recordUsage } from '../repositories/misc.js';

/**
 * AI provider abstraction.
 *
 * Every model call in the application funnels through the four functions at the
 * bottom of this file. They share three properties:
 *
 *  1. **Capability-checked.** A model is only selected if it declares the
 *     capability being asked for, so we never send audio to a text model or
 *     claim a transcript we could not have produced.
 *  2. **Key-resolved through one path.** `resolveProviderKey` is the only way a
 *     credential is obtained, so a user's own key in Settings → API Keys is used
 *     automatically, and a missing key produces one clear, actionable error.
 *  3. **Metered.** Each call records a `usage_events` row with token counts and
 *     an estimated cost, which is what the Usage & Costs screen charts.
 *
 * Adding a provider means adding a case to `callText` / `callVision` /
 * `callTranscription` / `callEmbedding` and a `MODELS` entry. No call site
 * changes.
 */

export interface TextResult {
  text: string;
  modelIdentifier: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  modelIdentifier: string;
  provider: string;
  inputTokens: number;
  durationMs: number;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  provider: string;
  modelIdentifier: string;
  durationMs: number;
  audioSeconds: number;
}

interface CallContext {
  env: Env;
  db: D1Database;
  ownerId: string;
  collectionId: string | null;
  jobId: string | null;
  settings: SettingsPayload;
}

/* ------------------------------------------------------------- selection -- */

function assertCapability(modelId: string, capability: string): void {
  const model = getModel(modelId);
  if (!model) {
    throw new AppError(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      `The model "${modelId}" is not in the supported model registry. Pick a different model in Settings → AI.`,
    );
  }
  if (!model.capabilities.includes(capability as never)) {
    throw new AppError(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      `${model.label} cannot be used for ${capability.replace('_', ' ')}. Choose a model that supports it in Settings → AI.`,
    );
  }
}

async function meter(
  ctx: CallContext,
  params: {
    provider: string;
    modelIdentifier: string;
    operationType: string;
    inputTokens?: number;
    outputTokens?: number;
    audioSeconds?: number;
    durationMs: number;
  },
): Promise<void> {
  await recordUsage(ctx.db, {
    ownerId: ctx.ownerId,
    collectionId: ctx.collectionId,
    jobId: ctx.jobId,
    provider: params.provider,
    modelIdentifier: params.modelIdentifier,
    operationType: params.operationType,
    inputUnits: params.inputTokens ?? Math.round((params.audioSeconds ?? 0) * 1000),
    outputUnits: params.outputTokens ?? 0,
    durationMs: params.durationMs,
    estimatedCost: estimateCostUsd(params.modelIdentifier, {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      audioSeconds: params.audioSeconds,
    }),
  });
}

/** Translate a provider HTTP failure into an AppError with a retryable flag. */
async function providerError(
  providerSlug: string,
  response: Response,
  operation: string,
): Promise<never> {
  const label = getProvider(providerSlug)?.label ?? providerSlug;
  const body = await response.text().catch(() => '');
  // Keep the body out of the client message (it can contain account details);
  // the safe excerpt goes into `details` for server-side logs only.
  const excerpt = body.slice(0, 300);

  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      `${label} rejected the request during ${operation}. Check the key in Settings → API Keys.`,
      { details: { status: response.status, excerpt } },
    );
  }
  if (response.status === 429) {
    throw new AppError(
      ERROR_CODES.RATE_LIMITED,
      `${label} rate-limited this request during ${operation}. The job will retry automatically.`,
      { details: { status: 429, retryAfter: response.headers.get('retry-after') } },
    );
  }
  throw new AppError(
    isRetryableCode(ERROR_CODES.PROVIDER_UNAVAILABLE)
      ? ERROR_CODES.PROVIDER_UNAVAILABLE
      : ERROR_CODES.INTERNAL_ERROR,
    `${label} returned HTTP ${response.status} during ${operation}.`,
    { details: { status: response.status, excerpt } },
  );
}

/* ------------------------------------------------------------------ text -- */

export interface GenerateTextOptions {
  system?: string;
  prompt: string;
  /** Ask the provider for strict JSON. */
  json?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  /** Override the model from settings (used by report generation). */
  modelOverride?: string;
}

export async function generateText(
  ctx: CallContext,
  options: GenerateTextOptions,
): Promise<TextResult> {
  const modelId = options.modelOverride ?? ctx.settings.ai.textModel;
  assertCapability(modelId, 'text');
  const model = getModel(modelId)!;

  const { key } = await resolveProviderKey(ctx.env, ctx.db, ctx.ownerId, model.provider);
  const started = Date.now();

  if (model.provider === 'cloudflare') {
    const response = await ctx.env.AI.run(
      modelId as never,
      {
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: options.prompt },
        ],
        max_tokens: options.maxOutputTokens ?? 1024,
      } as never,
    );

    const text = extractWorkersAiText(response);
    const durationMs = Date.now() - started;
    const inputTokens = estimateTokens(`${options.system ?? ''}${options.prompt}`);
    const outputTokens = estimateTokens(text);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'text',
      inputTokens,
      outputTokens,
      durationMs,
    });
    return {
      text,
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      durationMs,
    };
  }

  if (model.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: options.prompt },
        ],
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxOutputTokens ?? 1200,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!response.ok) await providerError(model.provider, response, 'text generation');
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content ?? '';
    const durationMs = Date.now() - started;
    const inputTokens = payload.usage?.prompt_tokens ?? estimateTokens(options.prompt);
    const outputTokens = payload.usage?.completion_tokens ?? estimateTokens(text);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'text',
      inputTokens,
      outputTokens,
      durationMs,
    });
    return {
      text,
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      durationMs,
    };
  }

  if (model.provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: options.maxOutputTokens ?? 1200,
        temperature: options.temperature ?? 0.2,
        ...(options.system ? { system: options.system } : {}),
        messages: [{ role: 'user', content: options.prompt }],
      }),
    });
    if (!response.ok) await providerError(model.provider, response, 'text generation');
    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    const durationMs = Date.now() - started;
    const inputTokens = payload.usage?.input_tokens ?? estimateTokens(options.prompt);
    const outputTokens = payload.usage?.output_tokens ?? estimateTokens(text);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'text',
      inputTokens,
      outputTokens,
      durationMs,
    });
    return {
      text,
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      durationMs,
    };
  }

  if (model.provider === 'google-ai') {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: options.system ? { parts: [{ text: options.system }] } : undefined,
          contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
          generationConfig: {
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxOutputTokens ?? 1200,
            ...(options.json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
    );
    if (!response.ok) await providerError(model.provider, response, 'text generation');
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    const durationMs = Date.now() - started;
    const inputTokens = payload.usageMetadata?.promptTokenCount ?? estimateTokens(options.prompt);
    const outputTokens = payload.usageMetadata?.candidatesTokenCount ?? estimateTokens(text);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'text',
      inputTokens,
      outputTokens,
      durationMs,
    });
    return {
      text,
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      durationMs,
    };
  }

  throw new AppError(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    `No text implementation exists for provider "${model.provider}".`,
  );
}

function extractWorkersAiText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (typeof record['response'] === 'string') return record['response'];
    if (typeof record['text'] === 'string') return record['text'];
  }
  return '';
}

/* ---------------------------------------------------------------- vision -- */

export interface AnalyzeImageOptions {
  /** Public or signed URL the provider can fetch. */
  imageUrl?: string;
  /** Base64 data URL, used when the media is not publicly reachable. */
  imageDataUrl?: string;
  prompt: string;
  modelOverride?: string;
}

export async function analyzeImage(
  ctx: CallContext,
  options: AnalyzeImageOptions,
): Promise<TextResult> {
  const modelId = options.modelOverride ?? ctx.settings.ai.visionModel;
  assertCapability(modelId, 'vision');
  const model = getModel(modelId)!;
  const { key } = await resolveProviderKey(ctx.env, ctx.db, ctx.ownerId, model.provider);
  const started = Date.now();

  const imageSource = options.imageDataUrl ?? options.imageUrl;
  if (!imageSource) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'No accessible image was available for visual analysis.',
    );
  }

  if (model.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 900,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: options.prompt },
              { type: 'image_url', image_url: { url: imageSource } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) await providerError(model.provider, response, 'visual analysis');
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content ?? '';
    const durationMs = Date.now() - started;
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'vision',
      inputTokens,
      outputTokens,
      durationMs,
    });
    return {
      text,
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      durationMs,
    };
  }

  if (model.provider === 'anthropic') {
    const base64 = options.imageDataUrl?.split(',')[1];
    if (!base64) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'Anthropic requires inline image bytes; no downloadable media was available for this item.',
      );
    }
    const mediaType = options.imageDataUrl?.slice(5).split(';')[0] ?? 'image/jpeg';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 900,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: options.prompt },
            ],
          },
        ],
      }),
    });
    if (!response.ok) await providerError(model.provider, response, 'visual analysis');
    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (payload.content ?? []).map((b) => b.text ?? '').join('\n');
    const durationMs = Date.now() - started;
    const inputTokens = payload.usage?.input_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'vision',
      inputTokens,
      outputTokens,
      durationMs,
    });
    return {
      text,
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      durationMs,
    };
  }

  throw new AppError(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    `Visual analysis is not implemented for provider "${model.provider}". Choose an OpenAI or Anthropic vision model in Settings → AI.`,
  );
}

/* --------------------------------------------------------- transcription -- */

export async function transcribeAudio(
  ctx: CallContext,
  input: { audio: ArrayBuffer; filename: string; contentType: string },
): Promise<TranscriptionResult> {
  const modelId = ctx.settings.ai.transcriptionModel;
  assertCapability(modelId, 'transcription');
  const model = getModel(modelId)!;
  const { key } = await resolveProviderKey(ctx.env, ctx.db, ctx.ownerId, model.provider);
  const started = Date.now();

  const form = new FormData();
  form.append('file', new Blob([input.audio], { type: input.contentType }), input.filename);

  if (model.provider === 'openai') {
    form.append('model', modelId);
    form.append('response_format', 'verbose_json');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!response.ok) await providerError(model.provider, response, 'transcription');
    const payload = (await response.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: Array<{ start: number; end: number; text: string }>;
    };
    const durationMs = Date.now() - started;
    const audioSeconds = payload.duration ?? Math.round(input.audio.byteLength / 16_000);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'transcription',
      audioSeconds,
      durationMs,
    });
    return {
      text: payload.text ?? '',
      language: payload.language ?? null,
      segments: (payload.segments ?? []).map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text,
      })),
      provider: model.provider,
      modelIdentifier: modelId,
      durationMs,
      audioSeconds,
    };
  }

  if (model.provider === 'assemblyai') {
    const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/octet-stream' },
      body: input.audio,
    });
    if (!uploadResponse.ok) await providerError(model.provider, uploadResponse, 'audio upload');
    const upload = (await uploadResponse.json()) as { upload_url?: string };

    const createResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload.upload_url }),
    });
    if (!createResponse.ok)
      await providerError(model.provider, createResponse, 'transcription submit');
    const created = (await createResponse.json()) as { id?: string };

    // AssemblyAI is asynchronous. Poll with a bounded budget rather than
    // hanging the queue consumer indefinitely.
    const deadline = Date.now() + 90_000;
    let text = '';
    let language: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${created.id}`, {
        headers: { authorization: key },
      });
      if (!poll.ok) await providerError(model.provider, poll, 'transcription poll');
      const state = (await poll.json()) as {
        status?: string;
        text?: string;
        language_code?: string;
        audio_duration?: number;
      };
      if (state.status === 'completed') {
        text = state.text ?? '';
        language = state.language_code ?? null;
        break;
      }
      if (state.status === 'error') {
        throw new AppError(
          ERROR_CODES.PROVIDER_UNAVAILABLE,
          'AssemblyAI could not transcribe this audio.',
        );
      }
    }
    if (!text) {
      throw new AppError(
        ERROR_CODES.TIMEOUT,
        'Transcription did not finish in time. It will be retried.',
      );
    }
    const durationMs = Date.now() - started;
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'transcription',
      audioSeconds: Math.round(durationMs / 1000),
      durationMs,
    });
    return {
      text,
      language,
      segments: [],
      provider: model.provider,
      modelIdentifier: modelId,
      durationMs,
      audioSeconds: Math.round(durationMs / 1000),
    };
  }

  throw new AppError(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    `Transcription is not implemented for provider "${model.provider}".`,
  );
}

/* ------------------------------------------------------------- embeddings -- */

export async function embedTexts(ctx: CallContext, texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    return {
      vectors: [],
      modelIdentifier: ctx.settings.ai.embeddingModel,
      provider: 'none',
      inputTokens: 0,
      durationMs: 0,
    };
  }

  const modelId = ctx.settings.ai.embeddingModel;
  assertCapability(modelId, 'embedding');
  const model = getModel(modelId)!;
  const started = Date.now();

  if (model.provider === 'cloudflare') {
    const response = await ctx.env.AI.run(modelId as never, { text: texts } as never);
    const payload = response as unknown as { data?: number[][] };
    const vectors = payload.data ?? [];
    const durationMs = Date.now() - started;
    const inputTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'embedding',
      inputTokens,
      durationMs,
    });
    return { vectors, modelIdentifier: modelId, provider: model.provider, inputTokens, durationMs };
  }

  const { key } = await resolveProviderKey(ctx.env, ctx.db, ctx.ownerId, model.provider);

  if (model.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
    });
    if (!response.ok) await providerError(model.provider, response, 'embedding generation');
    const payload = (await response.json()) as {
      data?: Array<{ embedding: number[] }>;
      usage?: { prompt_tokens?: number };
    };
    const durationMs = Date.now() - started;
    const inputTokens =
      payload.usage?.prompt_tokens ?? texts.reduce((s, t) => s + estimateTokens(t), 0);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'embedding',
      inputTokens,
      durationMs,
    });
    return {
      vectors: (payload.data ?? []).map((d) => d.embedding),
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      durationMs,
    };
  }

  if (model.provider === 'google-ai') {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:batchEmbedContents?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${modelId}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      },
    );
    if (!response.ok) await providerError(model.provider, response, 'embedding generation');
    const payload = (await response.json()) as { embeddings?: Array<{ values: number[] }> };
    const durationMs = Date.now() - started;
    const inputTokens = texts.reduce((s, t) => s + estimateTokens(t), 0);
    await meter(ctx, {
      provider: model.provider,
      modelIdentifier: modelId,
      operationType: 'embedding',
      inputTokens,
      durationMs,
    });
    return {
      vectors: (payload.embeddings ?? []).map((e) => e.values),
      modelIdentifier: modelId,
      provider: model.provider,
      inputTokens,
      durationMs,
    };
  }

  throw new AppError(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    `Embeddings are not implemented for provider "${model.provider}".`,
  );
}

export type { CallContext };
