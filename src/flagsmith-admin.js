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

  // The environment's own state for each feature: on or off, and the value.
  environmentFeatureStates(environmentKey) {
    return this.list(`/environments/${environmentKey}/featurestates/`);
  }

  updateFeatureState(environmentKey, featureStateId, changes) {
    return this.request(
      'PATCH',
      `/environments/${environmentKey}/featurestates/${featureStateId}/`,
      changes,
    );
  }
}
