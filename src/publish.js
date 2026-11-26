#!/usr/bin/env node
// Puts the grids on the pull request. The action runs this after src/cli.js.
//
//   node src/publish.js <path to flagshots.json>
//
// 1. Commits each page's grid image to the flagshots-images branch.
// 2. Writes the comment and posts it on the pull request, or edits the one from the last push.
// 3. Writes the same text to the job summary, so a run started by hand shows it too.
//
// It reads the job's own settings: GITHUB_TOKEN (the action passes its github-token input),
// GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_RUN_ID and GITHUB_STEP_SUMMARY.

import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHub } from './github.js';
import { commentBody, MARKER } from './comment.js';

const IMAGE_BRANCH = 'flagshots-images';

async function main() {
  const summaryFile = process.argv[2];
  if (!summaryFile) throw new Error('Pass the path to flagshots.json');
  const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
  const summaryDir = path.dirname(summaryFile);

  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN have to be set (they are inside a GitHub Actions job)');
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;

  // On a pull request the job checks out a merge commit; the head commit is the one people pushed.
  const commit = pr?.head?.sha ?? env.GITHUB_SHA;

  // A pull request from a fork gets a read-only token, so nothing can be written to the repo.
  // The grids stay in the run's files (the action uploads them) and the job summary says where.
  const fromFork = Boolean(pr && pr.head?.repo?.full_name !== pr.base?.repo?.full_name);

  const github = new GitHub({ token: env.GITHUB_TOKEN, repo, apiUrl: env.GITHUB_API_URL });
  const images = new Map();
  if (!fromFork) {
    const folder = pr ? `pr-${pr.number}/${commit.slice(0, 7)}` : `run-${env.GITHUB_RUN_ID ?? Date.now()}`;
    const files = summary.pages.map((p) => ({
      slug: p.slug,
      path: `${folder}/${p.slug}.png`,
      file: path.resolve(summaryDir, path.basename(p.grid)),
    }));
    const sha = await github.commitImages(IMAGE_BRANCH, files, `Flagshots grids for ${pr ? `#${pr.number} at ` : ''}${commit.slice(0, 7)}`);
    // The links name the commit, not the branch, so an edited comment always shows the new
    // images and never a cached copy of the old ones.
    for (const f of files) images.set(f.slug, `${server}/${repo}/raw/${sha}/${f.path}`);
    console.log(`Grids committed to ${IMAGE_BRANCH} at ${sha.slice(0, 7)}`);
  }

  const body = commentBody(summary, { images, commit, runUrl });
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, body.replace(MARKER, ''));

  if (!pr) {
    console.log('Not a pull request, so the grids are in the job summary only.');
  } else if (fromFork) {
    console.log('This pull request comes from a fork, whose token cannot comment. The grids are in the job summary and the run files.');
  } else {
    const comment = await github.upsertComment(pr.number, MARKER, body);
    console.log(`Comment: ${comment.html_url}`);
  }
}

main().catch((err) => {
  console.error(`Flagshots could not post the grids: ${err.message}`);
  process.exit(1);
});
