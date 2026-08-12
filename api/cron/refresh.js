import { createHandler, getQuery, forbidden } from '../../backend/lib/http.js';
import { timingSafeEqual } from '../../backend/lib/auth.js';
import { APP, CATEGORIES } from '../../backend/lib/config.js';
import { refreshDueCategories, refreshCategory, poolStatus } from '../../backend/services/contentPipeline.js';

/**
 * GET /api/cron/refresh
 *
 * The scheduled entry point for content generation. Vercel Cron calls this with
 * the `Authorization: Bearer $CRON_SECRET` header (see vercel.json). Each
 * category decides for itself whether it is due, using the freshness policy in
 * config.js — current events roughly every 45 minutes, science every 6 hours,
 * geography monthly.
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
