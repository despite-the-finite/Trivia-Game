import { api } from './ApiClient.js';

/**
 * LeaderboardService — the permanent home-screen leaderboard.
 *
 * One board: all-time overall score, broken out by category. No scope or
 * period filters — the server always returns the top slice plus the caller's
 * own row when they fall outside it.
 */
export class LeaderboardService {
  constructor(client = api) {
    this.api = client;
  }

  async load({ limit = 10 } = {}) {
    return this.api.get('/leaderboard', { limit });
  }
}

export const leaderboardService = new LeaderboardService();
