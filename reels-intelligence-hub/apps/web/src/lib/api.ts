import type {
  ApiKeyRecord,
  ChatMessage,
  Collection,
  ConnectedAccount,
  ContentItem,
  Conversation,
  DashboardMetrics,
  HealthCheck,
  JobEvent,
  JobItem,
  Paginated,
  ResearchJob,
  ScheduledResearch,
  SettingsPayload,
  Summary,
  Tag,
  Transcript,
  UsageEvent,
  User,
} from '@rih/shared';

/**
 * Typed API client.
 *
 * One place that knows about the `{ data, meta }` envelope, the error envelope,
 * and where the session token lives. Components never call `fetch` directly.
 */

const BASE_URL = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '';

const TOKEN_KEY = 'rih.session.token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: sessions simply do not persist */
  }
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  details?: { fields?: Record<string, string> } & Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(detail: ApiErrorDetail, status: number) {
    super(detail.message);
    this.name = 'ApiError';
    this.code = detail.code;
    this.retryable = detail.retryable;
    this.requestId = detail.requestId;
    this.status = status;
    this.fields = detail.details?.fields ?? {};
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      {
        code: 'NETWORK_ERROR',
        message:
          'Could not reach the API. Check that the Worker is running (npm run dev:api) and that VITE_API_BASE_URL points at it.',
        retryable: true,
        requestId: 'n/a',
      },
      0,
    );
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const body = payload as { error?: ApiErrorDetail };
    if (body.error) throw new ApiError(body.error, response.status);
    throw new ApiError(
      {
        code: 'INTERNAL_ERROR',
        message: `Request failed with HTTP ${response.status}.`,
        retryable: true,
        requestId: response.headers.get('x-request-id') ?? 'n/a',
      },
      response.status,
    );
  }

  return payload as Envelope<T>;
}

/* ------------------------------------------------------------------ types */

export interface PagedResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  meta?: Record<string, unknown>;
}

export interface SearchHit extends ContentItem {
  score: number;
  lexicalScore: number;
  semanticScore: number;
  excerpt: string | null;
  tags: string[];
}

export interface CollectionItem extends ContentItem {
  summary: Summary | null;
  tags: Tag[];
}

export interface DashboardPayload {
  metrics: DashboardMetrics;
  collections: Collection[];
  jobs: ResearchJob[];
  items: Array<{
    id: string;
    caption: string | null;
    creatorIdentifier: string | null;
    contentType: string;
    sourceUrl: string;
    thumbnailReference: string | null;
    processingStatus: string;
    publishedAt: string | null;
    collectionId: string | null;
    collectionName: string | null;
  }>;
  events: Array<JobEvent & { collectionName: string | null }>;
  conversations: Conversation[];
}

export interface MonitorPayload {
  totalDiscovered: number;
  processed: number;
  waiting: number;
  processing: number;
  succeeded: number;
  failed: number;
  retryable: number;
  skipped: number;
  ratePerMinute: number;
  estimatedRemainingMs: number | null;
  jobs: ResearchJob[];
}

export interface UsagePayload {
  summary: {
    totalCostUsd: number;
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byProvider: Array<{ provider: string; calls: number; costUsd: number }>;
    byOperation: Array<{ operation: string; calls: number; costUsd: number }>;
    byDay: Array<{ day: string; costUsd: number; calls: number }>;
  };
  events: UsageEvent[];
}

export interface HealthPayload {
  environment: string;
  demoMode: boolean;
  checks: HealthCheck[];
  configuredProviders: string[];
}

export interface ProviderCatalogue {
  providers: Array<{
    slug: string;
    label: string;
    docsUrl: string;
    keyHint: string;
    capabilities: string[];
    envVar: string;
    recommended: boolean;
    description: string;
    platformConfigured: boolean;
  }>;
  models: Array<{
    id: string;
    provider: string;
    label: string;
    capabilities: string[];
    notes?: string;
  }>;
}

export interface ResearchResult {
  collection: Collection;
  job: ResearchJob;
  discovered: number;
  skipped: number;
  providerUsed: string;
  warning: string | null;
}

/* ------------------------------------------------------------------- api */

export const api = {
  auth: {
    register: (body: { email: string; password: string; displayName: string }) =>
      request<{ user: User; token: string }>('/auth/register', { method: 'POST', body }),
    login: (body: { email: string; password: string }) =>
      request<{ user: User; token: string }>('/auth/login', { method: 'POST', body }),
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    session: () => request<{ user: User }>('/auth/session'),
    requestReset: (email: string) =>
      request<{ ok: boolean; devToken?: string; note?: string }>('/auth/password-reset/request', {
        method: 'POST',
        body: { email },
      }),
    confirmReset: (body: { token: string; password: string }) =>
      request<{ ok: boolean }>('/auth/password-reset/confirm', { method: 'POST', body }),
  },

  dashboard: () => request<DashboardPayload>('/dashboard'),

  collections: {
    list: (params: Record<string, string | number> = {}) =>
      request<Collection[]>(`/collections?${toQuery(params)}`),
    get: (id: string) => request<Collection>(`/collections/${id}`),
    create: (body: Record<string, unknown>) =>
      request<Collection>('/collections', { method: 'POST', body }),
    update: (id: string, body: Record<string, unknown>) =>
      request<Collection>(`/collections/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<{ ok: boolean }>(`/collections/${id}`, { method: 'DELETE' }),
    duplicate: (id: string) =>
      request<Collection>(`/collections/${id}/duplicate`, { method: 'POST' }),
    items: (id: string, params: Record<string, string | number> = {}) =>
      request<CollectionItem[]>(`/collections/${id}/items?${toQuery(params)}`),
    removeItem: (id: string, itemId: string) =>
      request<{ ok: boolean }>(`/collections/${id}/items/${itemId}`, { method: 'DELETE' }),
    reports: (id: string) =>
      request<Array<{ id: string; title: string; createdAt: string }>>(
        `/collections/${id}/reports`,
      ),
  },

  research: {
    validateSource: (source: string) =>
      request<{
        valid: boolean;
        kind: string | null;
        canonicalUrl: string | null;
        username: string | null;
        message: string;
      }>('/research/validate-source', { method: 'POST', body: { source } }),
    readiness: () =>
      request<{
        instagramConfigured: boolean;
        demoEnabled: boolean;
        aiConfigured: boolean;
        summary: string;
      }>('/research/readiness'),
    profiles: (body: Record<string, unknown>) =>
      request<ResearchResult>('/research/profiles', { method: 'POST', body }),
    designs: (body: Record<string, unknown>) =>
      request<ResearchResult>('/research/designs', { method: 'POST', body }),
    topics: (body: Record<string, unknown>) =>
      request<ResearchResult>('/research/topics', { method: 'POST', body }),
    status: (jobId: string) =>
      request<{
        job: ResearchJob;
        collection: { id: string; name: string; status: string };
        progressPercent: number;
      }>(`/research/${jobId}/status`),
    providers: () =>
      request<
        Array<{
          slug: string;
          label: string;
          available: boolean;
          supports: string[];
          doesNotSupport: string[];
        }>
      >('/research/providers'),
  },

  content: {
    get: (id: string) =>
      request<{
        item: ContentItem;
        collection: { id: string; name: string };
        summary: Summary | null;
        transcript: Transcript | null;
        tags: Tag[];
      }>(`/content/${id}`),
    list: (params: Record<string, string | number> = {}) =>
      request<ContentItem[]>(`/content?${toQuery(params)}`),
  },

  jobs: {
    list: (params: Record<string, string | number> = {}) =>
      request<ResearchJob[]>(`/jobs?${toQuery(params)}`),
    get: (id: string) =>
      request<{ job: ResearchJob; items: JobItem[]; events: JobEvent[] }>(`/jobs/${id}`),
    monitor: () => request<MonitorPayload>('/jobs/monitor'),
    pause: (id: string) => request<ResearchJob>(`/jobs/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<ResearchJob>(`/jobs/${id}/resume`, { method: 'POST' }),
    cancel: (id: string) => request<ResearchJob>(`/jobs/${id}/cancel`, { method: 'POST' }),
    retry: (id: string) => request<ResearchJob>(`/jobs/${id}/retry`, { method: 'POST' }),
  },

  search: {
    query: (params: Record<string, string | number>) =>
      request<SearchHit[]>(`/search?${toQuery(params)}`),
    suggest: (q: string) =>
      request<Array<{ kind: string; value: string }>>(`/search/suggest?q=${encodeURIComponent(q)}`),
  },

  chat: {
    conversations: (params: Record<string, string | number> = {}) =>
      request<Conversation[]>(`/chat/conversations?${toQuery(params)}`),
    create: (body: Record<string, unknown>) =>
      request<Conversation>('/chat/conversations', { method: 'POST', body }),
    get: (id: string) =>
      request<{ conversation: Conversation; messages: ChatMessage[] }>(`/chat/conversations/${id}`),
    rename: (id: string, title: string) =>
      request<Conversation>(`/chat/conversations/${id}`, { method: 'PATCH', body: { title } }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/chat/conversations/${id}`, { method: 'DELETE' }),
    send: (
      id: string,
      body: { content: string; collectionIds?: string[]; contentItemId?: string },
    ) =>
      request<{
        userMessage: ChatMessage;
        assistantMessage: ChatMessage;
        semanticAvailable: boolean;
      }>(`/chat/conversations/${id}/messages`, { method: 'POST', body }),
  },

  settings: {
    get: () => request<SettingsPayload>('/settings'),
    update: (body: Record<string, unknown>) =>
      request<SettingsPayload>('/settings', { method: 'PATCH', body }),
    providers: () => request<ProviderCatalogue>('/settings/providers'),
    health: () => request<HealthPayload>('/settings/health'),
    storage: () =>
      request<{
        retentionDays: number;
        keepOriginalMedia: boolean;
        recentUsageEvents: number;
        note: string;
      }>('/settings/storage'),
    purge: (confirm: string) =>
      request<{ ok: boolean }>('/settings/data/purge', { method: 'POST', body: { confirm } }),

    /** API keys — the only surface that touches provider credentials. */
    apiKeys: {
      list: () => request<ApiKeyRecord[]>('/settings/api-keys'),
      save: (provider: string, value: string, label?: string) =>
        request<ApiKeyRecord>(`/settings/api-keys/${provider}`, {
          method: 'PUT',
          body: { provider, value, ...(label ? { label } : {}) },
        }),
      rename: (provider: string, label: string) =>
        request<ApiKeyRecord>(`/settings/api-keys/${provider}`, {
          method: 'PATCH',
          body: { label },
        }),
      remove: (provider: string) =>
        request<{ ok: boolean; provider: string }>(`/settings/api-keys/${provider}`, {
          method: 'DELETE',
        }),
      verify: (provider: string) =>
        request<{ ok: boolean; message: string; latencyMs: number; unsupported?: boolean }>(
          `/settings/api-keys/${provider}/verify`,
          { method: 'POST' },
        ),
    },
  },

  integrations: {
    list: () =>
      request<{
        accounts: ConnectedAccount[];
        instagramConfigured: boolean;
        redirectUri: string | null;
      }>('/integrations'),
    connect: () =>
      request<{ authorizeUrl: string; state: string }>('/integrations/instagram/connect', {
        method: 'POST',
      }),
    test: (id: string) =>
      request<{ ok: boolean; message: string }>(`/integrations/${id}/test`, { method: 'POST' }),
    reauthorize: (id: string) =>
      request<{ ok: boolean; message: string }>(`/integrations/${id}/reauthorize`, {
        method: 'POST',
      }),
    disconnect: (id: string) =>
      request<{ ok: boolean }>(`/integrations/${id}`, { method: 'DELETE' }),
  },

  usage: () => request<UsagePayload>('/usage'),

  reports: {
    list: (collectionId?: string) =>
      request<Array<{ id: string; title: string; collectionId: string | null; createdAt: string }>>(
        `/reports${collectionId ? `?collectionId=${collectionId}` : ''}`,
      ),
    create: (body: { collectionId: string; question?: string; title?: string }) =>
      request<{ id: string; title: string; content: string }>('/reports', { method: 'POST', body }),
    get: (id: string) =>
      request<{ id: string; title: string; content: string; sources: unknown[] }>(`/reports/${id}`),
    remove: (id: string) => request<{ ok: boolean }>(`/reports/${id}`, { method: 'DELETE' }),
  },

  schedules: {
    list: () => request<ScheduledResearch[]>('/schedules'),
    create: (body: Record<string, unknown>) =>
      request<ScheduledResearch[]>('/schedules', { method: 'POST', body }),
    toggle: (id: string, enabled: boolean) =>
      request<ScheduledResearch[]>(`/schedules/${id}`, { method: 'PATCH', body: { enabled } }),
    remove: (id: string) => request<{ ok: boolean }>(`/schedules/${id}`, { method: 'DELETE' }),
    run: (id: string) =>
      request<{ ok: boolean; discovered: number }>(`/schedules/${id}/run`, { method: 'POST' }),
  },
};

function toQuery(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export type { Paginated };
