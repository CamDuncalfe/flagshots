// Sets up a local Flagsmith with the demo project from flagshots.seed.json.
//
//   node scripts/seed.js
//
// It signs up a local admin user, creates the organisation, project, environment, features and
// experiments and a Master API key, then writes the environment key to demo/.env.local so the demo
// app can read its flags, and the settings npm run shots needs to .env.local.
// Running it twice is safe: anything that already exists is reused.
//
// FLAGSHOTS_SEED_FILE picks another seed file (the default is flagshots.seed.json in the
// current folder). Inside a GitHub Actions job it writes no files: the three settings go to
// $GITHUB_ENV instead, so the app build and the screenshot step that come after can read them.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { FlagsmithAdmin } from '../src/flagsmith-admin.js';

const apiUrl = process.env.FLAGSMITH_API_URL ?? 'http://localhost:8000/api/v1';
// This account only exists on your local Flagsmith. Set your own with these two variables.
const email = process.env.FLAGSHOTS_ADMIN_EMAIL ?? 'admin@flagshots.example';
const password = process.env.FLAGSHOTS_ADMIN_PASSWORD ?? 'local-flagshots-admin-2026';

const seedFile = path.resolve(process.env.FLAGSHOTS_SEED_FILE ?? 'flagshots.seed.json');
const seed = JSON.parse(await readFile(seedFile, 'utf8'));
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

// On a later run, put each flag back to the seed's on or off, in case someone switched it
// in the dashboard while trying things out.
const wanted = new Map(seed.features.map((f) => [f.name, f.enabled]));
const byId = new Map((await admin.features(project.id)).map((f) => [f.id, f.name]));
for (const state of await admin.environmentFeatureStates(environment.api_key)) {
  const name = byId.get(state.feature);
  if (wanted.has(name) && state.enabled !== wanted.get(name)) {
    await admin.updateFeatureState(environment.api_key, state.id, { enabled: wanted.get(name) });
    console.log(`Turned ${name} ${wanted.get(name) ? 'on' : 'off'}`);
  }
}

// Experiments are created but not started, so the pull request shows both arms before any
// visitor is put in one. The seed gives each value it doesn't name a 0% share, because
// Flagsmith wants every value of the flag listed.
const valueType = (v) => (typeof v === 'number' ? 'integer' : typeof v === 'boolean' ? 'boolean' : 'string');
const features = await admin.features(project.id);
const experimentNames = new Set((await admin.experiments(environment.api_key)).map((e) => e.name));
for (const experiment of seed.experiments ?? []) {
  if (experimentNames.has(experiment.name)) continue;
  const feature = features.find((f) => f.name === experiment.flag);
  if (!feature) throw new Error(`The seed's experiment "${experiment.name}" names a flag that doesn't exist: ${experiment.flag}`);
  const split = experiment.split ?? {};
  const control = feature.initial_value;
  await admin.createExperiment(environment.api_key, {
    feature: feature.id,
    name: experiment.name,
    hypothesis: experiment.hypothesis,
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: valueType(control), value: String(control) },
      multivariate_feature_state_values: feature.multivariate_options.map((o) => ({
        multivariate_feature_option: o.id,
        percentage_allocation: split[o.string_value ?? o.integer_value ?? o.boolean_value] ?? 0,
      })),
    },
  });
  console.log(`Created the experiment ${experiment.name}`);
}

// npm run shots and the Flagsmith CLI both use an organisation Master API key, not the
// sign-in token above. Flagsmith shows a new key once, so a key from an earlier run is
// kept in .env.local and reused while it still works.
let apiKey = null;
if (!process.env.GITHUB_ENV) {
  try {
    process.loadEnvFile(new URL('../.env.local', import.meta.url));
    apiKey = process.env.FLAGSMITH_ADMIN_API_KEY ?? null;
  } catch {
    // No .env.local yet.
  }
}
if (!apiKey || !(await admin.apiKeyWorks(apiKey))) {
  apiKey = await admin.createMasterApiKey(organisation.id, 'Flagshots');
  console.log('Created a Master API key for Flagshots');
}

if (process.env.GITHUB_ENV) {
  // The key can change flags on this Flagsmith, so it's hidden from the job log.
  console.log(`::add-mask::${apiKey}`);
  await appendFile(
    process.env.GITHUB_ENV,
    `FLAGSMITH_API_URL=${apiUrl}\nFLAGSMITH_ENVIRONMENT_KEY=${environment.api_key}\nFLAGSMITH_ADMIN_API_KEY=${apiKey}\n`,
  );
  console.log(`Seeded ${seed.project} / ${seed.environment}, environment key ${environment.api_key}`);
} else {
  const browserApiUrl = process.env.FLAGSMITH_BROWSER_API_URL ?? apiUrl;
  await writeFile(
    new URL('../demo/.env.local', import.meta.url),
    `VITE_FLAGSMITH_API_URL=${browserApiUrl}/\nVITE_FLAGSMITH_ENVIRONMENT_KEY=${environment.api_key}\n`,
  );

  // Settings for npm run shots on this machine. .env.local is in .gitignore: the key is an admin key.
  await writeFile(
    new URL('../.env.local', import.meta.url),
    `FLAGSMITH_API_URL=${apiUrl}\nFLAGSMITH_ENVIRONMENT_KEY=${environment.api_key}\nFLAGSMITH_ADMIN_API_KEY=${apiKey}\n`,
  );

  console.log(`Flagsmith dashboard: ${apiUrl.replace(/\/api\/v1$/, '')}`);
  console.log(`Environment key ${environment.api_key} written to demo/.env.local`);
}
