/**
 * Provider and model registry.
 *
 * This is the single source of truth for:
 *  - which providers the Settings → API Keys screen offers,
 *  - what each provider is used for (so we never claim a model can transcribe
 *    when it cannot),
 *  - rough per-unit pricing used for the Usage & Costs estimate.
 *
 * Prices are indicative and intentionally conservative; the Usage screen says
 * so. They are not billing figures.
 */

export type ProviderCapability =
  'text' | 'vision' | 'transcription' | 'embedding' | 'image_generation';

export interface ProviderDefinition {
  /** Stable slug stored in the database. Never rename. */
  slug: string;
  label: string;
  /** Where the user gets a key. */
  docsUrl: string;
  /** Human hint about the expected key shape. */
  keyHint: string;
  capabilities: ProviderCapability[];
  /** Which env var name this maps to when a platform-wide key is supplied. */
  envVar: string;
  /** Whether the key is required for any core feature to work. */
  recommended: boolean;
  /** Short description shown under the field. */
  description: string;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    slug: 'openai',
    label: 'OpenAI',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Starts with "sk-" or "sk-proj-"',
    capabilities: ['text', 'vision', 'transcription', 'embedding'],
    envVar: 'OPENAI_API_KEY',
    recommended: true,
    description: 'Powers summaries, chat, visual analysis, embeddings and Whisper transcription.',
  },
  {
    slug: 'anthropic',
    label: 'Anthropic',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Starts with "sk-ant-"',
    capabilities: ['text', 'vision'],
    envVar: 'ANTHROPIC_API_KEY',
    recommended: false,
    description: 'Alternative text and vision provider. No transcription or embeddings.',
  },
  {
    slug: 'google-ai',
    label: 'Google AI (Gemini)',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'Starts with "AIza"',
    capabilities: ['text', 'vision', 'embedding'],
    envVar: 'GOOGLE_AI_API_KEY',
    recommended: false,
    description: 'Alternative text, vision and embedding provider.',
  },
  {
    slug: 'assemblyai',
    label: 'AssemblyAI',
    docsUrl: 'https://www.assemblyai.com/app/account',
    keyHint: '32-character hexadecimal string',
    capabilities: ['transcription'],
    envVar: 'ASSEMBLYAI_API_KEY',
    recommended: false,
    description: 'Dedicated speech-to-text. Use when Whisper is unavailable.',
  },
  {
    slug: 'instagram-graph',
    label: 'Instagram Graph API',
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform',
    keyHint: 'Long-lived access token from the OAuth flow',
    capabilities: [],
    envVar: 'INSTAGRAM_APP_SECRET',
    recommended: false,
    description:
      'Required for source discovery. Normally issued through Connected Accounts rather than pasted here.',
  },
  {
    slug: 'cloudflare',
    label: 'Cloudflare Workers AI',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/',
    keyHint: 'Account ID + API token (optional — the Worker binding is used by default)',
    capabilities: ['text', 'embedding'],
    envVar: 'CLOUDFLARE_API_TOKEN',
    recommended: false,
    description:
      'Fallback text and embedding models served from the Worker binding. No key needed when the binding is configured.',
  },
] as const;

export function getProvider(slug: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.slug === slug);
}

/** Providers that can serve a given capability, in preference order. */
export function providersFor(capability: ProviderCapability): ProviderDefinition[] {
  return PROVIDERS.filter((p) => p.capabilities.includes(capability));
}

export interface ModelDefinition {
  id: string;
  provider: string;
  label: string;
  capabilities: ProviderCapability[];
  /** USD per 1M input tokens, where applicable. */
  inputCostPerMTokens?: number;
  /** USD per 1M output tokens, where applicable. */
  outputCostPerMTokens?: number;
  /** USD per minute of audio, for transcription models. */
  costPerAudioMinute?: number;
  contextTokens?: number;
  notes?: string;
}

export const MODELS: readonly ModelDefinition[] = [
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 mini',
    capabilities: ['text', 'vision'],
    inputCostPerMTokens: 0.4,
    outputCostPerMTokens: 1.6,
    contextTokens: 1_000_000,
    notes: 'Default: fast and cheap enough for bulk summarisation.',
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    capabilities: ['text', 'vision'],
    inputCostPerMTokens: 2.0,
    outputCostPerMTokens: 8.0,
    contextTokens: 1_000_000,
    notes: 'Higher quality summaries and research reports.',
  },
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    label: 'text-embedding-3-small',
    capabilities: ['embedding'],
    inputCostPerMTokens: 0.02,
    contextTokens: 8_191,
    notes: '768-dimension output used for the Vectorize index.',
  },
  {
    id: 'whisper-1',
    provider: 'openai',
    label: 'Whisper',
    capabilities: ['transcription'],
    costPerAudioMinute: 0.006,
  },
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.5',
    capabilities: ['text', 'vision'],
    inputCostPerMTokens: 3.0,
    outputCostPerMTokens: 15.0,
    contextTokens: 200_000,
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'google-ai',
    label: 'Gemini 2.5 Flash',
    capabilities: ['text', 'vision'],
    inputCostPerMTokens: 0.3,
    outputCostPerMTokens: 2.5,
    contextTokens: 1_000_000,
  },
  {
    id: 'gemini-embedding-001',
    provider: 'google-ai',
    label: 'Gemini Embedding 001',
    capabilities: ['embedding'],
    inputCostPerMTokens: 0.15,
  },
  {
    id: 'assemblyai-best',
    provider: 'assemblyai',
    label: 'AssemblyAI Universal',
    capabilities: ['transcription'],
    costPerAudioMinute: 0.0089,
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct',
    provider: 'cloudflare',
    label: 'Llama 3.1 8B Instruct (Workers AI)',
    capabilities: ['text'],
    inputCostPerMTokens: 0.28,
    outputCostPerMTokens: 0.83,
    notes: 'No API key needed when the AI binding is configured.',
  },
  {
    id: '@cf/baai/bge-base-en-v1.5',
    provider: 'cloudflare',
    label: 'BGE Base EN v1.5 (Workers AI)',
    capabilities: ['embedding'],
    notes: '768 dimensions — matches the Vectorize index.',
  },
] as const;

export function getModel(id: string): ModelDefinition | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelsFor(capability: ProviderCapability, provider?: string): ModelDefinition[] {
  return MODELS.filter(
    (m) => m.capabilities.includes(capability) && (provider ? m.provider === provider : true),
  );
}

/** Dimensions produced by the embedding models we ship with. Must match Vectorize. */
export const EMBEDDING_DIMENSIONS = 768;
