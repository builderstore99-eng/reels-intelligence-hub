#!/usr/bin/env node
/**
 * Produce the two artefacts needed to deploy from the Cloudflare dashboard
 * without a terminal: a single-file Worker bundle and the schema as one SQL file.
 *
 *   npm run bundle:paste
 *
 * Writes to dashboard-deploy/. This is a fallback path — `npm run setup` is the
 * supported way to deploy, and is faster and far less error-prone.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dashboard-deploy');

function run(command, args, label) {
  process.stdout.write(`  ${label}…\n`);
  execFileSync(command, args, { cwd: root, stdio: 'pipe' });
}

process.stdout.write('Bundling for the Cloudflare dashboard\n');

run('npm', ['run', 'build:web'], 'building the frontend');
run(
  'npx',
  [
    'wrangler',
    'deploy',
    '--dry-run',
    '--outdir',
    'apps/api/dist',
    '--config',
    'apps/api/wrangler.toml',
  ],
  'bundling the Worker',
);

mkdirSync(outDir, { recursive: true });

// The sourcemap comment would point at a file the dashboard never receives.
const bundle = readFileSync(join(root, 'apps/api/dist/index.js'), 'utf8')
  .replace(/\/\/# sourceMappingURL=.*$/m, '')
  .trimEnd();
writeFileSync(join(outDir, 'worker.js'), `${bundle}\n`);

writeFileSync(
  join(outDir, 'schema.sql'),
  readFileSync(join(root, 'apps/api/migrations/0001_init.sql'), 'utf8'),
);

// Keep the instructions next to the artefacts, so the folder is self-contained.
writeFileSync(
  join(outDir, 'README-DASHBOARD.md'),
  readFileSync(join(root, 'docs/DASHBOARD-DEPLOY.md'), 'utf8'),
);

const kb = Math.round(Buffer.byteLength(bundle) / 1024);
process.stdout.write(`
  ✓ dashboard-deploy/worker.js   ${kb} KB — paste into the Worker editor
  ✓ dashboard-deploy/schema.sql  — paste into the D1 console
  ✓ dashboard-deploy/README-DASHBOARD.md

  Follow dashboard-deploy/README-DASHBOARD.md. Remember the five bindings:
    DB (D1) · MEDIA (R2) · PIPELINE (Queue) · VECTORS (Vectorize) · AI (Workers AI)
`);
