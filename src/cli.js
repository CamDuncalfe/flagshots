#!/usr/bin/env node
// Flagshots from the command line: screenshot an app in each flag state and build the grids.
//
//   node src/cli.js [--config flagshots.config.json] [--out .flagshots] [--flags a,b]
//
// It reads three settings from the environment (or from .env.local, which npm run seed writes):
//   FLAGSMITH_API_URL          the API root, http://localhost:8000/api/v1 by default
//   FLAGSMITH_ENVIRONMENT_KEY  the client-side key of the environment to screenshot
//   FLAGSMITH_ADMIN_TOKEN      an Admin API token, used to read flags and set identity overrides
//
// The app has to be running at the config's baseUrl before this starts.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { FlagsmithAdmin } from './flagsmith-admin.js';
import { planShots, slug } from './plan.js';
import { applyOverrides, checkOverrides } from './overrides.js';
import { renderPages } from './render.js';
import { buildGrid } from './grid.js';

const DEFAULTS = {
  baseUrl: 'http://localhost:5173',
  pages: [{ name: 'Home', path: '/' }],
  identityParam: 'flagshots_identity',
  readySelector: null,
  viewport: { width: 1280, height: 800 },
  timeoutMs: 15_000,
  waitSeconds: 120,
};

async function loadConfig(file) {
  let fromFile = {};
  try {
    fromFile = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${err.message}`);
  }
  const config = { ...DEFAULTS, ...fromFile };
  config.pages = config.pages.map((p) => ({ ...p, slug: slug(p.name) }));
  return config;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run npm run seed for a local Flagsmith, or set it yourself.`);
  return value;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      config: { type: 'string', default: 'flagshots.config.json' },
      out: { type: 'string', default: '.flagshots' },
      flags: { type: 'string' },
    },
  });

  try {
    process.loadEnvFile('.env.local');
  } catch {
    // No .env.local: the settings come from the environment.
  }

  const config = await loadConfig(args.config);
  const apiUrl = process.env.FLAGSMITH_API_URL ?? 'http://localhost:8000/api/v1';
  const environmentKey = requireEnv('FLAGSMITH_ENVIRONMENT_KEY');
  const admin = new FlagsmithAdmin(apiUrl, requireEnv('FLAGSMITH_ADMIN_TOKEN'));

  await admin.waitUntilReady(config.waitSeconds * 1000);

  // The environment key tells us the project, and the project has the features.
  const environment = await admin.environmentByKey(environmentKey);
  const features = await admin.features(environment.project);
  const states = await admin.environmentFeatureStates(environmentKey);
  const only = args.flags ? args.flags.split(',').map((f) => f.trim()) : config.flags;
  const rows = planShots(features, states, { only });
  if (!rows.length) throw new Error('Flagsmith returned no flags to screenshot for this environment.');

  const shots = rows.reduce((n, r) => n + r.cells.length - 1, 1);
  console.log(`${rows.length} flags in ${environment.name}, ${shots} shots per page`);

  await applyOverrides(admin, environmentKey, rows);
  await checkOverrides(admin, environmentKey, rows);

  await mkdir(args.out, { recursive: true });
  const browser = await chromium.launch();
  const pages = [];
  try {
    for (const rendered of await renderPages(browser, rows, config, args.out)) {
      const gridFile = path.join(args.out, `${rendered.page.slug}.png`);
      const measured = await buildGrid(browser, rows, rendered, gridFile);
      pages.push({ ...rendered.page, grid: gridFile, rows: measured });
      console.log(`Grid for ${rendered.page.name}: ${gridFile}`);
    }
  } finally {
    await browser.close();
  }

  // A summary for the step that posts the pull request comment.
  const summary = {
    environment: environment.name,
    flags: rows.map((r) => ({
      flag: r.flag,
      description: r.description,
      states: r.cells.map((c) => ({ label: c.label, default: c.isDefault, identity: c.identity })),
    })),
    pages,
  };
  await writeFile(path.join(args.out, 'flagshots.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`Flagshots stopped: ${err.message}`);
  process.exit(1);
});
