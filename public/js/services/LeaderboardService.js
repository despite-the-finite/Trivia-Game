import { api } from './ApiClient.js';

/**
 * LeaderboardService — period × scope × board.
 *
 * The default view is the one the product leads with: Friends, This Week,
 * Overall score. Everything else is a filter change.
 */
export class LeaderboardService {
  constructor(client = api) {
    this.api = client;
    this.filters = { scope: 'friends', period: 'week', board: 'overall' };
    this.cache = new Map();
  }

  setFilter(key, value) {
    this.filters = { ...this.filters, [key]: value };
    return this.filters;
  }

  cacheKey(filters = this.filters) {
    return `${filters.scope}:${filters.period}:${filters.board}`;
  }

  async load({ force = false } = {}) {
    const key = this.cacheKey();
    const cached = this.cache.get(key);
    // Short TTL: boards move as people play, but not fast enough to justify
    // re-fetching on every filter toggle.
    if (!force && cached && Date.now() - cached.at < 20_000) return cached.data;

    const data = await this.api.get('/leaderboard', { ...this.filters, limit: 50 });
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  invalidate() {
    this.cache.clear();
  }
}

export const leaderboardService = new LeaderboardService();
