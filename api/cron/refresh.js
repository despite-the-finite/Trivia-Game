import { createHandler, getQuery, forbidden } from '../../backend/lib/http.js';
import { timingSafeEqual } from '../../backend/lib/auth.js';
import { APP, CATEGORIES, GAME } from '../../backend/lib/config.js';
import { gameHourNow } from '../../backend/lib/day.js';
import { refreshDueCategories, refreshCategory, poolStatus } from '../../backend/services/contentPipeline.js';

/**
 * GET /api/cron/refresh
 *
 * The scheduled entry point for content generation, run at midnight in the game
 * timezone (Mountain time). Vercel Cron only speaks UTC, and Mountain midnight is
 * 06:00 UTC in summer but 07:00 UTC in winter, so vercel.json fires at both
 * times. The one at local midnight does the refresh; the one an hour later
 * (local 1am) is a retry — categories that refreshed are still fresh and skip,
 * so it only redoes one whose midnight run failed or was cut off by the
 * function time limit. Vercel Cron calls this with the `Authorization: Bearer $CRON_SECRET` header (see vercel.json).
 * Every category refreshes once every 24 hours, so a single daily trigger
 * covers all of them; each category still decides for itself whether it is due
 * using the freshness policy in config.js.
 *
 * Query params:
 *   ?category=<name>  refresh one category only
 *   ?force=1          ignore the freshness window
 */
function authorize(req) {
  if (!APP.cronSecret) {
    // Without a configured secret the endpoint is only reachable from Vercel's
    // own cron infrastructure; refuse otherwise rather than run unauthenticated.
    if (req.headers['x-vercel-cron']) return;
    throw forbidden('CRON_SECRET is not configured.');
  }
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-cron-secret'];
  if (!provided || !timingSafeEqual(provided, APP.cronSecret)) {
    throw forbidden('Invalid cron credentials.');
  }
}

export default createHandler({
  async GET(req) {
    authorize(req);
    const q = getQuery(req);
    const force = q.force === '1' || q.force === 'true';

    // A manual run (?force or ?category) always goes ahead; a scheduled one only
    // in the first two hours of the local day (midnight run + 1am retry).
    if (!force && !q.category && gameHourNow() > 1) {
      return { skipped: true, reason: `not the refresh window in ${GAME.timezone}`, ranAt: new Date().toISOString() };
    }

    const results =
      q.category && CATEGORIES.includes(q.category)
        ? [await refreshCategory(q.category, { force })]
        : await refreshDueCategories({ force });

    return {
      ranAt: new Date().toISOString(),
      results,
      pools: await Promise.all(CATEGORIES.map((c) => poolStatus(c))),
    };
  },
});
