import { queryRows } from '../db/index.js';
import { badRequest } from '../lib/http.js';

/**
 * leaderboardService — period × scope × metric.
 *
 * Period boards are computed from the `score_events` ledger rather than from
 * cached counters, so "this week" always means this week and nothing has to be
 * reset on a schedule.
 */

export const PERIODS = ['today', 'week', 'month', 'all'];
export const SCOPES = ['global', 'friends'];
export const BOARDS = [
  'overall',
  'current-events',
  'science',
  'geography',
  'general-knowledge',
  'accuracy',
  'streak',
];

const PERIOD_SQL = {
  today: "e.created_at >= date_trunc('day', NOW())",
  week: "e.created_at >= date_trunc('week', NOW())",
  month: "e.created_at >= date_trunc('month', NOW())",
  all: 'TRUE',
};

export function parseLeaderboardParams(q = {}) {
  const period = (q.period ?? 'week').toLowerCase();
  const scope = (q.scope ?? 'friends').toLowerCase();
  const board = (q.board ?? q.category ?? 'overall').toLowerCase();
  const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '25', 10) || 25, 1), 100);

  if (!PERIODS.includes(period)) throw badRequest(`period must be one of: ${PERIODS.join(', ')}`);
  if (!SCOPES.includes(scope)) throw badRequest(`scope must be one of: ${SCOPES.join(', ')}`);
  if (!BOARDS.includes(board)) throw badRequest(`board must be one of: ${BOARDS.join(', ')}`);

  return { period, scope, board, limit };
}

/**
 * @param {object} opts
 * @param {string|null} opts.viewerId  Required for scope=friends.
 */
export async function getLeaderboard({ period, scope, board, limit, viewerId }) {
  if (scope === 'friends' && !viewerId) {
    throw badRequest('A player token is required for the friends leaderboard.');
  }

  const audience =
    scope === 'friends'
      ? `WITH audience AS (
           SELECT friend_id AS id FROM friendships WHERE player_id = $1
           UNION SELECT $1::uuid
         )`
      : 'WITH audience AS (SELECT id FROM players)';

  const params = scope === 'friends' ? [viewerId] : [];
  const periodClause = PERIOD_SQL[period];

  // Accuracy and streak are player-level properties, not point sums, so they
  // read from the stats cache. Everything else aggregates the ledger.
  if (board === 'accuracy' || board === 'streak') {
    const metric =
      board === 'accuracy'
        ? `CASE WHEN s.questions_answered >= 20
                 THEN ROUND((s.correct_answers::numeric / s.questions_answered) * 100, 1)
                 ELSE NULL END`
        : 's.best_streak';

    const rows = await queryRows(
      `${audience}
       SELECT p.id, p.display_name, ${metric} AS value, s.questions_answered
         FROM audience a
         JOIN players p      ON p.id = a.id
         JOIN player_stats s ON s.player_id = p.id
        WHERE ${metric} IS NOT NULL
        ORDER BY value DESC NULLS LAST, s.questions_answered DESC
        LIMIT ${limit}`,
      params,
    );

    return {
      period: 'all',
      scope,
      board,
      unit: board === 'accuracy' ? 'percent' : 'streak',
      entries: rows.map((r, i) => ({
        rank: i + 1,
        playerId: r.id,
        displayName: r.display_name,
        value: Number(r.value),
        questionsAnswered: r.questions_answered,
        isViewer: r.id === viewerId,
      })),
    };
  }

  const categoryClause =
    board === 'overall' ? '' : `AND e.category = '${board.replace(/'/g, '')}'`;

  const rows = await queryRows(
    `${audience}
     SELECT p.id, p.display_name,
            COALESCE(SUM(e.points), 0)::int                         AS value,
            COUNT(e.id) FILTER (WHERE e.correct)::int               AS correct,
            COUNT(e.id)::int                                        AS answered
       FROM audience a
       JOIN players p ON p.id = a.id
       LEFT JOIN score_events e
              ON e.player_id = p.id
             AND ${periodClause}
             ${categoryClause}
      GROUP BY p.id, p.display_name
     HAVING COALESCE(SUM(e.points), 0) > 0 OR p.id = ${scope === 'friends' ? '$1' : 'NULL'}
      ORDER BY value DESC, p.display_name ASC
      LIMIT ${limit}`,
    params,
  );

  return {
    period,
    scope,
    board,
    unit: 'points',
    entries: rows.map((r, i) => ({
      rank: i + 1,
      playerId: r.id,
      displayName: r.display_name,
      value: r.value,
      accuracy: r.answered ? Math.round((r.correct / r.answered) * 1000) / 10 : 0,
      questionsAnswered: r.answered,
      isViewer: r.id === viewerId,
    })),
  };
}

/** Leaderboard for one day's quiz (any category): score, accuracy, completion time. */
export async function getDailyLeaderboard({ day, category = 'mixed', scope = 'global', viewerId, limit = 50 }) {
  const audience =
    scope === 'friends'
      ? `WITH audience AS (
           SELECT friend_id AS id FROM friendships WHERE player_id = $3
           UNION SELECT $3::uuid
         )`
      : 'WITH audience AS (SELECT id FROM players)';

  const params = scope === 'friends' ? [day, category, viewerId] : [day, category];

  const rows = await queryRows(
    `${audience}
     SELECT p.id, p.display_name, s.total_score, s.correct_count,
            array_length(s.question_ids, 1) AS total,
            s.completed_at,
            EXTRACT(EPOCH FROM (s.completed_at - s.started_at)) * 1000 AS elapsed_ms,
            COALESCE((SELECT SUM(response_ms) FROM session_answers WHERE session_id = s.id), 0)::int AS answer_ms
       FROM game_sessions s
       JOIN players p  ON p.id = s.player_id
       JOIN audience a ON a.id = p.id
      WHERE s.mode = 'daily' AND s.daily_date = $1 AND s.category = $2
        AND s.is_practice = FALSE AND s.completed_at IS NOT NULL
      ORDER BY s.total_score DESC, answer_ms ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 100)}`,
    params,
  );

  return rows.map((r, i) => ({
    rank: i + 1,
    playerId: r.id,
    displayName: r.display_name,
    score: r.total_score,
    correct: r.correct_count,
    total: r.total,
    accuracy: r.total ? Math.round((r.correct_count / r.total) * 1000) / 10 : 0,
    completionMs: r.answer_ms,
    completedAt: r.completed_at,
    isViewer: r.id === viewerId,
  }));
}
