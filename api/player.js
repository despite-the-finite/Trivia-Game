import {
  createHandler,
  getQuery,
  readJsonBody,
  badRequest,
  withStatus,
  clientIp,
} from '../backend/lib/http.js';
import { requirePlayer, optionalPlayer } from '../backend/lib/auth.js';
import { enforceRateLimit } from '../backend/lib/rateLimit.js';
import { isUuid } from '../backend/lib/ids.js';
import { LIMITS } from '../backend/lib/config.js';
import {
  createAnonymousPlayer,
  renamePlayer,
  getStats,
  issueRecoveryCode,
  claimWithRecoveryCode,
  getPublicProfile,
} from '../backend/services/playerService.js';

/**
 * /api/player
 *
 * Identity is deliberately one step: POST a display name, get a token back.
 * There is no signup form, no password and no email round trip.
 *
 *   POST   /api/player                       create an anonymous account
 *   POST   /api/player?action=recovery-code  issue a device-transfer code
 *   POST   /api/player?action=claim          redeem a device-transfer code
 *   GET    /api/player                       the caller's profile + stats
 *   GET    /api/player?id=<uuid>             another player's public profile
 *   PATCH  /api/player                       change display name
 */
export default createHandler({
  async GET(req) {
    const q = getQuery(req);
    if (q.id) {
      if (!isUuid(q.id)) throw badRequest('id must be a player UUID.');
      const viewer = await optionalPlayer(req);
      return getPublicProfile(q.id, viewer?.id ?? null);
    }

    const player = await requirePlayer(req);
    return {
      player: {
        id: player.id,
        displayName: player.display_name,
        friendCode: player.friend_code,
        isAnonymous: player.is_anonymous,
        createdAt: player.created_at,
      },
      stats: await getStats(player.id),
    };
  },

  async POST(req) {
    const q = getQuery(req);
    const body = await readJsonBody(req);
    const action = (q.action ?? body.action ?? 'create').toLowerCase();

    if (action === 'create') {
      await enforceRateLimit(`player:create:${clientIp(req)}`, {
        limit: LIMITS.playerCreatePerHourPerIp,
        windowMs: 60 * 60 * 1000,
      });
      const { player, token } = await createAnonymousPlayer(body.displayName);
      return withStatus(201, {
        player,
        // The only time the raw token is ever transmitted. The client stores it;
        // the server keeps only its hash.
        token,
        stats: await getStats(player.id),
      });
    }

    if (action === 'recovery-code') {
      const player = await requirePlayer(req);
      await enforceRateLimit(`player:recovery:${player.id}`, { limit: LIMITS.recoveryCodesPerHour, windowMs: 60 * 60 * 1000 });
      return issueRecoveryCode(player.id);
    }

    if (action === 'claim') {
      await enforceRateLimit(`player:claim:${clientIp(req)}`, {
        limit: LIMITS.playerCreatePerHourPerIp,
        windowMs: 60 * 60 * 1000,
      });
      const { player, token } = await claimWithRecoveryCode(body.code);
      return { player, token, stats: await getStats(player.id) };
    }

    throw badRequest('Unknown action. Expected create, recovery-code or claim.');
  },

  async PATCH(req) {
    const player = await requirePlayer(req);
    const body = await readJsonBody(req);
    const updated = await renamePlayer(player.id, body.displayName);
    return { player: updated };
  },
});
