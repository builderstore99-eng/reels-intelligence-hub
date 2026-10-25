import { z } from 'zod';
import { PROVIDERS } from './providers.js';
import { isValidInstagramUsername, parseInstagramSource } from './url.js';

/* -------------------------------------------------------------- primitives */

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address.')
  .transform((v) => v.toLowerCase());

/**
 * Password policy: length is the dominant factor, so we require 10+ characters
 * and reject the handful of passwords that show up in every breach list. We do
 * not impose character-class rules — they push people toward `Passw0rd!`.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'That password is too long.')
  .refine((v) => !/^(password|123456|qwerty|letmein|admin)/i.test(v), {
    message: 'That password is too common.',
  });

export const providerSlugSchema = z
  .string()
  .refine((v) => PROVIDERS.some((p) => p.slug === v), { message: 'Unknown provider.' });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

/* -------------------------------------------------------------------- auth */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Tell us what to call you.').max(80),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
});

export const requestPasswordResetSchema = z.object({ email: emailSchema });

export const confirmPasswordResetSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
});

/* ------------------------------------------------------------- collections */

export const collectionTypeSchema = z.enum([
  'instagram_profile',
  'topic_research',
  'design_references',
  'manual',
  'document_library',
  'custom',
]);

export const summaryDepthSchema = z.enum(['brief', 'standard', 'deep']);

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1, 'Give the collection a name.').max(120),
  description: z.string().trim().max(2000).optional(),
  collectionType: collectionTypeSchema.default('manual'),
  sourceIdentifier: z.string().trim().max(200).optional(),
  settings: z
    .object({
      summaryDepth: summaryDepthSchema.default('standard'),
      transcribeAudio: z.boolean().default(true),
      analyzeVisuals: z.boolean().default(true),
      autoTag: z.boolean().default(true),
      skipDuplicates: z.boolean().default(true),
    })
    .partial()
    .optional(),
});

export const updateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['active', 'processing', 'paused', 'archived', 'failed']).optional(),
  settings: createCollectionSchema.shape.settings,
});

/* ---------------------------------------------------------------- research */

const instagramSourceSchema = z
  .string()
  .trim()
  .min(1, 'Enter an Instagram profile or content URL.')
  .superRefine((value, ctx) => {
    if (!parseInstagramSource(value) && !isValidInstagramUsername(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Only Instagram profiles (@handle, instagram.com/handle) and post/reel links are supported.',
      });
    }
  });

const researchOptionsSchema = z.object({
  maxItems: z.coerce.number().int().min(1).max(200).default(24),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  reprocessExisting: z.boolean().default(false),
  summaryDepth: summaryDepthSchema.default('standard'),
  transcribeAudio: z.boolean().default(true),
  analyzeVisuals: z.boolean().default(true),
  autoTag: z.boolean().default(true),
  skipDuplicates: z.boolean().default(true),
});

export const profileResearchSchema = z.object({
  source: instagramSourceSchema,
  collectionName: z.string().trim().max(120).optional(),
  collectionId: z.string().optional(),
  options: researchOptionsSchema.partial().optional(),
});

export const designResearchSchema = z.object({
  source: instagramSourceSchema,
  collectionName: z.string().trim().max(120).optional(),
  collectionId: z.string().optional(),
  options: researchOptionsSchema.partial().optional(),
});

export const topicResearchSchema = z.object({
  query: z.string().trim().min(3, 'Describe what you want to research.').max(300),
  collectionName: z.string().trim().max(120).optional(),
  options: researchOptionsSchema.partial().optional(),
});

/* --------------------------------------------------------------- api keys */

/**
 * API key input.
 *
 * `value` is accepted only on create/rotate. It is never echoed back, never
 * logged, and is encrypted before it touches the database. The `.refine`
 * checks shape only — the provider is the only thing that can tell us whether
 * a key is real, which is what the "Test" button is for.
 */
export const createApiKeySchema = z.object({
  provider: providerSlugSchema,
  label: z.string().trim().max(80).optional(),
  value: z
    .string()
    .trim()
    .min(16, 'That looks too short for an API key.')
    .max(512, 'That is longer than any supported key.')
    .refine((v) => !/\s/.test(v), 'API keys never contain spaces.'),
});

export const updateApiKeySchema = z.object({
  label: z.string().trim().max(80).optional(),
  value: z
    .string()
    .trim()
    .min(16, 'That looks too short for an API key.')
    .max(512)
    .refine((v) => !/\s/.test(v), 'API keys never contain spaces.')
    .optional(),
});

/* -------------------------------------------------------------------- chat */

export const chatScopeSchema = z.enum(['item', 'collection', 'collections', 'knowledge_base']);

export const createConversationSchema = z.object({
  title: z.string().trim().max(120).optional(),
  scopeType: chatScopeSchema.default('collection'),
  collectionId: z.string().nullable().optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Ask a question first.').max(8000),
  collectionIds: z.array(z.string()).max(20).optional(),
  contentItemId: z.string().optional(),
});

/* ------------------------------------------------------------------ search */

export const searchSchema = paginationSchema.extend({
  q: z.string().trim().min(1, 'Enter a search term.').max(300),
  mode: z.enum(['hybrid', 'lexical', 'semantic']).default('hybrid'),
  collectionId: z.string().optional(),
  creator: z.string().optional(),
  contentType: z.enum(['reel', 'video', 'image', 'carousel', 'document']).optional(),
  tag: z.string().optional(),
  status: z
    .enum(['discovered', 'queued', 'processing', 'completed', 'failed', 'skipped', 'unsupported'])
    .optional(),
  sort: z.enum(['relevance', 'recent', 'oldest']).default('relevance'),
});

/* ---------------------------------------------------------------- settings */

export const settingsSchema = z.object({
  general: z
    .object({
      displayName: z.string().trim().min(1).max(80),
      theme: z.enum(['dark', 'light', 'system']),
      language: z.string().min(2).max(10),
      defaultCollectionBehavior: z.enum(['reuse', 'always_new']),
      defaultSummaryDepth: summaryDepthSchema,
    })
    .partial()
    .optional(),
  ai: z
    .object({
      defaultProvider: providerSlugSchema,
      textModel: z.string().max(120),
      embeddingModel: z.string().max(120),
      transcriptionModel: z.string().max(120),
      visionModel: z.string().max(120),
    })
    .partial()
    .optional(),
  processing: z
    .object({
      maxConcurrency: z.number().int().min(1).max(10),
      retryMaxAttempts: z.number().int().min(1).max(10),
      retryBaseDelayMs: z.number().int().min(500).max(60_000),
      maxItemsPerRun: z.number().int().min(1).max(200),
      cooldownSeconds: z.number().int().min(0).max(86_400),
    })
    .partial()
    .optional(),
  storage: z
    .object({
      retentionDays: z.number().int().min(1).max(3650),
      keepOriginalMedia: z.boolean(),
    })
    .partial()
    .optional(),
  notifications: z
    .object({
      jobCompletion: z.boolean(),
      jobFailure: z.boolean(),
      researchUpdates: z.boolean(),
      usageThresholdUsd: z.number().min(0).max(100_000),
      reauthorizationRequests: z.boolean(),
    })
    .partial()
    .optional(),
});

/* ------------------------------------------------------------- scheduling */

export const scheduleSchema = z.object({
  collectionId: z.string().min(1),
  cadence: z.enum(['daily', 'weekly', 'custom']),
  cron: z.string().max(120).optional(),
  maxItemsPerRun: z.coerce.number().int().min(1).max(200).default(24),
  autoProcess: z.boolean().default(true),
  notify: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
export type ProfileResearchInput = z.infer<typeof profileResearchSchema>;
export type TopicResearchInput = z.infer<typeof topicResearchSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
