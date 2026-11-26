import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShots, slug } from '../src/plan.js';

const bool = (id, name) => ({ id, name, type: 'STANDARD', multivariate_options: [] });
const multi = (id, name, values) => ({
  id,
  name,
  type: 'MULTIVARIATE',
  multivariate_options: values.map((v) => ({ type: 'unicode', string_value: v })),
});
const state = (feature, enabled, value = null) => ({ feature, enabled, feature_state_value: value });

test('an on/off flag that is off gets an On shot', () => {
  const [row] = planShots([bool(1, 'badge')], [state(1, false)]);
  assert.deepEqual(row.cells.map((c) => [c.label, c.isDefault, c.identity]), [
    ['Off', true, null],
    ['On', false, 'flagshots-badge-on'],
  ]);
  assert.equal(row.cells[1].enabled, true);
});

test('an on/off flag that is on gets an Off shot', () => {
  const [row] = planShots([bool(1, 'badge')], [state(1, true)]);
  assert.deepEqual(row.cells.map((c) => [c.label, c.enabled]), [
    ['On', true],
    ['Off', false],
  ]);
});

test('a multivariate flag gets its control value first, then each option', () => {
  const [row] = planShots([multi(1, 'hero', ['split', 'banner'])], [state(1, true, 'classic')]);
  assert.deepEqual(row.cells.map((c) => [c.label, c.value, c.isDefault]), [
    ['classic', 'classic', true],
    ['split', 'split', false],
    ['banner', 'banner', false],
  ]);
});

test('a multivariate flag that is off shows Off, then every value including the control', () => {
  const [row] = planShots([multi(1, 'hero', ['split'])], [state(1, false, 'classic')]);
  assert.deepEqual(row.cells.map((c) => c.label), ['Off', 'classic', 'split']);
  assert.ok(row.cells.slice(1).every((c) => c.enabled));
});

test('values that slug the same get different identities', () => {
  const [row] = planShots([multi(1, 'copy', ['Get started', 'get-started'])], [state(1, true, 'Go')]);
  const identities = row.cells.map((c) => c.identity).filter(Boolean);
  assert.deepEqual(identities, ['flagshots-copy-get-started', 'flagshots-copy-get-started-2']);
});

test('only limits the plan to the named flags', () => {
  const rows = planShots(
    [bool(1, 'a'), bool(2, 'b')],
    [state(1, false), state(2, false)],
    { only: ['b'] },
  );
  assert.deepEqual(rows.map((r) => r.flag), ['b']);
});

test('slug keeps identity names plain', () => {
  assert.equal(slug('Try it free for 14 days'), 'try-it-free-for-14-days');
  assert.equal(slug('!!!'), 'empty');
});
