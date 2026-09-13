import { createHandler, getQuery, readJsonBody, badRequest, withStatus } from '../backend/lib/http.js';
import { requirePlayer, optionalPlayer } from '../backend/lib/auth.js';
import { enforceRateLimit } from '../backend/lib/rateLimit.js';
import { PLAYABLE_CATEGORIES, LIMITS } from '../backend/lib/config.js';
import {
  getDailyStatus,
  startDaily,
  todayUtc,
} from '../backend/services/dailyChallengeService.js';
import { getDailyLeaderboard } from '../backend/services/leaderboardService.js';

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

function readCategory(value) {
  if (value === undefined || value === null || value === '') return 'mixed';
  const category = String(value).toLowerCase();
  if (!PLAYABLE_CATEGORIES.includes(category)) {
    throw badRequest(`category must be one of: ${PLAYABLE_CATEGORIES.join(', ')}.`);
  }
  return category;
}

/**
 * /api/daily-challenge
 *
 *   GET  /api/daily-challenge?category=            today's status for the caller
 *   GET  /api/daily-challenge?view=leaderboard      today's board (scope=global|friends)
 *   POST /api/daily-challenge                       start (or resume) today's attempt
 *
 * Every category (including 'mixed', the original Daily Challenge) gets the
 * same ~10 questions for a given UTC day, in the same order, with the same
 * answer placement. The first completed attempt per player is scored; further
 * plays that day are practice runs.
 */
export default createHandler({
  async GET(req) {
    const q = getQuery(req);
    const day = isDay(q.day) ? q.day : todayUtc();
    const category = readCategory(q.category);

    if (q.view === 'leaderboard') {
      const viewer = await optionalPlayer(req);
      const scope = q.scope === 'friends' ? 'friends' : 'global';
      if (scope === 'friends' && !viewer) {
        throw badRequest('A player token is required for the friends board.');
      }
      return {
        day,
        category,
        scope,
        entries: await getDailyLeaderboard({
          day,
          category,
          scope,
          viewerId: viewer?.id ?? null,
          limit: q.limit,
        }),
      };
    }

    const viewer = await optionalPlayer(req);
    return getDailyStatus(viewer, category, day);
  },

  async POST(req) {
    const player = await requirePlayer(req);
    const q = getQuery(req);
    const body = await readJsonBody(req);
    const category = readCategory(q.category ?? body.category);

    await enforceRateLimit(`daily:start:${player.id}`, {
      limit: LIMITS.sessionsPerHour,
      windowMs: 60 * 60 * 1000,
    });

    return withStatus(201, await startDaily(player, category));
  },
});
