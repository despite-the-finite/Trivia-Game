import { queryOne, queryRows, withTransaction } from '../db/index.js';
import { GAME, PLAYABLE_CATEGORIES } from '../lib/config.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/http.js';
import { isUuid } from '../lib/ids.js';
import { getQuestionsByIds, toPlayShape, toRevealShape, markServed } from './questionService.js';
import { scoreAnswer, reconcileResponseTime, scoringRules } from './scoringService.js';
import { applyAnswerToStats, applyGameCompletion } from './playerService.js';

/**
 * sessionService — owns a run of questions from start to results.
 *
 * A session pins its question ids and its answer ordering at creation time.
 * That is what makes a challenge fair (both players get an identical set in an
 * identical order) and what makes answer validation possible without trusting
 * anything the client sends beyond a question id and a chosen position.
 */

export function normalizeCategory(value) {
  if (value === undefined || value === null || value === '') return 'mixed';
  const v = String(value).toLowerCase();
  if (!PLAYABLE_CATEGORIES.includes(v)) {
    throw badRequest(`Unknown category. Expected one of: ${PLAYABLE_CATEGORIES.join(', ')}.`);
  }
  return v;
}

export function normalizeCount(value, fallback = GAME.defaultQuestionCount) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw badRequest('count must be a positive integer.');
  return Math.min(n, GAME.maxQuestionCount);
}

/**
 * Creates a session bound to a fixed question set — used by challenges and by
 * every category's daily quiz, where the ordering must match for everyone.
 */
export async function createFixedSession(player, { mode, questionIds, answerOrders, category, challengeId = null, dailyDate = null, isPractice = false }) {
  const questions = await getQuestionsByIds(questionIds);
  if (questions.length !== questionIds.length) {
    throw conflict('Some questions in this set are no longer available.');
  }

  const session = await queryOne(
    `INSERT INTO game_sessions
       (player_id, mode, category, question_ids, answer_orders, challenge_id, daily_date, is_practice, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, NOW() + ($9 || ' milliseconds')::interval)
     RETURNING *`,
    [
      player.id,
      mode,
      category,
      questionIds,
      JSON.stringify(answerOrders),
      challengeId,
      dailyDate,
      isPractice,
      String(GAME.sessionTtlMs),
    ],
  );

  markServed(questionIds);
  return shapeSessionForPlay(session, questions);
}

export function shapeSessionForPlay(session, questions) {
  const orders = session.answer_orders ?? {};
  const byId = new Map(questions.map((q) => [q.id, q]));
  return {
    session: {
      id: session.id,
      mode: session.mode,
      category: session.category,
      isPractice: session.is_practice,
      challengeId: session.challenge_id,
      dailyDate: session.daily_date,
      questionCount: session.question_ids.length,
      startedAt: session.started_at,
      expiresAt: session.expires_at,
    },
    // The whole run is delivered up front so the next question renders
    // instantly — no per-question round trip, no visible loading between cards.
    questions: session.question_ids
      .map((id, position) => {
        const q = byId.get(id);
        return q ? toPlayShape(q, orders[id], position) : null;
      })
      .filter(Boolean),
    scoring: scoringRules(),
  };
}

export async function getSession(sessionId, playerId) {
  if (!isUuid(sessionId)) throw badRequest('Invalid session id.');
  const session = await queryOne('SELECT * FROM game_sessions WHERE id = $1', [sessionId]);
  if (!session) throw notFound('Session not found.');
  if (session.player_id !== playerId) throw forbidden('That session belongs to another player.');
  return session;
}

/**
 * Records an answer.
 *
 * Everything that matters is derived server-side: whether it was correct, how
 * long it actually took, and how many points it is worth. The client's only
 * inputs are which question and which displayed option.
 */
export async function submitAnswer(player, { sessionId, questionId, selectedIndex, responseMs }) {
  if (!isUuid(questionId)) throw badRequest('Invalid question id.');

  const session = await getSession(sessionId, player.id);
  if (session.completed_at) throw conflict('This game is already finished.');
  if (new Date(session.expires_at) < new Date()) {
    throw conflict('This game has expired. Start a new one.');
  }

  const position = session.question_ids.indexOf(questionId);
  if (position === -1) throw badRequest('That question is not part of this game.');

  const question = await queryOne(
    `SELECT id, category, question, answers, correct_index, explanation,
            source, source_url, source_published_at
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!question) throw notFound('Question not found.');

  const order = session.answer_orders?.[questionId] ?? question.answers.map((_, i) => i);

  // A null selection means the timer ran out — a legitimate, scoreable event.
  let canonicalIndex = null;
  if (selectedIndex !== null && selectedIndex !== undefined) {
    const idx = Number.parseInt(selectedIndex, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= order.length) {
      throw badRequest('selectedAnswer is out of range for this question.');
    }
    canonicalIndex = order[idx];
  }

  const correct = canonicalIndex !== null && canonicalIndex === question.correct_index;

  // Server-side elapsed time: measured from when the run started, minus the
  // time already accounted for by previously answered questions.
  const priorMs = await queryOne(
    'SELECT COALESCE(SUM(response_ms), 0)::int AS spent, COUNT(*)::int AS answered FROM session_answers WHERE session_id = $1',
    [sessionId],
  );
  const wallClockMs = Date.now() - new Date(session.started_at).valueOf();
  const serverElapsedMs = Math.max(0, wallClockMs - priorMs.spent);

  const timing = reconcileResponseTime({
    clientMs: Number(responseMs),
    serverElapsedMs,
  });

  // Practice replays don't touch the player's global streak, so their in-game
  // streak is built from this session's own answers instead.
  const currentStreak = session.is_practice
    ? (
        await queryOne(
          'SELECT streak_after FROM session_answers WHERE session_id = $1 ORDER BY position DESC LIMIT 1',
          [sessionId],
        )
      )?.streak_after ?? 0
    : (await queryOne('SELECT current_streak FROM player_stats WHERE player_id = $1', [player.id]))
        ?.current_streak ?? 0;

  const result = scoreAnswer({
    correct,
    responseMs: timing.responseMs,
    currentStreak,
    flags: timing.flags,
  });

  try {
    await withTransaction(async (client) => {
      // The UNIQUE (session_id, question_id) constraint is the real defence
      // against replaying a question: a second submission simply cannot insert.
      await client.query(
        `INSERT INTO session_answers
           (session_id, question_id, position, selected_index, correct, points, response_ms, streak_after, flagged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          sessionId,
          questionId,
          position,
          canonicalIndex,
          correct,
          result.points,
          timing.responseMs,
          result.newStreak,
          result.flags.length ? result.flags.join(',') : null,
        ],
      );

      await client.query(
        `UPDATE game_sessions
            SET total_score = total_score + $2,
                correct_count = correct_count + $3,
                best_streak = GREATEST(best_streak, $4)
          WHERE id = $1`,
        [sessionId, result.points, correct ? 1 : 0, result.newStreak],
      );

      if (!session.is_practice) {
        await client.query(
          `INSERT INTO score_events (player_id, session_id, category, points, correct, response_ms)
                VALUES ($1,$2,$3,$4,$5,$6)`,
          [player.id, sessionId, question.category, result.points, correct, timing.responseMs],
        );

        await applyAnswerToStats(client, player.id, {
          correct,
          points: result.points,
          category: question.category,
          responseMs: timing.responseMs,
          newStreak: result.newStreak,
        });
      }

      await client.query(
        `UPDATE questions
            SET times_answered = times_answered + 1,
                times_correct = times_correct + $2
          WHERE id = $1`,
        [questionId, correct ? 1 : 0],
      );
    });
  } catch (err) {
    if (err.code === '23505') {
      throw conflict('You have already answered that question in this game.');
    }
    throw err;
  }

  const reveal = toRevealShape(question, order);

  return {
    correct,
    pointsEarned: result.points,
    basePoints: result.basePoints,
    speedBonus: result.speedBonus,
    streakMultiplier: result.streakMultiplier,
    streakLabel: result.streakLabel,
    streak: result.newStreak,
    responseMs: timing.responseMs,
    correctIndex: reveal.correctIndex,
    correctAnswer: reveal.correctAnswer,
    explanation: reveal.explanation,
    source: reveal.source,
    sourceUrl: reveal.sourceUrl,
    sourcePublishedAt: reveal.sourcePublishedAt,
    answered: priorMs.answered + 1,
    questionCount: session.question_ids.length,
    isPractice: session.is_practice,
  };
}

/**
 * Finalises a run and returns the end-of-game summary, including where the
 * player landed among their friends this week.
 */
export async function finishSession(player, sessionId) {
  const session = await getSession(sessionId, player.id);

  const answers = await queryRows(
    `SELECT question_id, correct, points, response_ms, streak_after, position
       FROM session_answers WHERE session_id = $1 ORDER BY position`,
    [sessionId],
  );

  if (!session.completed_at) {
    const totalScore = answers.reduce((sum, a) => sum + a.points, 0);
    const correctCount = answers.filter((a) => a.correct).length;
    const accuracy = answers.length ? Math.round((correctCount / answers.length) * 1000) / 10 : 0;
    const bestStreak = answers.reduce((max, a) => Math.max(max, a.streak_after), 0);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE game_sessions
            SET completed_at = NOW(), total_score = $2, correct_count = $3, best_streak = $4
          WHERE id = $1 AND completed_at IS NULL`,
        [sessionId, totalScore, correctCount, bestStreak],
      );

      if (!session.is_practice) {
        await applyGameCompletion(client, player.id, {
          score: totalScore,
          accuracy,
          isDaily: session.mode === 'daily',
        });
      }

      if (session.challenge_id) {
        await client.query(
          `UPDATE challenge_participants
              SET score = $3, correct_count = $4,
                  total_response_ms = $5, completed_at = NOW(), session_id = $2
            WHERE challenge_id = $1 AND player_id = $6`,
          [
            session.challenge_id,
            sessionId,
            totalScore,
            correctCount,
            answers.reduce((sum, a) => sum + a.response_ms, 0),
            player.id,
          ],
        );
      }
    });

    session.completed_at = new Date();
    session.total_score = totalScore;
    session.correct_count = correctCount;
    session.best_streak = bestStreak;
  }

  return buildSummary(player, session, answers);
}

async function buildSummary(player, session, answers) {
  const totalResponseMs = answers.reduce((sum, a) => sum + a.response_ms, 0);
  const accuracy = answers.length
    ? Math.round((answers.filter((a) => a.correct).length / answers.length) * 1000) / 10
    : 0;

  const comparison = await friendComparison(player.id);

  return {
    session: {
      id: session.id,
      mode: session.mode,
      category: session.category,
      isPractice: session.is_practice,
      challengeId: session.challenge_id,
      dailyDate: session.daily_date,
      completedAt: session.completed_at,
    },
    result: {
      score: session.total_score,
      correct: session.correct_count,
      total: session.question_ids.length,
      answered: answers.length,
      accuracy,
      bestStreak: session.best_streak,
      averageResponseMs: answers.length ? Math.round(totalResponseMs / answers.length) : 0,
      totalResponseMs,
    },
    comparison,
  };
}

/**
 * "#2 among your friends this week / Alex is 320 points ahead of you".
 * Returns null when the player has no friends yet, so the UI can hide the row.
 */
export async function friendComparison(playerId) {
  const rows = await queryRows(
    `WITH circle AS (
        SELECT friend_id AS id FROM friendships WHERE player_id = $1
        UNION SELECT $1
     )
     SELECT p.id, p.display_name,
            COALESCE(SUM(e.points) FILTER (WHERE e.created_at >= date_trunc('week', NOW())), 0)::int AS weekly
       FROM circle c
       JOIN players p ON p.id = c.id
       LEFT JOIN score_events e ON e.player_id = p.id
      GROUP BY p.id, p.display_name
      ORDER BY weekly DESC, p.display_name ASC`,
    [playerId],
  );

  if (rows.length <= 1) return null;

  const index = rows.findIndex((r) => r.id === playerId);
  const me = rows[index];
  const ahead = index > 0 ? rows[index - 1] : null;

  return {
    scope: 'friends',
    period: 'week',
    rank: index + 1,
    of: rows.length,
    weeklyScore: me.weekly,
    playerAhead: ahead
      ? { displayName: ahead.display_name, weeklyScore: ahead.weekly, gap: ahead.weekly - me.weekly }
      : null,
  };
}

/** Full per-question review, only available once the run is finished. */
export async function getSessionReview(player, sessionId) {
  const session = await getSession(sessionId, player.id);
  if (!session.completed_at) throw conflict('Finish the game before reviewing it.');

  const rows = await queryRows(
    `SELECT a.position, a.selected_index, a.correct, a.points, a.response_ms,
            q.id, q.question, q.answers, q.correct_index, q.explanation,
            q.source, q.source_url, q.category
       FROM session_answers a
       JOIN questions q ON q.id = a.question_id
      WHERE a.session_id = $1
      ORDER BY a.position`,
    [sessionId],
  );

  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    category: r.category,
    question: r.question,
    yourAnswer: r.selected_index === null ? null : r.answers[r.selected_index],
    correctAnswer: r.answers[r.correct_index],
    correct: r.correct,
    points: r.points,
    responseMs: r.response_ms,
    explanation: r.explanation,
    source: r.source,
    sourceUrl: r.source_url,
  }));
}
