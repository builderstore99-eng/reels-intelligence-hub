import {
  AppError,
  ERROR_CODES,
  heuristicRelevance,
  parseInstagramSource,
  type ContentType,
} from '@rih/shared';
import type { Env } from '../env.js';
import { getEncryptedAccountCredentials } from '../repositories/misc.js';
import { decryptSecret } from '@rih/shared';
import { requireSecret } from '../env.js';

/**
 * Instagram ingestion providers.
 *
 * There is exactly one *real* provider here — the official Instagram Graph API
 * — plus an explicitly-labelled demo provider used for local evaluation.
 *
 * What the Graph API can and cannot do, stated plainly because the UI repeats
 * it:
 *
 *   CAN   read media for accounts that have authorised this app (an Instagram
 *         Business or Creator account connected through the OAuth flow), and
 *         read public media for other Business/Creator accounts through
 *         Business Discovery.
 *   CANNOT read arbitrary personal accounts, private accounts, or anything
 *         beyond the permissions granted. There is no supported endpoint for
 *         "give me every reel from any public profile".
 *
 * We therefore never promise unrestricted access, never rotate accounts, and
 * never retry around a 403 in the hope that a different identity succeeds.
 */

export interface DiscoveredItem {
  sourceProvider: string;
  sourceIdentifier: string;
  sourceUrl: string;
  creatorIdentifier: string | null;
  contentType: ContentType;
  caption: string | null;
  publishedAt: string | null;
  thumbnailReference: string | null;
  /** Provider-hosted media URL, only present when the platform permits it. */
  mediaUrl: string | null;
  metadata: Record<string, unknown>;
}

export interface DiscoveryRequest {
  source: string;
  maxItems: number;
  /** Only used by the demo provider. */
  useDemoData?: boolean;
  /** Connected account to act as, when the caller has one. */
  accountId?: string;
}

export interface DiscoveryProvider {
  slug: string;
  /** Human description shown in the UI next to the source field. */
  capabilities: string;
  discover(
    env: Env,
    db: D1Database,
    ownerId: string,
    request: DiscoveryRequest,
  ): Promise<DiscoveredItem[]>;
  /** Broad topic search. Null means this provider cannot do it. */
  searchTopic?(
    env: Env,
    db: D1Database,
    ownerId: string,
    query: string,
    limit: number,
  ): Promise<DiscoveredItem[]>;
}

/* --------------------------------------------------------------- graph API */

const GRAPH = 'https://graph.facebook.com/v21.0';

interface GraphMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

function mapGraphMedia(media: GraphMedia, username: string | null): DiscoveredItem {
  const productType = media.media_product_type ?? '';
  const mediaType = media.media_type ?? '';

  const contentType: ContentType =
    productType === 'REELS'
      ? 'reel'
      : mediaType === 'CAROUSEL_ALBUM'
        ? 'carousel'
        : mediaType === 'VIDEO'
          ? 'video'
          : 'image';

  return {
    sourceProvider: 'instagram',
    sourceIdentifier: `instagram:post:${media.id}`,
    sourceUrl: media.permalink ?? `https://www.instagram.com/p/${media.id}/`,
    creatorIdentifier: username,
    contentType,
    caption: media.caption ?? null,
    publishedAt: media.timestamp ?? null,
    thumbnailReference: media.thumbnail_url ?? media.media_url ?? null,
    mediaUrl: media.media_url ?? null,
    metadata: {
      graphMediaId: media.id,
      mediaType: media.media_type ?? null,
      mediaProductType: media.media_product_type ?? null,
      likeCount: media.like_count ?? null,
      commentsCount: media.comments_count ?? null,
      // Recorded so the UI can say *how* this item was obtained.
      obtainedVia: 'instagram_graph_api',
    },
  };
}

async function graphGet<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('access_token', token);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; type?: string };
    };
    const code = body.error?.code;
    if (response.status === 401 || code === 190) {
      throw new AppError(
        ERROR_CODES.AUTHORIZATION_EXPIRED,
        'The Instagram authorization for this account has expired. Reconnect it on Connected Accounts.',
      );
    }
    if (response.status === 429 || code === 4 || code === 17) {
      throw new AppError(
        ERROR_CODES.RATE_LIMITED,
        'Instagram rate-limited this request. The job will resume automatically when the window resets.',
      );
    }
    if (response.status === 403) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        'Instagram refused access to this content. The account may be private, or the granted permissions may not cover it.',
      );
    }
    throw new AppError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      `Instagram returned an error: ${body.error?.message ?? response.status}.`,
      { details: { status: response.status, code } },
    );
  }
  return (await response.json()) as T;
}

export const instagramGraphProvider: DiscoveryProvider = {
  slug: 'instagram',
  capabilities:
    'Official Instagram Graph API. Reads media for accounts that authorised this app, and public Business/Creator media via Business Discovery. Private and personal accounts are not supported.',
  async discover(env, db, ownerId, request) {
    const parsed = parseInstagramSource(request.source);
    if (!parsed) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_SOURCE,
        'Only Instagram profile and post URLs are supported by this provider.',
      );
    }

    if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
      throw new AppError(
        ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        'Instagram is not configured on this deployment. An administrator must set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET, and you must connect an account on Connected Accounts.',
      );
    }

    const accountId = request.accountId;
    if (!accountId) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        'No Instagram account is connected. Connect one on Connected Accounts, then start the research again.',
      );
    }

    const encrypted = await getEncryptedAccountCredentials(db, ownerId, accountId);
    if (!encrypted) {
      throw new AppError(
        ERROR_CODES.AUTHORIZATION_EXPIRED,
        'That connected account has no stored credentials. Reconnect it on Connected Accounts.',
      );
    }
    const token = await decryptSecret(encrypted, requireSecret(env, 'SECRETS_ENCRYPTION_KEY'));

    // A single post/reel URL: fetch that one node.
    if (parsed.shortcode) {
      const media = await graphGet<GraphMedia>(`/${parsed.shortcode}`, token, {
        fields:
          'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      });
      return [mapGraphMedia(media, null)];
    }

    // A profile: read the connected account's own media, or use Business
    // Discovery for a public Business/Creator account.
    const fields =
      'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
    const limit = String(Math.min(request.maxItems, 100));

    try {
      const own = await graphGet<{ data?: GraphMedia[] }>('/me/media', token, { fields, limit });
      if (own.data && own.data.length > 0) {
        return own.data.map((media) => mapGraphMedia(media, parsed.username));
      }
    } catch {
      // Fall through to Business Discovery — /me/media failing usually means
      // the connected account simply has no media, or lacks the permission.
    }

    const discovery = await graphGet<{
      business_discovery?: { media?: { data?: GraphMedia[] } };
    }>('/me', token, {
      fields: `business_discovery.username(${parsed.username}){media.limit(${limit}){${fields}}}`,
    });

    const items = discovery.business_discovery?.media?.data ?? [];
    if (items.length === 0) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        `Instagram returned no accessible media for @${parsed.username}. The account may be private, may not be a Business/Creator account, or may not have granted this app access.`,
      );
    }
    return items.map((media) => mapGraphMedia(media, parsed.username));
  },

  async searchTopic(_env, _db, _ownerId, query, limit) {
    // The Graph API has no keyword search across Instagram content. Saying so
    // is the honest answer; the UI offers profile research instead.
    throw new AppError(
      ERROR_CODES.UNSUPPORTED_SOURCE,
      `The Instagram Graph API does not offer keyword search, so "${query}" cannot be searched directly. Research a specific creator's profile instead, or connect another discovery provider.`,
      { details: { limit } },
    );
  },
};

/* ------------------------------------------------------------ demo provider */

/**
 * Demo provider.
 *
 * Enabled only when the operator sets ENABLE_DEMO_MODE=true AND the caller
 * explicitly asks for sample data. Every record it returns:
 *   - has source_provider = 'demo',
 *   - has a source_url on example.com, not instagram.com,
 *   - carries metadata.demo = true,
 * and the UI renders a DEMO badge from that flag. It can never be mistaken for
 * collected Instagram content because it does not look like it.
 */
const DEMO_SAMPLES: Array<Omit<DiscoveredItem, 'sourceProvider' | 'creatorIdentifier'>> = [
  {
    sourceIdentifier: 'demo:sample:1',
    sourceUrl: 'https://example.com/demo/1',
    contentType: 'reel',
    caption:
      'Sample data — how to structure a landing page hero: one promise, one proof, one action.',
    publishedAt: '2026-09-02T10:00:00.000Z',
    thumbnailReference: null,
    mediaUrl: null,
    metadata: { demo: true, note: 'Synthetic record for local evaluation' },
  },
  {
    sourceIdentifier: 'demo:sample:2',
    sourceUrl: 'https://example.com/demo/2',
    contentType: 'carousel',
    caption: 'Sample data — five dashboard layout patterns that keep dense data readable.',
    publishedAt: '2026-09-11T08:30:00.000Z',
    thumbnailReference: null,
    mediaUrl: null,
    metadata: { demo: true, note: 'Synthetic record for local evaluation' },
  },
  {
    sourceIdentifier: 'demo:sample:3',
    sourceUrl: 'https://example.com/demo/3',
    contentType: 'image',
    caption: 'Sample data — pricing page teardown: anchoring, decoy tiers, and annual toggles.',
    publishedAt: '2026-09-19T14:15:00.000Z',
    thumbnailReference: null,
    mediaUrl: null,
    metadata: { demo: true, note: 'Synthetic record for local evaluation' },
  },
];

export const demoProvider: DiscoveryProvider = {
  slug: 'demo',
  capabilities:
    'Synthetic sample records for evaluating the interface and pipeline. Clearly labelled as demo data; never presented as Instagram content.',
  async discover(_env, _db, _ownerId, request) {
    const parsed = parseInstagramSource(request.source);
    const creator = parsed?.username || 'demo.creator';
    return DEMO_SAMPLES.slice(0, Math.min(request.maxItems, DEMO_SAMPLES.length)).map((sample) => ({
      ...sample,
      sourceProvider: 'demo',
      creatorIdentifier: creator,
      metadata: { ...sample.metadata, demoSource: request.source },
    }));
  },
  async searchTopic(_env, _db, _ownerId, query, limit) {
    return DEMO_SAMPLES.map((sample, index) => ({
      ...sample,
      sourceProvider: 'demo',
      sourceIdentifier: `${sample.sourceIdentifier}:${index}`,
      creatorIdentifier: 'demo.creator',
      caption: `Sample data — ${query}: ${sample.caption?.replace('Sample data — ', '') ?? ''}`,
      metadata: {
        ...sample.metadata,
        demoQuery: query,
        relevance: heuristicRelevance(query, sample.caption ?? ''),
      },
    })).slice(0, Math.min(limit, DEMO_SAMPLES.length));
  },
};

/* --------------------------------------------------------------- registry */

export const DISCOVERY_PROVIDERS: readonly DiscoveryProvider[] = [
  instagramGraphProvider,
  demoProvider,
];

export function isDemoEnabled(env: Env): boolean {
  return env.ENABLE_DEMO_MODE === 'true' || env.ENABLE_DEMO_MODE === '1';
}
