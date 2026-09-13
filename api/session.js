import { createHandler, getQuery, readJsonBody, badRequest } from '../backend/lib/http.js';
import { requirePlayer } from '../backend/lib/auth.js';
import { queryRows } from '../backend/db/index.js';
import { isUuid } from '../backend/lib/ids.js';
import { getQuestionsByIds } from '../backend/services/questionService.js';
import {
  getSession,
  finishSession,
  getSessionReview,
  shapeSessionForPlay,
} from '../backend/services/sessionService.js';

/**
 * /api/session
 *
 *   POST /api/session                    finalise and get the results summary
 *   GET  /api/session?id=<uuid>          resume an in-progress run
 *   GET  /api/session?id=<uuid>&view=review   per-question review (after finishing)
 *
 * Sessions are created elsewhere — by a category's daily quiz
 * (dailyChallengeService) or by a challenge (challengeService) — and always
 * arrive with their full question list and answer ordering fixed, so moving
 * between questions is instant and there is no mid-game network stall. This
 * endpoint only finishes, resumes and reviews them.
 */
export default createHandler({
  async POST(req) {
    const player = await requirePlayer(req);
    const q = getQuery(req);
    const body = await readJsonBody(req);

    const sessionId = body.sessionId ?? q.id;
    if (!isUuid(sessionId)) throw badRequest('sessionId is required.');
    return finishSession(player, sessionId);
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
