import { createHandler, getQuery, forbidden, badRequest } from '../../backend/lib/http.js';
import { timingSafeEqual } from '../../backend/lib/auth.js';
import { APP, CATEGORIES, CRON } from '../../backend/lib/config.js';
import {
  refreshDueCategories,
  refreshCategory,
  poolStatus,
} from '../../backend/services/contentPipeline.js';

/**
 * GET /api/cron/refresh
 *
 * The scheduled entry point for content generation. Vercel Cron calls this with
 * an `Authorization: Bearer $CRON_SECRET` header (see vercel.json). Each
 * category decides for itself whether it is due, using the freshness policy in
 * config.js.
 *
 * Query params:
 *   ?category=<name>  refresh one named category
 *   ?force=1          ignore the freshness window
 *
 * This is the most expensive endpoint in the app — every call can mean an
 * upstream fetch and a paid model request — so it refuses anything it cannot
 * positively authenticate.
 */

/**
 * Authenticates the caller against CRON_SECRET.
 *
 * There is deliberately no unauthenticated path. A previous version trusted the
 * `x-vercel-cron` request header when no secret was configured, but a request
 * header is attacker-controlled: anyone who could guess the URL could set that
 * header and spend the project's model budget. If the secret is missing the
 * endpoint is closed, and the deployment checklist calls that out.
 */
export function authorizeCronRequest(req) {
  if (!APP.cronSecret) {
    console.error('[cron] refused: CRON_SECRET is not configured on this deployment.');
    throw forbidden(
      'Scheduled refresh is disabled because CRON_SECRET is not set on this deployment.',
    );
  }

  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : req.headers['x-cron-secret'];

  if (!provided || !timingSafeEqual(provided, APP.cronSecret)) {
    console.warn('[cron] refused: invalid credentials.');
    throw forbidden('Invalid cron credentials.');
  }
}

export default createHandler({
  async GET(req) {
    authorizeCronRequest(req);

    const q = getQuery(req);
    const force = q.force === '1' || q.force === 'true';
    const startedAt = Date.now();

    if (q.category !== undefined && !CATEGORIES.includes(q.category)) {
      throw badRequest(`category must be one of: ${CATEGORIES.join(', ')}.`);
    }

    // Every run is serialised per category by a Postgres advisory lock and every
    // question is deduplicated on its fingerprint, so an overlapping or repeated
    // call cannot double-generate: the second one either skips or inserts
    // nothing. That is what makes a retrying scheduler safe here.
    const results = q.category
      ? [await refreshCategory(q.category, { force })]
      : await refreshDueCategories({ force, limit: CRON.categoriesPerRun });

    const pools = await Promise.all(CATEGORIES.map((c) => poolStatus(c)));
    const durationMs = Date.now() - startedAt;

    // One structured line per run: what ran, what it produced, and what failed.
    // This is what you read in the Vercel logs when the bank stops growing.
    const failed = results.filter((r) => r?.error);
    console[failed.length ? 'error' : 'log'](
      '[cron] refresh ' +
        JSON.stringify({
          durationMs,
          forced: force,
          ran: results
            .filter((r) => r && !r.skipped && !r.error)
            .map((r) => ({ category: r.category, accepted: r.accepted, rejected: r.rejected })),
          skipped: results.filter((r) => r?.skipped).map((r) => `${r.category}:${r.reason}`),
          failed: failed.map((r) => `${r.category}: ${r.error}`),
          pools: Object.fromEntries(pools.map((p) => [p.category, p.total])),
        }),
    );

    return { ranAt: new Date().toISOString(), durationMs, results, pools };
  },
});
