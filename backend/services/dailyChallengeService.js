import { queryOne, queryRows, withAdvisoryLock, lockKey } from '../db/index.js';
import { APP, GAME } from '../lib/config.js';
import { conflict, unavailable } from '../lib/http.js';
import { seededRandom } from '../lib/ids.js';
import { pickBalancedSet, buildAnswerOrders, getQuestionsByIds } from './questionService.js';
import { createFixedSession, shapeSessionForPlay } from './sessionService.js';

/**
 * dailyChallengeService — one global set of questions per calendar day.
 *
 * The day's set is materialised once, on first request, and every player gets
 * exactly those questions in exactly that order. Answer placement is derived
 * from a seed of the date, so it is identical for everyone and reproducible.
 *
 * "Day" is UTC. A local-timezone daily would mean multiple concurrent boards
 * and a much messier "once per day" rule.
 */

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function materialiseDay(day) {
  const key = lockKey(`daily:${day}`);
  const { result } = await withAdvisoryLock(key, async () => {
    const existing = await queryOne('SELECT * FROM daily_challenges WHERE day = $1', [day]);
    if (existing) {
      // Self-heal: if any question in the stored set has since disappeared, the
      // day's challenge would 409 for everyone until midnight. Rebuild instead.
      const available = await getQuestionsByIds(existing.question_ids);
      if (available.length === existing.question_ids.length) return existing;
      console.warn(`[dailyChallenge] rebuilding ${day}: ${existing.question_ids.length - available.length} question(s) missing`);
    }

    const questions = await pickBalancedSet({
      category: 'mixed',
      difficulty: null,
      count: GAME.dailyQuestionCount,
    });
    if (questions.length < GAME.dailyQuestionCount) {
      throw unavailable("Today's challenge is still being prepared. Try again shortly.");
    }

    const rng = seededRandom(`daily:${day}`);
    const answerOrders = buildAnswerOrders(questions, rng);

    return queryOne(
      `INSERT INTO daily_challenges (day, question_ids, answer_orders)
            VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (day) DO UPDATE
            SET question_ids = EXCLUDED.question_ids,
                answer_orders = EXCLUDED.answer_orders
         RETURNING *`,
      [day, questions.map((q) => q.id), JSON.stringify(answerOrders)],
    );
  });

  if (result) return result;

  // Another instance held the lock; it will have written the row.
  const row = await queryOne('SELECT * FROM daily_challenges WHERE day = $1', [day]);
  if (!row) throw unavailable("Today's challenge is still being prepared. Try again shortly.");
  return row;
}

export async function getDailyStatus(player, day = todayUtc()) {
  const daily = await materialiseDay(day);

  const attempt = player
    ? await queryOne(
        `SELECT id, total_score, correct_count, completed_at, started_at
           FROM game_sessions
          WHERE player_id = $1 AND mode = 'daily' AND daily_date = $2`,
        [player.id, day],
      )
    : null;

  const stats = await queryOne(
    `SELECT COUNT(*)::int AS players, COALESCE(ROUND(AVG(total_score)), 0)::int AS average_score
       FROM game_sessions
      WHERE mode = 'daily' AND daily_date = $1 AND completed_at IS NOT NULL`,
    [day],
  );

  return {
    day,
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
 * Starts today's challenge, or resumes an attempt already in progress.
 * A completed attempt cannot be replayed for score — that is enforced here and
 * by a partial unique index on (player_id, daily_date).
 */
export async function startDaily(player, day = todayUtc()) {
  const daily = await materialiseDay(day);

  const existing = await queryOne(
    `SELECT * FROM game_sessions
      WHERE player_id = $1 AND mode = 'daily' AND daily_date = $2`,
    [player.id, day],
  );

  if (existing?.completed_at) {
    throw conflict("You've already played today's Daily Challenge. Come back tomorrow.");
  }

  if (existing) {
    const questions = await getQuestionsByIds(existing.question_ids);
    return { ...shapeSessionForPlay(existing, questions), day };
  }

  const playable = await createFixedSession(player, {
    mode: 'daily',
    questionIds: daily.question_ids,
    answerOrders: daily.answer_orders,
    category: 'mixed',
    difficulty: null,
    dailyDate: day,
  });

  return { ...playable, day };
}

export function buildDailyShareText({ score, correct, total, day }) {
  const url = `${APP.publicUrl || ''}/daily`;
  return `I scored ${score.toLocaleString('en-US')} on the ${day} Daily Trivia Challenge (${correct}/${total} correct). Can you beat me?\n${url}`;
}
