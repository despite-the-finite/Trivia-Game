import { api } from './ApiClient.js';

/**
 * LeaderboardService — the permanent home-screen leaderboard.
 *
 * One board per UTC calendar day: points earned that day, broken out by
 * category. The server returns the top slice plus the caller's own row when
 * they fall outside it, and the short list of days still available to browse
 * (a rolling history window, not an all-time archive).
 */
export class LeaderboardService {
  constructor(client = api) {
    this.api = client;
  }

  async load({ day, limit = 10 } = {}) {
    return this.api.get('/leaderboard', { day, limit });
  }
}

export const leaderboardService = new LeaderboardService();
