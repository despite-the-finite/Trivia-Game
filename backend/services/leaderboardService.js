import { queryRows } from '../db/index.js';

/**
 * leaderboardService — the permanent home-screen leaderboard.
 *
 * Ranking is by all-time overall score, read straight from the `player_stats`
 * cache (the same numbers the home screen's own stat tiles use) rather than
 * aggregated from the ledger — there is no time-period filter here, just one
 * standing board. Each row is broken out by category so a player's strengths
 * are visible at a glance.
 */

const CATEGORY_COLUMNS = {
  'current-events': 'current_events_score',
  science: 'science_score',
  geography: 'geography_score',
  'general-knowledge': 'general_knowledge_score',
};

function shapeRow(row) {
  return {
    rank: row.rank,
    playerId: row.id,
    displayName: row.display_name,
    totalScore: row.total_score,
    categoryScores: {
      'current-events': row.current_events_score,
      science: row.science_score,
      geography: row.geography_score,
      'general-knowledge': row.general_knowledge_score,
    },
  };
}

/**
 * @param {object} opts
 * @param {string|null} opts.viewerId
 * @param {number} opts.limit  How many top rows to return (the "11th row" for
 *   the viewer, when they fall outside this slice, is returned separately).
 */
export async function getOverallLeaderboard({ viewerId = null, limit = 10 } = {}) {
  const rows = await queryRows(
    `SELECT p.id, p.display_name, s.total_score,
            s.current_events_score, s.science_score, s.geography_score, s.general_knowledge_score,
            RANK() OVER (ORDER BY s.total_score DESC) AS rank
       FROM players p
       JOIN player_stats s ON s.player_id = p.id
      WHERE s.games_played > 0
      ORDER BY rank, p.display_name ASC`,
  );

  const entries = rows.slice(0, limit).map((r) => ({ ...shapeRow(r), isViewer: r.id === viewerId }));
  const viewerInTop = entries.some((e) => e.isViewer);
  const viewerSource = !viewerInTop ? rows.find((r) => r.id === viewerId) : null;

  return {
    entries,
    viewerRow: viewerSource ? { ...shapeRow(viewerSource), isViewer: true } : null,
    categories: Object.keys(CATEGORY_COLUMNS),
  };
}

/** Leaderboard for one day's quiz (any category): score, accuracy, completion time. */
export async function getDailyLeaderboard({ day, category = 'mixed', viewerId, limit = 50 }) {
  const rows = await queryRows(
    `SELECT p.id, p.display_name, s.total_score, s.correct_count,
            array_length(s.question_ids, 1) AS total,
            s.completed_at,
            EXTRACT(EPOCH FROM (s.completed_at - s.started_at)) * 1000 AS elapsed_ms,
            COALESCE((SELECT SUM(response_ms) FROM session_answers WHERE session_id = s.id), 0)::int AS answer_ms
       FROM game_sessions s
       JOIN players p  ON p.id = s.player_id
      WHERE s.mode = 'daily' AND s.daily_date = $1 AND s.category = $2
        AND s.is_practice = FALSE AND s.completed_at IS NOT NULL
      ORDER BY s.total_score DESC, answer_ms ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 100)}`,
    [day, category],
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
