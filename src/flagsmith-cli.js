// Sets identity overrides with the Flagsmith CLI (https://github.com/Flagsmith/flagsmith-cli).
//
// Flagshots reads flags over the REST API with fetch, and writes every override through the CLI:
//
//   flagsmith flag update hero_layout --identifier flagshots-hero_layout-split --enable --value split
//
// The CLI creates the identity if it doesn't exist and updates the override in place on a rerun.
// In GitHub Actions, Flagsmith/setup-cli installs it. On your own machine, install it from the
// CLI's releases page, or point FLAGSHOTS_FLAGSMITH_CLI at the binary.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The CLI wants the instance root (http://localhost:8000), where the REST calls use .../api/v1.
export function apiRoot(apiUrl) {
  return apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

// The CLI only sends a key to the instance it was set for, so a self-hosted key goes in a variable
// named after the host and port: localhost:8000 -> FLAGSMITH_API_KEY_localhost_8000.
// "-" becomes "__", "." and ":" become "_", the same rule Flagsmith/setup-cli uses.
export function apiKeyVariable(apiUrl) {
  const host = new URL(apiUrl).host
    .toLowerCase()
    .replace(/[[\]]/g, '')
    .replace(/-/g, '__')
    .replace(/[.:]/g, '_');
  return `FLAGSMITH_API_KEY_${host}`;
}

// The CLI infers a value's type, so "10" would become a number. Each value goes with its own type.
function valueType(value) {
  if (typeof value === 'number') return 'integer';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

export class FlagsmithCli {
  // apiUrl: the API root the REST calls use. masterKey: an organisation Master API key.
  constructor({ apiUrl, masterKey, environmentKey, projectId, bin = process.env.FLAGSHOTS_FLAGSMITH_CLI ?? 'flagsmith' }) {
    this.bin = bin;
    this.root = apiRoot(apiUrl);
    this.globalArgs = ['--api-url', this.root, '--environment', environmentKey, '--project', String(projectId), '--no-input', '--yes'];

    // The child process gets the key and nothing else of ours that starts with FLAGSMITH_.
    // Flagshots' own FLAGSMITH_API_URL ends in /api/v1, which the CLI would read as the root.
    this.env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FLAGSMITH_')));
    this.env[apiKeyVariable(this.root)] = masterKey;
  }

  async exec(args, { global = true } = {}) {
    try {
      const { stdout } = await run(this.bin, global ? [...args, ...this.globalArgs] : args, { env: this.env });
      return stdout.trim();
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `The Flagsmith CLI isn't installed (looked for "${this.bin}"). Flagshots sets its overrides with it: ` +
            'install it from https://github.com/Flagsmith/flagsmith-cli/releases or set FLAGSHOTS_FLAGSMITH_CLI.',
        );
      }
      const output = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim();
      throw new Error(`flagsmith ${args.join(' ')} failed: ${output || err.message}`);
    }
  }

  version() {
    return this.exec(['--version'], { global: false });
  }

  // One identity's override for one flag: on or off, and the value when it has one.
  // "--value=" keeps a value that starts with "-" from being read as an option.
  setIdentityOverride(identifier, flag, { enabled, value }) {
    const args = ['flag', 'update', flag, '--identifier', identifier, enabled ? '--enable' : '--disable'];
    if (value !== null && value !== undefined) args.push(`--value=${value}`, '--type', valueType(value));
    return this.exec(args);
  }
}
