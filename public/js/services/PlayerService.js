import { api } from './ApiClient.js';

/**
 * PlayerService — identity and stats.
 *
 * The whole account model from the client's point of view: a token in
 * localStorage. If it is there, we are signed in; if the server rejects it, we
 * fall back to onboarding.
 */
export class PlayerService {
  constructor(client = api) {
    this.api = client;
    this.player = null;
    this.stats = null;
  }

  get isSignedIn() {
    return Boolean(this.player);
  }

  /** Loads the current player from a stored token. Returns null when absent. */
  async restore() {
    if (!this.api.hasToken()) return null;
    try {
      const data = await this.api.get('/player');
      this.player = data.player;
      this.stats = data.stats;
      return this.player;
    } catch (err) {
      if (err.isAuthError) {
        // Token no longer valid — clear it and fall back to onboarding.
        this.api.setToken(null);
        return null;
      }
      throw err;
    }
  }

  async createAccount(displayName) {
    const data = await this.api.post('/player', { displayName });
    this.api.setToken(data.token);
    this.player = data.player;
    this.stats = data.stats;
    return this.player;
  }

  async restoreWithCode(code) {
    const data = await this.api.post('/player', { code }, { action: 'claim' });
    this.api.setToken(data.token);
    this.player = data.player;
    this.stats = data.stats;
    return this.player;
  }

  async rename(displayName) {
    const data = await this.api.patch('/player', { displayName });
    this.player = data.player;
    return this.player;
  }

  async requestRecoveryCode() {
    return this.api.post('/player', {}, { action: 'recovery-code' });
  }

  async refreshStats() {
    const data = await this.api.get('/player');
    this.player = data.player;
    this.stats = data.stats;
    return this.stats;
  }

  // --- Friends -----------------------------------------------------------

  async listFriends() {
    const data = await this.api.get('/friends');
    return data.friends;
  }

  async addFriend(friendCode) {
    const data = await this.api.post('/friends', { friendCode });
    return data;
  }

  async removeFriend(playerId) {
    const data = await this.api.delete('/friends', { id: playerId });
    return data.friends;
  }

  async getProfile(playerId) {
    return this.api.get('/player', { id: playerId });
  }
}

export const playerService = new PlayerService();
