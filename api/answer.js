import { createHandler, readJsonBody, badRequest } from '../backend/lib/http.js';
import { requirePlayer } from '../backend/lib/auth.js';
import { enforceRateLimit } from '../backend/lib/rateLimit.js';
import { isUuid } from '../backend/lib/ids.js';
import { LIMITS } from '../backend/lib/config.js';
import { submitAnswer } from '../backend/services/sessionService.js';

/**
 * POST /api/answer
 *
 * Body: { sessionId, questionId, selectedAnswer, responseMs }
 *
 * `selectedAnswer` is the index of the option **as displayed to this player**;
 * the server maps it back through the session's stored permutation. The client
 * cannot submit a score, and the correct answer is only revealed in the
 * response to this call — never before.
 *
 * Guards applied here and in sessionService:
 *   * one answer per (session, question), enforced by a unique constraint
 *   * the question must belong to the session
 *   * the session must belong to the caller, be unfinished and unexpired
 *   * response time is reconciled against the server's own measurement
 *   * implausibly fast answers forfeit the speed bonus
 */
export default createHandler({
  async POST(req) {
    const player = await requirePlayer(req);
    const body = await readJsonBody(req);

    if (!isUuid(body.sessionId)) throw badRequest('sessionId is required.');
    if (!isUuid(body.questionId)) throw badRequest('questionId is required.');

    // Ten questions a game, a few seconds each — this ceiling only catches
    // scripted submission.
    await enforceRateLimit(`answer:${player.id}`, { limit: LIMITS.answersPerHour, windowMs: 60 * 60 * 1000 });

    const selectedAnswer =
      body.selectedAnswer === null || body.selectedAnswer === undefined
        ? null
        : body.selectedAnswer;

    return submitAnswer(player, {
      sessionId: body.sessionId,
      questionId: body.questionId,
      selectedIndex: selectedAnswer,
      responseMs: body.responseMs,
    });
  },
});
