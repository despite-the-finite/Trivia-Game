import { createHandler, getQuery } from '../backend/lib/http.js';
import { optionalPlayer } from '../backend/lib/auth.js';
import {
  getLeaderboard,
  parseLeaderboardParams,
  PERIODS,
  SCOPES,
  BOARDS,
} from '../backend/services/leaderboardService.js';

/**
 * GET /api/leaderboard?period=&scope=&board=&limit=
 *
 *   period : today | week | month | all      (default: week)
 *   scope  : global | friends                (default: friends)
 *   board  : overall | current-events | science | geography | general-knowledge | accuracy | streak
 *
 * The defaults match the product's default view — Friends, This Week, Overall.
 * `scope=friends` needs a player token; `scope=global` is open.
 */
export default createHandler({
  async GET(req) {
    const viewer = await optionalPlayer(req);
    const params = parseLeaderboardParams(getQuery(req));

    const board = await getLeaderboard({ ...params, viewerId: viewer?.id ?? null });

    return {
      ...board,
      options: { periods: PERIODS, scopes: SCOPES, boards: BOARDS },
      viewerId: viewer?.id ?? null,
    };
  },
});
