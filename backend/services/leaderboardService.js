import { queryRows } from '../db/index.js';
import { CATEGORIES } from '../lib/config.js';
import { badRequest } from '../lib/http.js';

/**
 * leaderboardService — the permanent home-screen leaderboard.
 *
 * Ranking is for one UTC calendar day at a time — points a player earned
 * that specific day, summed from the `score_events` ledger — rather than an
 * all-time total, so the board reflects "today," not whoever has played the
 * longest. Each row is broken out by category. History only reaches back
 * `HISTORY_DAYS` days; older days are simply not offered as a query option
 * (the ledger itself is untouched, since personal weekly/monthly stats
 * elsewhere still read further back than that).
 */

export const HISTORY_DAYS = 5;

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** The most recent `HISTORY_DAYS` UTC calendar days, today first. */
export function recentUtcDays(count = HISTORY_DAYS) {
  const days = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

const isDayString = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Validates and normalises a `day` query param against the retained window. */
export function parseHistoryDay(value) {
  if (value === undefined || value === null || value === '') return todayUtc();
  if (!isDayString(value)) throw badRequest('day must be a date in YYYY-MM-DD form.');
  const available = recentUtcDays();
  if (!available.includes(value)) {
    throw badRequest(`day must be one of the last ${HISTORY_DAYS} days: ${available.join(', ')}.`);
  }
  return value;
}

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
 * @param {string} [opts.day]  UTC day (YYYY-MM-DD); defaults to today.
 * @param {string|null} opts.viewerId
 * @param {number} opts.limit  How many top rows to return (the "11th row" for
 *   the viewer, when they fall outside this slice, is returned separately).
 */
export async function getDayLeaderboard({ day = todayUtc(), viewerId = null, limit = 10 } = {}) {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const rows = await queryRows(
    `SELECT p.id, p.display_name, d.total_score,
            d.current_events_score, d.science_score, d.geography_score, d.general_knowledge_score,
            RANK() OVER (ORDER BY d.total_score DESC) AS rank
       FROM (
         SELECT player_id,
                SUM(points)::int AS total_score,
                SUM(points) FILTER (WHERE category = 'current-events')::int    AS current_events_score,
                SUM(points) FILTER (WHERE category = 'science')::int          AS science_score,
                SUM(points) FILTER (WHERE category = 'geography')::int        AS geography_score,
                SUM(points) FILTER (WHERE category = 'general-knowledge')::int AS general_knowledge_score
           FROM score_events
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY player_id
         HAVING SUM(points) > 0
       ) d
       JOIN players p ON p.id = d.player_id
      ORDER BY rank, p.display_name ASC`,
    [start.toISOString(), end.toISOString()],
  );

  const entries = rows.slice(0, limit).map((r) => ({ ...shapeRow(r), isViewer: r.id === viewerId }));
  const viewerInTop = entries.some((e) => e.isViewer);
  const viewerSource = !viewerInTop ? rows.find((r) => r.id === viewerId) : null;

  return {
    day,
    entries,
    viewerRow: viewerSource ? { ...shapeRow(viewerSource), isViewer: true } : null,
    categories: CATEGORIES,
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
