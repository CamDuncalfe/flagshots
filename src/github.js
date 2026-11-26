// The GitHub API calls Flagshots makes: store the grid images, then post or edit one comment.
// Plain fetch with the job's token, the same way src/flagsmith-admin.js talks to Flagsmith.

import { readFile } from 'node:fs/promises';

export class GitHub {
  constructor({ token, repo, apiUrl = 'https://api.github.com' }) {
    this.token = token;
    this.repo = repo; // owner/name
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  async request(method, path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  // Commits the images to their own branch, which shares no history with the code, so the
  // pull request's branch never gets image commits. It goes through the Git Data API
  // (blobs, a tree, a commit, then the branch ref) and needs no git checkout.
  //
  // files: [{ path: 'pr-12/abc1234/home.png', file: '/tmp/flagshots/home.png' }]
  // Returns the new commit's SHA, which the image links use.
  async commitImages(branch, files, message) {
    const blobs = [];
    for (const f of files) {
      const content = (await readFile(f.file)).toString('base64');
      const blob = await this.request('POST', `/repos/${this.repo}/git/blobs`, { content, encoding: 'base64' });
      blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // Two runs can finish at the same moment. If the branch moved after we read it, GitHub
    // refuses the update, so read it again and retry.
    for (let attempt = 1; ; attempt++) {
      let parent = null;
      try {
        parent = (await this.request('GET', `/repos/${this.repo}/git/ref/heads/${branch}`)).object.sha;
      } catch (err) {
        if (err.status !== 404) throw err; // 404: the first run, so the branch doesn't exist yet
      }
      const baseTree = parent
        ? (await this.request('GET', `/repos/${this.repo}/git/commits/${parent}`)).tree.sha
        : undefined;
      const tree = await this.request('POST', `/repos/${this.repo}/git/trees`, { base_tree: baseTree, tree: blobs });
      const commit = await this.request('POST', `/repos/${this.repo}/git/commits`, {
        message,
        tree: tree.sha,
        parents: parent ? [parent] : [],
      });
      try {
        if (parent) {
          await this.request('PATCH', `/repos/${this.repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
        } else {
          await this.request('POST', `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
        }
        return commit.sha;
      } catch (err) {
        if (err.status !== 422 || attempt >= 3) throw err;
      }
    }
  }

  // Edits the comment that carries the marker, or posts a new one if there isn't one yet.
  async upsertComment(issueNumber, marker, body) {
    for (let page = 1; ; page++) {
      const comments = await this.request(
        'GET',
        `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      const existing = comments.find((c) => c.body?.includes(marker));
      if (existing) {
        return this.request('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
      }
      if (comments.length < 100) break;
    }
    return this.request('POST', `/repos/${this.repo}/issues/${issueNumber}/comments`, { body });
  }
}
