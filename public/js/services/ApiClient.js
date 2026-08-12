/**
 * ApiClient — the frontend's only route to the outside world.
 *
 * The browser talks to our backend and nothing else. No third-party APIs, no
 * model provider, no keys of any kind live here — the only credential the client
 * holds is its own player token, which the server issued.
 */

const TOKEN_KEY = 'live-trivia.token';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get isOffline() {
    return this.code === 'network_error';
  }
  get isAuthError() {
    return this.status === 401;
  }
}

export class ApiClient {
  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
    this.token = null;
    try {
      this.token = localStorage.getItem(TOKEN_KEY);
    } catch {
      // Private browsing with storage disabled: the session still works, it
      // just will not survive a reload.
    }
  }

  setToken(token) {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  hasToken() {
    return Boolean(this.token);
  }

  async request(path, { method = 'GET', body, query, timeoutMs = 15000 } = {}) {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network failure, DNS failure, or the request timed out. This is the
      // case that drives the "needs an internet connection" screen.
      throw new ApiError(
        0,
        'network_error',
        err.name === 'AbortError'
          ? 'The connection timed out.'
          : 'Could not reach the trivia server.',
      );
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(
        response.status,
        error.code ?? 'http_error',
        error.message ?? `Request failed (${response.status}).`,
      );
    }

    return payload ?? {};
  }

  get(path, query, options) {
    return this.request(path, { ...options, method: 'GET', query });
  }
  post(path, body, query) {
    return this.request(path, { method: 'POST', body, query });
  }
  patch(path, body) {
    return this.request(path, { method: 'PATCH', body });
  }
  delete(path, query) {
    return this.request(path, { method: 'DELETE', query });
  }

  health() {
    return this.get('/health', undefined, { timeoutMs: 8000 });
  }
}

export const api = new ApiClient();
