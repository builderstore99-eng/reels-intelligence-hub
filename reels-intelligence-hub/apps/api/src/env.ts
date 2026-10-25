import type { User } from '@rih/shared';

/**
 * Worker bindings and secrets.
 *
 * `wrangler.toml` declares the bindings; secrets are set with
 * `wrangler secret put` and never appear in the repository. Every optional
 * secret is typed as `string | undefined` and validated at the point of use,
 * because a Worker must still boot (and serve the settings screen) when a
 * provider is not configured.
 */
export interface Env {
  // --- bindings -----------------------------------------------------------
  DB: D1Database;
  MEDIA: R2Bucket;
  PIPELINE: Queue<PipelineMessage>;
  VECTORS: VectorizeIndex;
  AI: Ai;
  /**
   * The built frontend, uploaded with the Worker via `[assets]` in
   * wrangler.toml. Optional so `wrangler dev` still boots when the web app has
   * not been built — the SPA handler reports that clearly instead of crashing.
   */
  ASSETS?: Fetcher;

  // --- vars ---------------------------------------------------------------
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  ENABLE_TRANSCRIPTION: string;
  ENABLE_VISUAL_ANALYSIS: string;
  ENABLE_SEMANTIC_SEARCH: string;
  ENABLE_DEMO_MODE: string;

  // --- required secrets ---------------------------------------------------
  AUTH_SECRET?: string;
  SECRETS_ENCRYPTION_KEY?: string;

  // --- optional platform-wide provider keys -------------------------------
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;
  ASSEMBLYAI_API_KEY?: string;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_REDIRECT_URI?: string;
}

export interface PipelineMessage {
  type: 'process_item' | 'discover_source' | 'refresh_schedule' | 'generate_report';
  jobId: string;
  jobItemId?: string;
  contentItemId?: string;
  ownerId: string;
  attempt: number;
  enqueuedAt: string;
}

export interface AppVariables {
  user: User;
  requestId: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

/**
 * A missing required secret is a deployment error, not a user error: the
 * request cannot be served safely without it, so we fail closed with a 500
 * that names the variable (never its value).
 */
export class MissingSecretError extends Error {
  constructor(override readonly name: string) {
    super(
      `Required secret ${name} is not configured. Set it with: npx wrangler secret put ${name}`,
    );
    this.name = 'MissingSecretError';
  }
}

export function requireSecret(env: Env, name: 'AUTH_SECRET' | 'SECRETS_ENCRYPTION_KEY'): string {
  const value = env[name];
  if (!value || value.trim().length === 0) throw new MissingSecretError(name);
  return value;
}

export function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isEnabled(flag: string | undefined): boolean {
  return flag === 'true' || flag === '1';
}

/** Non-secret description of what is configured, for the health panel. */
export interface PlatformConfigStatus {
  authSecret: boolean;
  encryptionKey: boolean;
  providers: Record<string, boolean>;
  instagram: boolean;
  bindings: Record<string, boolean>;
}

export function describeConfig(env: Env): PlatformConfigStatus {
  return {
    authSecret: Boolean(env.AUTH_SECRET),
    encryptionKey: Boolean(env.SECRETS_ENCRYPTION_KEY),
    providers: {
      openai: Boolean(env.OPENAI_API_KEY),
      anthropic: Boolean(env.ANTHROPIC_API_KEY),
      'google-ai': Boolean(env.GOOGLE_AI_API_KEY),
      assemblyai: Boolean(env.ASSEMBLYAI_API_KEY),
    },
    instagram: Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
    bindings: {
      assets: Boolean(env.ASSETS),
      db: Boolean(env.DB),
      media: Boolean(env.MEDIA),
      pipeline: Boolean(env.PIPELINE),
      vectors: Boolean(env.VECTORS),
      ai: Boolean(env.AI),
    },
  };
}

/** The platform-wide key for a provider, if one was supplied. */
export function envKeyForProvider(env: Env, slug: string): string | undefined {
  switch (slug) {
    case 'openai':
      return env.OPENAI_API_KEY;
    case 'anthropic':
      return env.ANTHROPIC_API_KEY;
    case 'google-ai':
      return env.GOOGLE_AI_API_KEY;
    case 'assemblyai':
      return env.ASSEMBLYAI_API_KEY;
    case 'instagram-graph':
      return env.INSTAGRAM_APP_SECRET;
    default:
      return undefined;
  }
}
