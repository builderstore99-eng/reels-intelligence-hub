import { describe, expect, it } from 'vitest';
import {
  collectionNameForSource,
  describeUnsupportedSource,
  isValidInstagramUsername,
  parseInstagramSource,
  slugify,
} from '../url';

describe('parseInstagramSource', () => {
  it('normalises a profile URL to a canonical form', () => {
    const parsed = parseInstagramSource('https://www.instagram.com/Design.Inspiration/?hl=en');
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('profile');
    expect(parsed!.username).toBe('design.inspiration');
    expect(parsed!.canonicalUrl).toBe('https://www.instagram.com/design.inspiration/');
    expect(parsed!.sourceIdentifier).toBe('instagram:profile:design.inspiration');
  });

  it('accepts a bare handle with or without the at-sign', () => {
    expect(parseInstagramSource('@design.inspiration')?.username).toBe('design.inspiration');
    expect(parseInstagramSource('design.inspiration')?.username).toBe('design.inspiration');
    expect(parseInstagramSource('  @Design_Inspiration  ')?.username).toBe('design_inspiration');
  });

  it('treats mobile and short hosts as the same source', () => {
    expect(parseInstagramSource('https://m.instagram.com/foo')?.sourceIdentifier).toBe(
      'instagram:profile:foo',
    );
    expect(parseInstagramSource('instagr.am/foo')?.sourceIdentifier).toBe('instagram:profile:foo');
  });

  it('parses post, reel and tv shortcodes', () => {
    expect(parseInstagramSource('https://www.instagram.com/p/Cx1aB2cDeFg/')).toMatchObject({
      kind: 'post',
      shortcode: 'Cx1aB2cDeFg',
      sourceIdentifier: 'instagram:post:Cx1aB2cDeFg',
    });
    expect(parseInstagramSource('https://instagram.com/reel/AbCdE12345')).toMatchObject({
      kind: 'reel',
      canonicalUrl: 'https://www.instagram.com/reel/AbCdE12345/',
    });
    expect(parseInstagramSource('https://instagram.com/tv/ZzYyXx9876')).toMatchObject({
      kind: 'tv',
    });
  });

  it('treats /reels/<code> as the /reel/<code> alias', () => {
    const parsed = parseInstagramSource('https://www.instagram.com/reels/AbCdE12345/');
    expect(parsed?.kind).toBe('reel');
    expect(parsed?.sourceIdentifier).toBe('instagram:post:AbCdE12345');
  });

  it('rejects non-Instagram hosts', () => {
    expect(parseInstagramSource('https://example.com/foo')).toBeNull();
    expect(parseInstagramSource('https://tiktok.com/@foo')).toBeNull();
    expect(parseInstagramSource('https://instagram.com.evil.example/foo')).toBeNull();
  });

  it('rejects reserved routes', () => {
    expect(parseInstagramSource('https://www.instagram.com/explore/')).toBeNull();
    expect(parseInstagramSource('https://www.instagram.com/stories/foo')).toBeNull();
    expect(parseInstagramSource('https://www.instagram.com/accounts/login/')).toBeNull();
  });

  it('rejects malformed shortcodes and empty input', () => {
    expect(parseInstagramSource('https://instagram.com/p/')).toBeNull();
    expect(parseInstagramSource('https://instagram.com/p/ab')).toBeNull();
    expect(parseInstagramSource('')).toBeNull();
    expect(parseInstagramSource('   ')).toBeNull();
  });

  it('rejects handles that are too long or contain illegal characters', () => {
    expect(isValidInstagramUsername('a'.repeat(31))).toBe(false);
    expect(isValidInstagramUsername('has space')).toBe(false);
    expect(isValidInstagramUsername('has-dash')).toBe(false);
    expect(isValidInstagramUsername('ok.handle_1')).toBe(true);
  });
});

describe('collectionNameForSource', () => {
  it('names profiles after the handle', () => {
    const parsed = parseInstagramSource('design.inspiration')!;
    expect(collectionNameForSource(parsed)).toBe('@design.inspiration');
  });

  it('names posts after the shortcode', () => {
    const parsed = parseInstagramSource('https://instagram.com/reel/AbCdE12345')!;
    expect(collectionNameForSource(parsed)).toBe('Instagram reel AbCdE12345');
  });
});

describe('slugify', () => {
  it('produces a stable uniqueness key', () => {
    expect(slugify('@Design.Inspiration')).toBe('design-inspiration');
    expect(slugify('  Lead   Gen  ')).toBe('lead-gen');
    expect(slugify('---')).toBe('');
    expect(slugify('Ünïcode ok')).toBe('unicode-ok');
  });

  it('caps length so the unique index is not blown out', () => {
    expect(slugify('a'.repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

describe('describeUnsupportedSource', () => {
  it('explains the failure in the user’s terms', () => {
    expect(describeUnsupportedSource('')).toMatch(/Enter an Instagram/);
    expect(describeUnsupportedSource('https://example.com/x')).toMatch(/Only Instagram/);
    expect(describeUnsupportedSource('https://instagram.com/explore/')).toMatch(/not a profile/);
    expect(describeUnsupportedSource('bad handle!')).toMatch(/valid Instagram handle/);
  });
});
