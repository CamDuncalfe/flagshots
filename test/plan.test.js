import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShots, attachExperiments, slug } from '../src/plan.js';

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

// checkout_button_copy as the seed makes it: control "Start free trial", options 3 and 4.
const copyFlag = {
  id: 3,
  name: 'checkout_button_copy',
  type: 'MULTIVARIATE',
  multivariate_options: [
    { id: 3, type: 'unicode', string_value: 'Get started' },
    { id: 4, type: 'unicode', string_value: 'Try it free for 14 days' },
  ],
};
const experiment = (split, extra = {}) => ({
  feature: { id: 3 },
  name: 'Sign-up button copy',
  hypothesis: 'More visitors start a trial when the button says Get started.',
  status: 'created',
  experiment_rollout: {
    feature_state_value: { type: 'string', value: 'Start free trial' },
    multivariate_feature_state_values: split.map(([option, share]) => ({
      multivariate_feature_option: option,
      percentage_allocation: share,
    })),
  },
  ...extra,
});

test('an experiment labels its control and treatment cells and leaves a 0% value alone', () => {
  const rows = planShots([copyFlag], [state(3, true, 'Start free trial')]);
  attachExperiments(rows, [experiment([[3, 50], [4, 0]])]);
  assert.deepEqual(rows[0].experiment, {
    name: 'Sign-up button copy',
    hypothesis: 'More visitors start a trial when the button says Get started.',
    status: 'not started',
  });
  assert.deepEqual(rows[0].cells.map((c) => [c.label, c.arm ?? null]), [
    ['Start free trial', 'Control, 50%'],
    ['Get started', 'Treatment, 50%'],
    ['Try it free for 14 days', null],
  ]);
});

test('two treatments are lettered and control gets what is left', () => {
  const rows = planShots([copyFlag], [state(3, true, 'Start free trial')]);
  attachExperiments(rows, [experiment([[3, 33.3], [4, 33.3]], { status: 'running' })]);
  assert.equal(rows[0].experiment.status, 'running');
  assert.deepEqual(rows[0].cells.map((c) => c.arm), ['Control, 33.4%', 'Treatment A, 33.3%', 'Treatment B, 33.3%']);
});

test('a split that no longer matches the flag labels no cells, and a completed experiment is skipped', () => {
  const rows = planShots([copyFlag], [state(3, true, 'Start free trial')]);
  attachExperiments(rows, [experiment([[9, 50]])]);
  assert.equal(rows[0].experiment.name, 'Sign-up button copy');
  assert.ok(rows[0].cells.every((c) => !c.arm));

  const done = planShots([copyFlag], [state(3, true, 'Start free trial')]);
  attachExperiments(done, [experiment([[3, 50]], { status: 'completed' })]);
  assert.equal(done[0].experiment, undefined);
});

