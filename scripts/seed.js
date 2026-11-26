// Sets up a local Flagsmith with the demo project from flagshots.seed.json.
//
//   node scripts/seed.js
//
// It signs up a local admin user, creates the organisation, project, environment and features,
// then writes the environment key to demo/.env.local so the demo app can read its flags.
// Running it twice is safe: anything that already exists is reused.

import { readFile, writeFile } from 'node:fs/promises';
import { FlagsmithAdmin } from '../src/flagsmith-admin.js';

const apiUrl = process.env.FLAGSMITH_API_URL ?? 'http://localhost:8000/api/v1';
// This account only exists on your local Flagsmith. Set your own with these two variables.
const email = process.env.FLAGSHOTS_ADMIN_EMAIL ?? 'admin@flagshots.example';
const password = process.env.FLAGSHOTS_ADMIN_PASSWORD ?? 'local-flagshots-admin-2026';

const seed = JSON.parse(await readFile(new URL('../flagshots.seed.json', import.meta.url)));
const admin = new FlagsmithAdmin(apiUrl);

await admin.waitUntilReady();
await admin.signUpOrLogIn(email, password);

const organisation = await admin.organisation(seed.organisation);
const project = await admin.project(seed.project, organisation.id);
const environment = await admin.environment(seed.environment, project.id);

const existing = new Set((await admin.features(project.id)).map((f) => f.name));
for (const feature of seed.features) {
  if (existing.has(feature.name)) continue;
  // A multivariate feature takes its control value as initial_value and each other value
  // as an option. The options get 0% weight, so a normal visitor sees the control value
  // until someone sets a split in the dashboard.
  await admin.createFeature(project.id, {
    name: feature.name,
    description: feature.description,
    type: feature.type,
    default_enabled: feature.enabled,
    initial_value: feature.value ?? null,
    multivariate_options: (feature.variants ?? []).map((value) => ({
      type: 'unicode',
      string_value: value,
      default_percentage_allocation: 0,
    })),
  });
  console.log(`Created ${feature.name}`);
}

// default_enabled only applies to environments made after the feature, so set each
// environment state to the seed's on or off as well.
const wanted = new Map(seed.features.map((f) => [f.name, f.enabled]));
const byId = new Map((await admin.features(project.id)).map((f) => [f.id, f.name]));
for (const state of await admin.environmentFeatureStates(environment.api_key)) {
  const name = byId.get(state.feature);
  if (wanted.has(name) && state.enabled !== wanted.get(name)) {
    await admin.updateFeatureState(environment.api_key, state.id, { enabled: wanted.get(name) });
  }
}

const browserApiUrl = process.env.FLAGSMITH_BROWSER_API_URL ?? apiUrl;
await writeFile(
  new URL('../demo/.env.local', import.meta.url),
  `VITE_FLAGSMITH_API_URL=${browserApiUrl}/\nVITE_FLAGSMITH_ENVIRONMENT_KEY=${environment.api_key}\n`,
);

console.log(`Flagsmith dashboard: ${apiUrl.replace(/\/api\/v1$/, '')}`);
console.log(`Environment key ${environment.api_key} written to demo/.env.local`);
