/**
 * ApiClient — the frontend's only route to the outside world.
 *
 * The browser talks to our backend and nothing else. No third-party APIs, no
 * model provider, no keys of any kind live here — the only credential the client
 * holds is its own player token, which the server issued.
 *
 * It has one other mode. When no backend answers — the page opened from a static
 * host, from a file, or from a deployment whose API is down — `useLocal()` points
 * every call at an in-page implementation of the same routes instead of the
 * network (see LocalBackend). Nothing above this class knows the difference; the
 * services and screens issue the same calls and read the same shapes either way.
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
    /** Non-null once the client has fallen back to in-browser play. */
    this.local = null;
    try {
      this.token = localStorage.getItem(TOKEN_KEY);
    } catch {
      // Private browsing with storage disabled: the session still works, it
      // just will not survive a reload.
    }
  }

  /**
   * Routes every subsequent call to an in-page backend instead of the network.
   * One-way on purpose: a session that has started playing offline keeps its
   * local state rather than silently switching backends mid-game.
   */
  useLocal(backend) {
    this.local = backend;
    return this;
  }

  get isLocal() {
    return Boolean(this.local);
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
    if (this.local) return this.#requestLocal(path, { method, body, query });

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

  /** Local errors are re-thrown as ApiError so callers need no special case. */
  async #requestLocal(path, options) {
    try {
      return await this.local.request(path, options);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(err.status ?? 500, err.code ?? 'local_error', err.message);
    }
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
