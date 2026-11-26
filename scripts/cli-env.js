// In a GitHub Actions job, gets the Flagsmith CLI ready for the Flagsmith the job uses.
//
//   node scripts/cli-env.js   (prints the instance root for Flagsmith/setup-cli's api-url)
//
// It puts the Master API key in $GITHUB_ENV under the name the CLI looks for
// (FLAGSMITH_API_KEY_localhost_8000 for the Flagsmith inside the job). Flagsmith/setup-cli finds
// it there, so it installs the CLI without asking the job for an OIDC token.

import { appendFile } from 'node:fs/promises';
import { apiKeyVariable, apiRoot } from '../src/flagsmith-cli.js';

const apiUrl = process.env.FLAGSMITH_API_URL;
const apiKey = process.env.FLAGSMITH_ADMIN_API_KEY;
if (!apiUrl || !apiKey) {
  console.error(
    '::error::Flagshots has no Flagsmith to work with. Leave flagsmith-api-url empty to run Flagsmith in the job, ' +
      'or set flagsmith-api-url, environment-key and admin-api-key for your own Flagsmith.',
  );
  process.exit(1);
}

await appendFile(process.env.GITHUB_ENV, `${apiKeyVariable(apiUrl)}=${apiKey}\n`);
console.log(apiRoot(apiUrl));
