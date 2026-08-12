import { createHandler, getQuery, readJsonBody, badRequest, withStatus } from '../backend/lib/http.js';
import { requirePlayer } from '../backend/lib/auth.js';
import { enforceRateLimit } from '../backend/lib/rateLimit.js';
import { isUuid } from '../backend/lib/ids.js';
import { LIMITS } from '../backend/lib/config.js';
import { listFriends, addFriendByCode, removeFriend } from '../backend/services/playerService.js';

/**
 * /api/friends
 *
 *   GET    /api/friends            your friends with their scoreboard stats
 *   POST   /api/friends            { friendCode } — add by code
 *   DELETE /api/friends?id=<uuid>  remove
 *
 * Adding is mutual and immediate: no invite/accept round trip, because the
 * friend code is already a shared secret the other player chose to hand out.
 */
export default createHandler({
  async GET(req) {
    const player = await requirePlayer(req);
    return {
      you: { id: player.id, displayName: player.display_name, friendCode: player.friend_code },
      friends: await listFriends(player.id),
    };
  },

  async POST(req) {
    const player = await requirePlayer(req);
    const body = await readJsonBody(req);

    // Rate limited because a friend code is short enough to be worth guessing.
    await enforceRateLimit(`friends:add:${player.id}`, { limit: LIMITS.friendAddsPerHour, windowMs: 60 * 60 * 1000 });

    const friend = await addFriendByCode(player.id, body.friendCode);
    return withStatus(201, { added: friend, friends: await listFriends(player.id) });
  },

  async DELETE(req) {
    const player = await requirePlayer(req);
    const q = getQuery(req);
    if (!isUuid(q.id)) throw badRequest('id must be a player UUID.');
    await removeFriend(player.id, q.id);
    return { removed: true, friends: await listFriends(player.id) };
  },
});
