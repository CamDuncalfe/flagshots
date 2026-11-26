// A small client for the Flagsmith Admin API (the REST API the dashboard uses).
// Flagshots needs only a handful of routes, so it calls them with fetch instead of pulling in an SDK.
// Every route here was checked against self-hosted Flagsmith 2.294.0.

export class FlagsmithAdmin {
  // apiUrl is the API root, for example http://localhost:8000/api/v1
  constructor(apiUrl, token = null) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Token ${this.token}`;
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

  // Finds an identity by its exact identifier, or creates it.
  // The ?q= search matches on part of the identifier, so the result is checked for an exact match.
  async identity(environmentKey, identifier) {
    const found = await this.list(
      `/environments/${environmentKey}/identities/?q=${encodeURIComponent(identifier)}`,
    );
    const existing = found.find((i) => i.identifier === identifier);
    return existing ?? this.request('POST', `/environments/${environmentKey}/identities/`, { identifier });
  }

  // Sets one identity's override for one feature. Flagsmith refuses a second override for the
  // same feature and identity, so an existing one is updated in place.
  async setIdentityOverride(environmentKey, identityId, featureId, { enabled, value }) {
    const base = `/environments/${environmentKey}/identities/${identityId}/featurestates/`;
    const body = { feature: featureId, enabled, feature_state_value: value ?? null };
    const existing = (await this.list(base)).find((s) => s.feature === featureId);
    if (existing) return this.request('PUT', `${base}${existing.id}/`, body);
    return this.request('POST', base, body);
  }

  // Asks Flagsmith for an identity's flags the way an app's SDK does, with the client-side
  // environment key and no admin token. Flagshots uses it to check each override took effect.
  async flagsForIdentity(environmentKey, identifier) {
    const res = await fetch(
      `${this.apiUrl}/identities/?identifier=${encodeURIComponent(identifier)}`,
      { headers: { 'X-Environment-Key': environmentKey } },
    );
    if (!res.ok) throw new Error(`Flagsmith answered ${res.status} for identity ${identifier}`);
    const data = await res.json();
    return new Map(data.flags.map((f) => [f.feature.name, { enabled: f.enabled, value: f.feature_state_value }]));
  }

  updateFeatureState(environmentKey, featureStateId, changes) {
    return this.request(
      'PATCH',
      `/environments/${environmentKey}/featurestates/${featureStateId}/`,
      changes,
    );
  }
}
