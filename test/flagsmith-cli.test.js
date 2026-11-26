import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyVariable, apiRoot } from '../src/flagsmith-cli.js';

test('the CLI gets the instance root, not the REST path', () => {
  assert.equal(apiRoot('http://localhost:8000/api/v1'), 'http://localhost:8000');
  assert.equal(apiRoot('https://flagsmith.example.com/api/v1/'), 'https://flagsmith.example.com');
  assert.equal(apiRoot('https://api.flagsmith.com'), 'https://api.flagsmith.com');
});

// The same names Flagsmith/setup-cli's own tests expect.
test('the key variable is named after the host and port', () => {
  assert.equal(apiKeyVariable('http://localhost:8000'), 'FLAGSMITH_API_KEY_localhost_8000');
  assert.equal(apiKeyVariable('https://api.flagsmith.com'), 'FLAGSMITH_API_KEY_api_flagsmith_com');
  assert.equal(apiKeyVariable('https://api.flagsmith-staging.com'), 'FLAGSMITH_API_KEY_api_flagsmith__staging_com');
  assert.equal(apiKeyVariable('https://API.Flagsmith.COM/api/v1'), 'FLAGSMITH_API_KEY_api_flagsmith_com');
  assert.equal(apiKeyVariable('https://[::1]:8000'), 'FLAGSMITH_API_KEY___1_8000');
});
