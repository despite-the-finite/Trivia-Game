import { createHandler, getQuery, badRequest } from '../backend/lib/http.js';
import { isAdminRequest } from '../backend/lib/auth.js';
import { PLAYABLE_CATEGORIES, DIFFICULTIES } from '../backend/lib/config.js';
import {
  pickBalancedSet,
  buildAnswerOrders,
  toPlayShape,
  toFullShape,
} from '../backend/services/questionService.js';
import { poolStatus, needsRefresh, refreshInBackground } from '../backend/services/contentPipeline.js';

/**
 * GET /api/trivia?category=&difficulty=&count=
 *
 * Reads from the cached, validated question bank. This never calls an upstream
 * API or the LLM inline — the content pipeline fills the bank on a schedule and
 * this endpoint just serves from it.
 *
 * Two response shapes:
 *   * Default (browser): the play shape — no correct answer. Exposing the
 *     answer here would defeat the whole server-authoritative scoring model.
 *   * With a valid `X-Admin-Key` header: the full record including
 *     correctAnswer, explanation and provenance, for server-to-server use,
 *     content review and testing.
 *
 * Answer ordering is randomised on every request.
 */
export default createHandler({
  async GET(req) {
    const q = getQuery(req);

    const category = (q.category ?? 'mixed').toLowerCase();
    if (!PLAYABLE_CATEGORIES.includes(category)) {
      throw badRequest(`category must be one of: ${PLAYABLE_CATEGORIES.join(', ')}.`);
    }

    let difficulty = null;
    if (q.difficulty && q.difficulty !== 'any') {
      difficulty = String(q.difficulty).toLowerCase();
      if (!DIFFICULTIES.includes(difficulty)) {
        throw badRequest(`difficulty must be one of: ${DIFFICULTIES.join(', ')}.`);
      }
    }

    const count = Math.min(Math.max(Number.parseInt(q.count ?? '10', 10) || 10, 1), 50);

    const questions = await pickBalancedSet({ category, difficulty, count });
    const orders = buildAnswerOrders(questions);

    const includeAnswers = isAdminRequest(req);

    // Keep the bank topped up without making this request wait for it.
    const categories = category === 'mixed' ? PLAYABLE_CATEGORIES.filter((c) => c !== 'mixed') : [category];
    for (const cat of categories) {
      needsRefresh(cat)
        .then((stale) => stale && refreshInBackground(cat))
        .catch(() => {});
    }

    return {
      category,
      difficulty: difficulty ?? 'any',
      count: questions.length,
      requested: count,
      answersIncluded: includeAnswers,
      questions: questions.map((question, i) =>
        includeAnswers
          ? toFullShape(question, orders[question.id])
          : toPlayShape(question, orders[question.id], i),
      ),
      pools: await Promise.all(categories.map((cat) => poolStatus(cat))),
    };
  },
});
