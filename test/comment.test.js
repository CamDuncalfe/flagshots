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

test('names the experiment a flag is in, quotes its hypothesis and labels the arms in the table', () => {
  const withExperiment = {
    ...summary,
    flags: [
      {
        flag: 'checkout_button_copy',
        experiment: { name: 'Sign-up button copy', status: 'not started', hypothesis: 'Shorter wins.' },
        states: [
          { label: 'Start free trial', default: true, identity: null, arm: 'Control, 50%' },
          { label: 'Get started', default: false, identity: 'flagshots-checkout_button_copy-get-started', arm: 'Treatment, 50%' },
        ],
      },
    ],
  };
  const body = commentBody(withExperiment);
  assert.match(body, /`checkout_button_copy` is in the Flagsmith experiment \u201cSign-up button copy\u201d \(not started\)\. Its row labels the control and treatment shots\./);
  assert.match(body, /> Shorter wins\./);
  assert.match(body, /\| Start free trial \(Control, 50%\) \| Get started \(Treatment, 50%\) \|/);
});

