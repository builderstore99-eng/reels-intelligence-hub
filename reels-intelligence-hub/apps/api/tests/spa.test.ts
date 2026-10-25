import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { Env } from '../src/env';

/**
 * Routing between the API, the uploaded frontend assets, and client-side routes.
 *
 * This split decides whether a deployed instance works at all: if `/api/*`
 * falls through to `index.html`, every API call returns HTML and the app dies
 * with a JSON parse error. The Worker is exercised here with a fake `ASSETS`
 * binding, which is exactly the shape Cloudflare provides in production.
 */

/** Minimal Fetcher stand-in: serves a fixed set of paths. */
function fakeAssets(files: Record<string, string>): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, 'https://example.com').pathname;
      const body = files[path];
      if (body === undefined) {
        return new Response('not found', { status: 404 });
      }
      const contentType = path.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : path.endsWith('.js')
          ? 'text/javascript'
          : 'application/octet-stream';
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    },
  } as unknown as Fetcher;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ENVIRONMENT: 'test',
    ENABLE_TRANSCRIPTION: 'true',
    ENABLE_VISUAL_ANALYSIS: 'true',
    ENABLE_SEMANTIC_SEARCH: 'true',
    ENABLE_DEMO_MODE: 'false',
    ...overrides,
  } as unknown as Env;
}

const HTML = '<!doctype html><title>app</title><div id="root"></div>';
const assets = fakeAssets({
  '/': HTML,
  '/index.html': HTML,
  '/assets/app.js': 'console.log("hi")',
  '/favicon.ico': 'icon',
});

describe('frontend delivery', () => {
  it('serves index.html for the root path', async () => {
    const response = await app.request('/', {}, makeEnv({ ASSETS: assets }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('serves a real asset with its own content type', async () => {
    const response = await app.request('/assets/app.js', {}, makeEnv({ ASSETS: assets }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for a client-side route', async () => {
    const response = await app.request(
      '/collections/abc123',
      { headers: { accept: 'text/html,application/xhtml+xml' } },
      makeEnv({ ASSETS: assets }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('returns JSON — never HTML — for a non-HTML request to a missing path', async () => {
    const response = await app.request(
      '/nope.txt',
      { headers: { accept: 'text/plain' } },
      makeEnv({ ASSETS: assets }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('returns a JSON 404 for an unknown API route, not the SPA shell', async () => {
    const response = await app.request(
      '/api/v1/does-not-exist',
      { headers: { accept: 'text/html' } },
      makeEnv({ ASSETS: assets }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('reports a missing frontend build clearly instead of crashing', async () => {
    const response = await app.request('/', {}, makeEnv());
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/build:web/);
  });

  it('rejects non-GET requests to unknown paths with JSON', async () => {
    const response = await app.request(
      '/collections/abc',
      { method: 'POST', headers: { accept: 'text/html' } },
      makeEnv({ ASSETS: assets }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('health endpoint', () => {
  it('reports degraded and names the missing secrets when they are absent', async () => {
    const response = await app.request('/api/v1/health', {}, makeEnv({ DB: {} as D1Database }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { data: { status: string; missing: string[] } };
    expect(body.data.status).toBe('degraded');
    expect(body.data.missing).toContain('AUTH_SECRET');
    expect(body.data.missing).toContain('SECRETS_ENCRYPTION_KEY');
  });

  it('never echoes a secret value', async () => {
    const response = await app.request(
      '/api/v1/health',
      {},
      makeEnv({
        DB: {} as D1Database,
        AUTH_SECRET: 'super-secret-value',
        SECRETS_ENCRYPTION_KEY: 'another-secret-value',
      }),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('another-secret-value');
  });
});

describe('unauthenticated access', () => {
  it('refuses a protected route without a token', async () => {
    const response = await app.request(
      '/api/v1/settings/api-keys',
      {},
      makeEnv({ ASSETS: assets }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses the API-keys write path before it can reach the database', async () => {
    const response = await app.request(
      '/api/v1/settings/api-keys/openai',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', value: 'sk-proj-abcdefghijklmnop' }),
      },
      makeEnv({ ASSETS: assets }),
    );
    expect(response.status).toBe(401);
  });
});
