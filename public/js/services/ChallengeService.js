import { api } from './ApiClient.js';

/**
 * ChallengeService — create, join and read head-to-head challenges.
 *
 * The server pins the question set and the answer placement when the challenge
 * is created, so both players genuinely take the same test. The client just
 * carries the slug around.
 */
export class ChallengeService {
  constructor(client = api) {
    this.api = client;
  }

  /** Reads a challenge slug out of the URL, e.g. /challenge/abc123xy. */
  static slugFromLocation(pathname = window.location.pathname) {
    const match = pathname.match(/^\/challenge\/([a-z0-9]{4,16})\/?$/i);
    return match ? match[1].toLowerCase() : null;
  }

  async create({ category = 'mixed', count } = {}) {
    return this.api.post('/challenge', { category, count });
  }

  async results(slug) {
    return this.api.get('/challenge', { slug });
  }

  async join(slug) {
    return this.api.post('/challenge', { slug }, { action: 'join' });
  }

  async mine() {
    const data = await this.api.get('/challenge', { view: 'mine' });
    return data.challenges;
  }
}

export const challengeService = new ChallengeService();
