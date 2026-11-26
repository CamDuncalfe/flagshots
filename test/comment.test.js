import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentBody, MARKER } from '../src/comment.js';

const summary = {
  environment: 'Development',
  flags: [
    {
      flag: 'checkout_button_copy',
      states: [
        { label: 'Start free trial', default: true, identity: null },
        { label: 'Get | started', default: false, identity: 'flagshots-checkout_button_copy-get-started' },
      ],
    },
    { flag: 'dark_mode', states: [{ label: 'Off', default: true, identity: null }, { label: 'On', default: false, identity: 'flagshots-dark_mode-on' }] },
  ],
  pages: [
    { name: 'Home', path: '/', slug: 'home', rows: [{ flag: 'checkout_button_copy', changed: true }, { flag: 'dark_mode', changed: false }] },
  ],
};

test('starts with the marker so the next run can find the comment', () => {
  assert.ok(commentBody(summary).startsWith(`${MARKER}\n`));
});

test('links each page image and names the commit', () => {
  const body = commentBody(summary, { images: new Map([['home', 'https://example.com/home.png']]), commit: 'abc1234def' });
  assert.match(body, /!\[Home in each flag state\]\(https:\/\/example\.com\/home\.png\)/);
  assert.match(body, /Screenshots from abc1234\./);
});

test('points to the run files when there is no image link (fork pull requests)', () => {
  const body = commentBody(summary, { runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.match(body, /The grid for Home is in the `flagshots` files of this run \(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);
  assert.doesNotMatch(body, /!\[/);
});

test('names flags that look the same in every state on a page', () => {
  assert.match(commentBody(summary), /No visible difference on Home: `dark_mode`\./);
});

test('escapes pipes in table cells', () => {
  assert.match(commentBody(summary), /\| `checkout_button_copy` \| Start free trial \| Get \\\| started \|/);
});
