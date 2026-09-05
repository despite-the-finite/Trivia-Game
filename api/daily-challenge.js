import {
  createHandler,
  getQuery,
  readJsonBody,
  badRequest,
  withStatus,
  publicBaseUrl,
} from '../backend/lib/http.js';
import { requirePlayer, optionalPlayer } from '../backend/lib/auth.js';
import {
  getDailyStatus,
  startDaily,
  todayUtc,
} from '../backend/services/dailyChallengeService.js';
import { getDailyLeaderboard } from '../backend/services/leaderboardService.js';

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * /api/daily-challenge
 *
 *   GET  /api/daily-challenge                       today's status for the caller
 *   GET  /api/daily-challenge?view=leaderboard      today's board (scope=global|friends)
 *   POST /api/daily-challenge                       start (or resume) today's attempt
 *
 * Everyone gets the same ~10 questions for a given UTC day, in the same order,
 * with the same answer placement. It is scored once per player.
 */
export default createHandler({
  async GET(req) {
    const q = getQuery(req);
    const day = isDay(q.day) ? q.day : todayUtc();

    if (q.view === 'leaderboard') {
      const viewer = await optionalPlayer(req);
      const scope = q.scope === 'friends' ? 'friends' : 'global';
      if (scope === 'friends' && !viewer) {
        throw badRequest('A player token is required for the friends board.');
      }
      return {
        day,
        scope,
        entries: await getDailyLeaderboard({
          day,
          scope,
          viewerId: viewer?.id ?? null,
          limit: q.limit,
        }),
      };
    }

    const viewer = await optionalPlayer(req);
    return getDailyStatus(viewer, day, { baseUrl: publicBaseUrl(req) });
  },

  async POST(req) {
    const player = await requirePlayer(req);
    await readJsonBody(req);
    return withStatus(201, await startDaily(player));
  },
});
