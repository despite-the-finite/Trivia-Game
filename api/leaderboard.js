import { createHandler, getQuery } from '../backend/lib/http.js';
import { optionalPlayer } from '../backend/lib/auth.js';
import { getOverallLeaderboard } from '../backend/services/leaderboardService.js';

/**
 * GET /api/leaderboard?limit=
 *
 * The permanent home-screen leaderboard: the top players by all-time overall
 * score, each broken out by category. If the caller is signed in and falls
 * outside the top slice, their own row is returned separately (`viewerRow`)
 * with their real rank.
 */
export default createHandler({
  async GET(req) {
    const viewer = await optionalPlayer(req);
    const q = getQuery(req);
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '10', 10) || 10, 1), 50);

    return getOverallLeaderboard({ viewerId: viewer?.id ?? null, limit });
  },
});
