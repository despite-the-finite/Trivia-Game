import { queryOne, withAdvisoryLock, lockKey } from '../db/index.js';
import { APP, GAME } from '../lib/config.js';
import { unavailable } from '../lib/http.js';
import { seededRandom } from '../lib/ids.js';
import { pickBalancedSet, buildAnswerOrders, getQuestionsByIds } from './questionService.js';
import { createFixedSession, shapeSessionForPlay } from './sessionService.js';

/**
 * dailyChallengeService — one fixed, shared question set per (UTC day, category).
 *
 * `category: 'mixed'` is the original global Daily Challenge; every other
 * category is that category's own daily quiz — this is what "Quick Play" now
 * means. The day's set is materialised once, on first request, and every
 * player gets exactly those questions in exactly that order. Answer placement
 * is derived from a seed of the date + category, so it is identical for
 * everyone and reproducible.
 *
 * A player may replay a day's quiz as many times as they like, but only the
 * first completed attempt is scored — later ones are marked `is_practice` and
 * excluded from stats/leaderboards (see sessionService).
 *
 * "Day" is UTC. A local-timezone daily would mean multiple concurrent boards
 * and a much messier "once per day" rule.
 */

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function materialiseDay(day, category) {
  const key = lockKey(`daily:${day}:${category}`);
  const { result } = await withAdvisoryLock(key, async () => {
    const existing = await queryOne('SELECT * FROM daily_challenges WHERE day = $1 AND category = $2', [
      day,
      category,
    ]);
    if (existing) {
      // Self-heal: if any question in the stored set has since disappeared, the
      // day's quiz would 409 for everyone until midnight. Rebuild instead.
      const available = await getQuestionsByIds(existing.question_ids);
      if (available.length === existing.question_ids.length) return existing;
      console.warn(`[dailyChallenge] rebuilding ${day}/${category}: ${existing.question_ids.length - available.length} question(s) missing`);
    }

    const questions = await pickBalancedSet({
      category,
      count: GAME.dailyQuestionCount,
    });
    if (questions.length < GAME.dailyQuestionCount) {
      throw unavailable("Today's quiz is still being prepared. Try again shortly.");
    }

    const rng = seededRandom(`daily:${day}:${category}`);
    const answerOrders = buildAnswerOrders(questions, rng);

    return queryOne(
      `INSERT INTO daily_challenges (day, category, question_ids, answer_orders)
            VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (day, category) DO UPDATE
            SET question_ids = EXCLUDED.question_ids,
                answer_orders = EXCLUDED.answer_orders
         RETURNING *`,
      [day, category, questions.map((q) => q.id), JSON.stringify(answerOrders)],
    );
  });

  if (result) return result;

  // Another instance held the lock; it will have written the row.
  const row = await queryOne('SELECT * FROM daily_challenges WHERE day = $1 AND category = $2', [
    day,
    category,
  ]);
  if (!row) throw unavailable("Today's quiz is still being prepared. Try again shortly.");
  return row;
}

export async function getDailyStatus(player, category = 'mixed', day = todayUtc()) {
  const daily = await materialiseDay(day, category);

  const attempt = player
    ? await queryOne(
        `SELECT id, total_score, correct_count, completed_at, started_at
           FROM game_sessions
          WHERE player_id = $1 AND mode = 'daily' AND daily_date = $2 AND category = $3
            AND is_practice = FALSE`,
        [player.id, day, category],
      )
    : null;

  const stats = await queryOne(
    `SELECT COUNT(*)::int AS players, COALESCE(ROUND(AVG(total_score)), 0)::int AS average_score
       FROM game_sessions
      WHERE mode = 'daily' AND daily_date = $1 AND category = $2
        AND is_practice = FALSE AND completed_at IS NOT NULL`,
    [day, category],
  );

  return {
    day,
    category,
    questionCount: daily.question_ids.length,
    played: Boolean(attempt?.completed_at),
    inProgress: Boolean(attempt && !attempt.completed_at),
    yourResult: attempt?.completed_at
      ? {
          sessionId: attempt.id,
          score: attempt.total_score,
          correct: attempt.correct_count,
          total: daily.question_ids.length,
          accuracy: Math.round((attempt.correct_count / daily.question_ids.length) * 1000) / 10,
          completedAt: attempt.completed_at,
        }
      : null,
    globalStats: { playersCompleted: stats.players, averageScore: stats.average_score },
    shareUrl: `${APP.publicUrl || ''}/daily`,
  };
}

/**
 * Starts today's quiz for `category`, or resumes an attempt already in
 * progress. Once the scored attempt is completed, further plays that day are
 * practice runs: scored for immediate feedback but never counted twice.
 */
export async function startDaily(player, category = 'mixed', day = todayUtc()) {
  const daily = await materialiseDay(day, category);

  const scored = await queryOne(
    `SELECT * FROM game_sessions
      WHERE player_id = $1 AND mode = 'daily' AND daily_date = $2 AND category = $3
        AND is_practice = FALSE`,
    [player.id, day, category],
  );

  if (scored && !scored.completed_at) {
    const questions = await getQuestionsByIds(scored.question_ids);
    return { ...shapeSessionForPlay(scored, questions), day };
  }

  if (!scored) {
    const playable = await createFixedSession(player, {
      mode: 'daily',
      questionIds: daily.question_ids,
      answerOrders: daily.answer_orders,
      category,
      dailyDate: day,
      isPractice: false,
    });
    return { ...playable, day };
  }

  // The scored attempt is done — resume an in-progress practice run if there
  // is one, otherwise start a fresh practice run of the same fixed set.
  const practice = await queryOne(
    `SELECT * FROM game_sessions
      WHERE player_id = $1 AND mode = 'daily' AND daily_date = $2 AND category = $3
        AND is_practice = TRUE AND completed_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [player.id, day, category],
  );

  if (practice) {
    const questions = await getQuestionsByIds(practice.question_ids);
    return { ...shapeSessionForPlay(practice, questions), day };
  }

  const playable = await createFixedSession(player, {
    mode: 'daily',
    questionIds: daily.question_ids,
    answerOrders: daily.answer_orders,
    category,
    dailyDate: day,
    isPractice: true,
  });
  return { ...playable, day };
}

export function buildDailyShareText({ score, correct, total, day, category = 'mixed' }) {
  const url = `${APP.publicUrl || ''}/daily`;
  const label = category === 'mixed' ? 'Daily Trivia Challenge' : `${category} quiz`;
  return `I scored ${score.toLocaleString('en-US')} on the ${day} ${label} (${correct}/${total} correct). Can you beat me?\n${url}`;
}
