import {
  createHandler,
  getQuery,
  readJsonBody,
  badRequest,
  withStatus,
  publicBaseUrl,
} from '../backend/lib/http.js';
import { requirePlayer, optionalPlayer } from '../backend/lib/auth.js';
import { enforceRateLimit } from '../backend/lib/rateLimit.js';
import { LIMITS } from '../backend/lib/config.js';
import {
  createChallenge,
  joinChallenge,
  getChallengeResults,
  listChallengesForPlayer,
} from '../backend/services/challengeService.js';

/**
 * /api/challenge
 *
 *   POST /api/challenge                    create a challenge, returns a share URL
 *   POST /api/challenge?action=join        { slug } — start your attempt
 *   GET  /api/challenge?slug=<slug>        results / status for a challenge
 *   GET  /api/challenge?view=mine          your recent challenges
 *
 * A challenge freezes both the question set and the answer placement, so the
 * challenger and the opponent are measured on exactly the same test.
 */
export default createHandler({
  async POST(req) {
    const player = await requirePlayer(req);
    const q = getQuery(req);
    const body = await readJsonBody(req);
    const action = (q.action ?? body.action ?? 'create').toLowerCase();

    if (action === 'join') {
      const slug = body.slug ?? q.slug;
      if (!slug) throw badRequest('slug is required.');
      return joinChallenge({ ...player, displayName: player.display_name }, slug, {
        baseUrl: publicBaseUrl(req),
      });
    }

    if (action !== 'create') throw badRequest('Unknown action. Expected create or join.');

    await enforceRateLimit(`challenge:create:${player.id}`, { limit: LIMITS.challengesPerHour, windowMs: 60 * 60 * 1000 });

    const created = await createChallenge(
      { ...player, displayName: player.display_name },
      {
        category: body.category,
        difficulty: body.difficulty,
        count: body.count,
        baseUrl: publicBaseUrl(req),
      },
    );
    return withStatus(201, created);
  },

  async GET(req) {
    const q = getQuery(req);

    if (q.view === 'mine') {
      const player = await requirePlayer(req);
      return { challenges: await listChallengesForPlayer(player.id, { baseUrl: publicBaseUrl(req) }) };
    }

    if (!q.slug) throw badRequest('slug is required.');
    const viewer = await optionalPlayer(req);
    return getChallengeResults(q.slug, viewer?.id ?? null, { baseUrl: publicBaseUrl(req) });
  },
});
