import { createHandler, getQuery } from '../backend/lib/http.js';
import { optionalPlayer } from '../backend/lib/auth.js';
import { getDayLeaderboard, parseHistoryDay, recentUtcDays } from '../backend/services/leaderboardService.js';

/**
 * GET /api/leaderboard?day=YYYY-MM-DD&limit=
 *
 * The permanent home-screen leaderboard: the top players for one UTC
 * calendar day (points earned that day), each broken out by category.
 * `day` defaults to today and must be one of the last few retained days
 * (see `availableDays` in the response, or `HISTORY_DAYS`) — this is a
 * short rolling window for browsing recent days, not an all-time archive.
 * If the caller is signed in and falls outside the top slice, their own row
 * is returned separately (`viewerRow`) with their real rank.
 */
export default createHandler({
  async GET(req) {
    const viewer = await optionalPlayer(req);
    const q = getQuery(req);
    const day = parseHistoryDay(q.day);
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '10', 10) || 10, 1), 50);

    const board = await getDayLeaderboard({ day, viewerId: viewer?.id ?? null, limit });
    return { ...board, availableDays: recentUtcDays() };
  },
});
