#!/usr/bin/env node
// Flagshots from the command line: screenshot an app in each flag state and build the grids.
//
//   node src/cli.js [--config flagshots.config.json] [--out .flagshots] [--flags a,b]
//
// It reads three settings from the environment (or from .env.local, which npm run seed writes):
//   FLAGSMITH_API_URL          the API root, http://localhost:8000/api/v1 by default
//   FLAGSMITH_ENVIRONMENT_KEY  the client-side key of the environment to screenshot
//   FLAGSMITH_ADMIN_API_KEY    an organisation Master API key, used to read flags and set identity overrides
//
// The overrides are set with the Flagsmith CLI, so the flagsmith binary has to be on the PATH
// (or FLAGSHOTS_FLAGSMITH_CLI has to point at it).
// The app should be running at the config's baseUrl, or starting up: Flagshots waits for it.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { FlagsmithAdmin } from './flagsmith-admin.js';
import { FlagsmithCli } from './flagsmith-cli.js';
import { planShots, attachExperiments, slug } from './plan.js';
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

// Waits until something answers at the app's address. In CI the app is still building
// in the background when this starts.
async function waitForApp(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `Nothing answered at ${baseUrl} after ${timeoutMs / 1000} seconds. Start the app first, or fix baseUrl ` +
      'in flagshots.config.json. In the Action, start-command has to serve the app there: the "Show the ' +
      'app\'s log" step below prints what it said.',
  );
}

// Each setting, with the action input that fills it in a GitHub Actions job.
const INPUTS = { FLAGSMITH_ENVIRONMENT_KEY: 'environment-key', FLAGSMITH_ADMIN_API_KEY: 'admin-api-key' };

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. On your machine, npm run seed writes it to .env.local for the local Flagsmith. ` +
        `In the Action, set the ${INPUTS[name]} input, or leave flagsmith-api-url empty so Flagshots runs its own Flagsmith.`,
    );
  }
  return value;
}

// The first Admin API call. A wrong key or environment fails here, so the message says which.
async function findEnvironment(admin, environmentKey) {
  try {
    return await admin.environmentByKey(environmentKey);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new Error(
        `Flagsmith turned down the admin key (${err.status}). FLAGSMITH_ADMIN_API_KEY (the admin-api-key input) ` +
          'has to be an organisation Master API key, from Organisation settings, API Keys.',
      );
    }
    if (err.status === 404) {
      throw new Error(
        `Flagsmith has no environment with the key ${environmentKey}. FLAGSMITH_ENVIRONMENT_KEY (the ` +
          'environment-key input) is the client-side key from the environment\'s SDK keys page.',
      );
    }
    throw err;
  }
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
  const apiKey = requireEnv('FLAGSMITH_ADMIN_API_KEY');
  const admin = new FlagsmithAdmin(apiUrl, apiKey);

  await admin.waitUntilReady(config.waitSeconds * 1000);
  await waitForApp(config.baseUrl, config.waitSeconds * 1000);

  // The environment key tells us the project, and the project has the features.
  const environment = await findEnvironment(admin, environmentKey);
  const features = await admin.features(environment.project);
  const states = await admin.environmentFeatureStates(environmentKey);
  const only = args.flags ? args.flags.split(',').map((f) => f.trim()) : config.flags;
  const rows = planShots(features, states, { only });
  if (!rows.length) throw new Error('Flagsmith returned no flags to screenshot for this environment.');
  // A flag in a Flagsmith experiment gets the experiment's name and hypothesis on its row,
  // and its control and treatment shots are labelled.
  attachExperiments(rows, await admin.experiments(environmentKey));
  for (const row of rows.filter((r) => r.experiment)) {
    console.log(`${row.flag} is in the experiment "${row.experiment.name}" (${row.experiment.status})`);
  }

  const shots = rows.reduce((n, r) => n + r.cells.length - 1, 1);
  console.log(`${rows.length} flags in ${environment.name}, ${shots} shots per page`);

  const cli = new FlagsmithCli({ apiUrl, masterKey: apiKey, environmentKey, projectId: environment.project });
  console.log(`Setting the overrides with ${await cli.version()}`);
  await applyOverrides(cli, admin, environmentKey, rows);
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
      experiment: r.experiment ?? null,
      states: r.cells.map((c) => ({ label: c.label, default: c.isDefault, identity: c.identity, arm: c.arm ?? null })),
    })),
    pages,
  };
  await writeFile(path.join(args.out, 'flagshots.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`Flagshots stopped: ${err.message}`);
  process.exit(1);
});
