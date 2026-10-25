import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * Tests are pure unit tests over the shared logic and the Worker's pure
 * helpers: no D1, no network, no paid AI calls. Anything that needs a binding is
 * exercised through the documented manual checklist in README § Testing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/api/tests/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/shared/src/**/*.ts', 'apps/api/src/services/search.ts'],
      exclude: ['**/*.test.ts'],
    },
  },
});
