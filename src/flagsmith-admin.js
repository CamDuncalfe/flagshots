// A small client for the Flagsmith Admin API (the REST API the dashboard uses).
// Flagshots needs only a handful of routes, so it calls them with fetch instead of pulling in an SDK.
// Every route here was checked against self-hosted Flagsmith 2.294.0.
// The identity overrides go through the Flagsmith CLI instead: see flagsmith-cli.js.

export class FlagsmithAdmin {
  // apiUrl is the API root, for example http://localhost:8000/api/v1
  // apiKey is an organisation Master API key, the kind the Flagsmith CLI takes too.
  // The seed signs in with a user token first, because a fresh Flagsmith has no keys yet.
  constructor(apiUrl, apiKey = null) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.token = null;
  }

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Token ${this.token}`;
    else if (this.apiKey) headers.Authorization = `Api-Key ${this.apiKey}`;
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Flagsmith ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // Lists come back paginated ({ results, next }) on some routes and as plain arrays on others.
  async list(path) {
    const data = await this.request('GET', path);
    return Array.isArray(data) ? data : data.results;
  }

  // Waits until Flagsmith says its database is migrated and reachable.
  async waitUntilReady(timeoutMs = 120_000) {
    const root = this.apiUrl.replace(/\/api\/v1$/, '');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const res = await fetch(`${root}/health/readiness/`);
        if (res.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Flagsmith at ${root} was not ready after ${timeoutMs / 1000} seconds`);
  }

  // A fresh self-hosted instance has no users. The first sign-up returns an API token,
  // so a script can set everything up with no clicks in the dashboard.
  // On an instance that already has this user, it logs in instead.
  async signUpOrLogIn(email, password) {
    try {
      const user = await this.request('POST', '/auth/users/', {
        email,
        password,
        re_password: password,
        first_name: 'Flagshots',
        last_name: 'Admin',
      });
      this.token = user.key;
    } catch (err) {
      if (!String(err.message).includes('400')) throw err;
      const login = await this.request('POST', '/auth/login/', { email, password });
      this.token = login.key;
    }
    return this.token;
  }

  async findOrCreate(listPath, createPath, name, body) {
    const existing = (await this.list(listPath)).find((item) => item.name === name);
    return existing ?? this.request('POST', createPath, { name, ...body });
  }

  // An organisation Master API key. Flagsmith shows the key once, in the answer to this call.
  async createMasterApiKey(organisationId, name) {
    const created = await this.request('POST', `/organisations/${organisationId}/master-api-keys/`, {
      name,
      is_admin: true,
    });
    return created.key;
  }

  // Whether a Master API key still works here. A key from an older run is gone after
  // docker compose down -v, so the seed makes a new one.
  async apiKeyWorks(apiKey) {
    const res = await fetch(`${this.apiUrl}/organisations/`, { headers: { Authorization: `Api-Key ${apiKey}` } });
    return res.ok;
  }

  organisation(name) {
    return this.findOrCreate('/organisations/', '/organisations/', name, {});
  }

  project(name, organisationId) {
    return this.findOrCreate(
      `/projects/?organisation=${organisationId}`,
      '/projects/',
      name,
      { organisation: organisationId },
    );
  }

  environment(name, projectId) {
    return this.findOrCreate(
      `/environments/?project=${projectId}`,
      '/environments/',
      name,
      { project: projectId },
    );
  }

  features(projectId) {
    return this.list(`/projects/${projectId}/features/`);
  }

  createFeature(projectId, feature) {
    return this.request('POST', `/projects/${projectId}/features/`, feature);
  }

  // The environment's details, including the id of the project it belongs to.
  environmentByKey(environmentKey) {
    return this.request('GET', `/environments/${environmentKey}/`);
  }

  // The environment's own state for each feature: on or off, and the value.
  // Segment overrides come back from the same route, so they're filtered out here.
  async environmentFeatureStates(environmentKey) {
    const states = await this.list(`/environments/${environmentKey}/featurestates/`);
    return states.filter((s) => !s.identity && !s.feature_segment);
  }

  // Asks Flagsmith for an identity's flags the way an app's SDK does, with the client-side
  // environment key and no admin token. Flagshots uses it to check each override took effect.
  async flagsForIdentity(environmentKey, identifier) {
    const data = await this.clientRequest(
      environmentKey,
      `/identities/?identifier=${encodeURIComponent(identifier)}`,
    );
    return flagMap(data.flags);
  }

  // The flags an anonymous visitor gets, which is what the default shot shows.
  async flagsForVisitor(environmentKey) {
    return flagMap(await this.clientRequest(environmentKey, '/flags/'));
  }

  async clientRequest(environmentKey, path) {
    const res = await fetch(`${this.apiUrl}${path}`, { headers: { 'X-Environment-Key': environmentKey } });
    if (!res.ok) throw new Error(`Flagsmith answered ${res.status} for ${path}`);
    return res.json();
  }

  // The environment's experiments that haven't finished, each with its split between control
  // and the other values. The list route leaves the split out, so each one is fetched on its own.
  // An instance without experiments (an older Flagsmith, or experimentation switched off)
  // answers with an error here, and Flagshots carries on without them.
  async experiments(environmentKey) {
    let list;
    try {
      list = await this.list(`/environments/${environmentKey}/experiments/`);
    } catch {
      return [];
    }
    const open = list.filter((e) => e.status !== 'completed');
    return Promise.all(open.map((e) => this.request('GET', `/environments/${environmentKey}/experiments/${e.id}/`)));
  }

  createExperiment(environmentKey, experiment) {
    return this.request('POST', `/environments/${environmentKey}/experiments/`, experiment);
  }

  updateFeatureState(environmentKey, featureStateId, changes) {
    return this.request(
      'PATCH',
      `/environments/${environmentKey}/featurestates/${featureStateId}/`,
      changes,
    );
  }
}

// Flag name -> { id, enabled, value }, from the flags list the client-side API returns.
function flagMap(flags) {
  return new Map(
    flags.map((f) => [f.feature.name, { id: f.feature.id, enabled: f.enabled, value: f.feature_state_value }]),
  );
}
