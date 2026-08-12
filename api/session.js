import {
  createHandler,
  getQuery,
  readJsonBody,
  badRequest,
  withStatus,
} from '../backend/lib/http.js';
import { requirePlayer } from '../backend/lib/auth.js';
import { queryRows } from '../backend/db/index.js';
import { enforceRateLimit } from '../backend/lib/rateLimit.js';
import { isUuid } from '../backend/lib/ids.js';
import { LIMITS } from '../backend/lib/config.js';
import { getQuestionsByIds } from '../backend/services/questionService.js';
import {
  createSession,
  getSession,
  finishSession,
  getSessionReview,
  shapeSessionForPlay,
} from '../backend/services/sessionService.js';

/**
 * /api/session
 *
 *   POST /api/session                    start a quick-play run
 *   POST /api/session?action=finish      finalise and get the results summary
 *   GET  /api/session?id=<uuid>          resume an in-progress run
 *   GET  /api/session?id=<uuid>&view=review   per-question review (after finishing)
 *
 * A run is created with its full question list and answer ordering fixed, and
 * the browser receives every question up front — so moving between questions is
 * instant and there is no mid-game network stall.
 */
export default createHandler({
  async POST(req) {
    const player = await requirePlayer(req);
    const q = getQuery(req);
    const body = await readJsonBody(req);
    // A body carrying a sessionId can only mean "finish this run" — inferring it
    // avoids the trap where a missing `action` silently starts a whole new game.
    const inferred = body.sessionId ? 'finish' : 'start';
    const action = (q.action ?? body.action ?? inferred).toLowerCase();

    if (action === 'finish') {
      const sessionId = body.sessionId ?? q.id;
      if (!isUuid(sessionId)) throw badRequest('sessionId is required.');
      return finishSession(player, sessionId);
    }

    if (action !== 'start') {
      throw badRequest('Unknown action. Expected start or finish.');
    }

    await enforceRateLimit(`session:start:${player.id}`, { limit: LIMITS.sessionsPerHour, windowMs: 60 * 60 * 1000 });

    const playable = await createSession(player, {
      category: body.category,
      difficulty: body.difficulty,
      count: body.count,
    });
    return withStatus(201, playable);
  },

  async GET(req) {
    const player = await requirePlayer(req);
    const q = getQuery(req);
    if (!isUuid(q.id)) throw badRequest('id must be a session UUID.');

    if (q.view === 'review') {
      return { sessionId: q.id, questions: await getSessionReview(player, q.id) };
    }

    const session = await getSession(q.id, player.id);
    if (session.completed_at) {
      return finishSession(player, q.id);
    }

    const questions = await getQuestionsByIds(session.question_ids);
    const playable = shapeSessionForPlay(session, questions);

    // Tell the client which questions are already answered so a resumed run
    // picks up where it left off rather than re-asking.
    const answered = await queryRows(
      'SELECT question_id, correct, points FROM session_answers WHERE session_id = $1',
      [q.id],
    );

    return {
      ...playable,
      answered: answered.map((a) => ({
        questionId: a.question_id,
        correct: a.correct,
        points: a.points,
      })),
    };
  },
});
