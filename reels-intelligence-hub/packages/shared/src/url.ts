/**
 * Instagram source normalisation.
 *
 * Everything that enters the pipeline goes through `parseInstagramSource`
 * first. It is deliberately conservative: if we cannot prove a URL is an
 * Instagram post/profile we reject it rather than guessing, because a guessed
 * source identifier would poison duplicate detection and collection naming.
 */

export type InstagramSourceKind = 'profile' | 'reel' | 'post' | 'tv';

export interface ParsedInstagramSource {
  kind: InstagramSourceKind;
  /** Normalised handle, lowercased, no leading `@`. */
  username: string;
  /** Shortcode for post/reel/tv sources, null for profiles. */
  shortcode: string | null;
  /** Canonical URL — always https, always `www.instagram.com`, no tracking. */
  canonicalUrl: string;
  /**
   * Stable identifier used for duplicate detection and vector metadata.
   * e.g. `instagram:profile:design.inspiration`
   *      `instagram:post:Cx1aB2cDeFg`
   */
  sourceIdentifier: string;
}

const HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am',
]);

/** Path segments that are Instagram routes, not usernames. */
const RESERVED_SEGMENTS = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'stories',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
  'api',
  'privacy',
  'terms',
  'directory',
  'challenge',
  'emails',
  'session',
  'web',
]);

/** Instagram handles: 1-30 chars, letters/digits/period/underscore. */
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
/** Shortcodes are base64-ish, 5-32 chars. */
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,32}$/;

function normaliseUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function isValidInstagramUsername(raw: string): boolean {
  const u = normaliseUsername(raw);
  return USERNAME_RE.test(u) && !RESERVED_SEGMENTS.has(u);
}

/**
 * Parse a bare handle (`@foo`, `foo`) or a full Instagram URL into a
 * normalised source. Returns `null` when the input is not a recognisable,
 * supported Instagram source.
 */
export function parseInstagramSource(input: string): ParsedInstagramSource | null {
  const raw = input.trim();
  if (!raw) return null;

  // Bare handle form: `@foo` or `foo`, no slashes and not a hostname.
  const looksLikeHandle =
    !raw.includes('/') && !raw.includes('instagram.com') && !raw.includes('instagr.am');
  if (looksLikeHandle) {
    const username = normaliseUsername(raw);
    if (!isValidInstagramUsername(username)) return null;
    return {
      kind: 'profile',
      username,
      shortcode: null,
      canonicalUrl: `https://www.instagram.com/${username}/`,
      sourceIdentifier: `instagram:profile:${username}`,
    };
  }

  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  // Drop tracking params and hash.
  const segments = url.pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) return null;

  const first = segments[0]!.toLowerCase();

  // /p/<shortcode>, /reel/<shortcode>, /tv/<shortcode>
  if (first === 'p' || first === 'reel' || first === 'tv') {
    const shortcode = segments[1];
    if (!shortcode || !SHORTCODE_RE.test(shortcode)) return null;
    const kind: InstagramSourceKind = first === 'p' ? 'post' : first === 'tv' ? 'tv' : 'reel';
    const path = kind === 'post' ? 'p' : kind === 'tv' ? 'tv' : 'reel';
    return {
      kind,
      username: '',
      shortcode,
      canonicalUrl: `https://www.instagram.com/${path}/${shortcode}/`,
      sourceIdentifier: `instagram:post:${shortcode}`,
    };
  }

  // /reels/<shortcode> is a newer alias for /reel/<shortcode>.
  if (first === 'reels') {
    const shortcode = segments[1];
    if (shortcode && SHORTCODE_RE.test(shortcode)) {
      return {
        kind: 'reel',
        username: '',
        shortcode,
        canonicalUrl: `https://www.instagram.com/reel/${shortcode}/`,
        sourceIdentifier: `instagram:post:${shortcode}`,
      };
    }
    return null;
  }

  if (RESERVED_SEGMENTS.has(first)) return null;

  const username = normaliseUsername(first);
  if (!isValidInstagramUsername(username)) return null;

  return {
    kind: 'profile',
    username,
    shortcode: null,
    canonicalUrl: `https://www.instagram.com/${username}/`,
    sourceIdentifier: `instagram:profile:${username}`,
  };
}

/** Human-readable reason a source was rejected, for the UI. */
export function describeUnsupportedSource(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'Enter an Instagram profile URL, @handle, or post/reel link.';
  if (/instagram\.com|instagr\.am/i.test(trimmed)) {
    return 'That Instagram link is not a profile, post, reel, or IGTV URL. Supported shapes: instagram.com/<username>, /p/<code>, /reel/<code>, /tv/<code>.';
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('/')) {
    return 'Only Instagram sources are supported by the current provider. Paste an instagram.com profile or post URL.';
  }
  return 'That does not look like a valid Instagram handle (1-30 letters, digits, periods or underscores).';
}

/** Normalised collection name derived from a source, e.g. `@design.inspiration`. */
export function collectionNameForSource(source: ParsedInstagramSource): string {
  if (source.kind === 'profile') return `@${source.username}`;
  return `Instagram ${source.kind} ${source.shortcode ?? ''}`.trim();
}

/** Slug used for uniqueness checks on `collections.normalized_name`. */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      // Drop combining marks so "Ünïcode" slugs to "unicode", not "u-ni-code".
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
  );
}
