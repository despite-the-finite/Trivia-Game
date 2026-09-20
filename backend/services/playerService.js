import { query, queryOne, withTransaction } from '../db/index.js';
import { opaqueToken, recoveryCode, sha256 } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/http.js';

/**
 * playerService — lightweight persistent identities.
 *
 * Onboarding is one tap: the client posts a display name and gets back a player
 * id and a bearer token. No password, no email, no verification step. The
 * account can later be moved to another device with a one-time
 * recovery code, which is the "upgrade to a permanent account" path without
 * standing up an email provider.
 */

const NAME_MIN = 2;
const NAME_MAX = 24;

export function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') throw badRequest('Display name is required.');
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN) throw badRequest(`Display name must be at least ${NAME_MIN} characters.`);
  if (name.length > NAME_MAX) throw badRequest(`Display name must be at most ${NAME_MAX} characters.`);
  if (!/^[\p{L}\p{N} '._-]+$/u.test(name)) {
    throw badRequest('Display name can only contain letters, numbers, spaces and . _ - characters.');
  }
  return name;
}

export async function createAnonymousPlayer(displayNameRaw) {
  const displayName = sanitizeDisplayName(displayNameRaw);
  const token = opaqueToken();

  const player = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO players (display_name, token_hash)
            VALUES ($1, $2)
         RETURNING id, display_name, is_anonymous, created_at`,
      [displayName, sha256(token)],
    );
    await client.query('INSERT INTO player_stats (player_id) VALUES ($1)', [rows[0].id]);
    return rows[0];
  });

  return { player: shapePlayer(player), token };
}

export async function renamePlayer(playerId, displayNameRaw) {
  const displayName = sanitizeDisplayName(displayNameRaw);
  const row = await queryOne(
    `UPDATE players SET display_name = $2 WHERE id = $1
       RETURNING id, display_name, is_anonymous, created_at`,
    [playerId, displayName],
  );
  if (!row) throw notFound('Player not found.');
  return shapePlayer(row);
}

/**
 * Issues a single-use code that moves this account to another device. Codes are
 * stored hashed and expire, so an intercepted code has a short life.
 */
export async function issueRecoveryCode(playerId) {
  const code = recoveryCode();
  await query(
    `UPDATE players
        SET recovery_hash = $2, recovery_expires_at = NOW() + INTERVAL '30 minutes'
      WHERE id = $1`,
    [playerId, sha256(code)],
  );
  return { code, expiresInMinutes: 30 };
}

/** Redeems a recovery code, rotating the bearer token onto the new device. */
export async function claimWithRecoveryCode(rawCode) {
  const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!code) throw badRequest('A recovery code is required.');

  const token = opaqueToken();
  const row = await queryOne(
    `UPDATE players
        SET token_hash = $2, recovery_hash = NULL, recovery_expires_at = NULL, last_seen_at = NOW()
      WHERE recovery_hash = $1 AND recovery_expires_at > NOW()
       RETURNING id, display_name, is_anonymous, created_at`,
    [sha256(code), sha256(token)],
  );
  if (!row) throw notFound('That recovery code is invalid or has expired.');
  return { player: shapePlayer(row), token };
}

export function shapePlayer(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    isAnonymous: row.is_anonymous,
    createdAt: row.created_at,
  };
}

export async function getStats(playerId) {
  const stats = await queryOne('SELECT * FROM player_stats WHERE player_id = $1', [playerId]);
  if (!stats) return emptyStats();

  const periods = await queryOne(
    `SELECT
       COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::int   AS daily,
       COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0)::int  AS weekly,
       COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS monthly
     FROM score_events WHERE player_id = $1`,
    [playerId],
  );

  return shapeStats(stats, periods);
}

export function shapeStats(stats, periods = {}) {
  const answered = stats.questions_answered || 0;
  return {
    totalScore: stats.total_score,
    gamesPlayed: stats.games_played,
    questionsAnswered: answered,
    correctAnswers: stats.correct_answers,
    incorrectAnswers: stats.incorrect_answers,
    accuracy: answered ? Math.round((stats.correct_answers / answered) * 1000) / 10 : 0,
    currentStreak: stats.current_streak,
    bestStreak: stats.best_streak,
    averageResponseMs: answered ? Math.round(stats.total_response_ms / answered) : 0,
    categoryScores: {
      'current-events': stats.current_events_score,
      science: stats.science_score,
      geography: stats.geography_score,
      'general-knowledge': stats.general_knowledge_score,
    },
    dailyScore: periods.daily ?? 0,
    weeklyScore: periods.weekly ?? 0,
    monthlyScore: periods.monthly ?? 0,
    allTimeScore: stats.total_score,
    personalBests: {
      gameScore: stats.best_game_score,
      gameAccuracy: Number(stats.best_game_accuracy),
      bestStreak: stats.best_streak,
      dailyChallengeScore: stats.best_daily_score,
    },
  };
}

function emptyStats() {
  return shapeStats(
    {
      total_score: 0, games_played: 0, questions_answered: 0, correct_answers: 0,
      incorrect_answers: 0, current_streak: 0, best_streak: 0, total_response_ms: 0,
      current_events_score: 0, science_score: 0, geography_score: 0, general_knowledge_score: 0,
      best_game_score: 0, best_game_accuracy: 0, best_daily_score: 0,
    },
    {},
  );
}

const CATEGORY_COLUMN = {
  'current-events': 'current_events_score',
  science: 'science_score',
  geography: 'geography_score',
  'general-knowledge': 'general_knowledge_score',
};

/**
 * Applies one answer to the player's cached counters. Called inside the same
 * transaction that records the answer, so stats can never drift from the ledger.
 */
export async function applyAnswerToStats(client, playerId, { correct, points, category, responseMs, newStreak }) {
  const categoryCol = CATEGORY_COLUMN[category];

  await client.query(
    `UPDATE player_stats SET
        total_score        = total_score + $2,
        questions_answered = questions_answered + 1,
        correct_answers    = correct_answers + $3,
        incorrect_answers  = incorrect_answers + $4,
        total_response_ms  = total_response_ms + $5,
        current_streak     = $6,
        best_streak        = GREATEST(best_streak, $6),
        ${categoryCol ? `${categoryCol} = ${categoryCol} + $2,` : ''}
        updated_at         = NOW()
      WHERE player_id = $1`,
    [playerId, points, correct ? 1 : 0, correct ? 0 : 1, responseMs, newStreak],
  );
}

export async function applyGameCompletion(client, playerId, { score, accuracy, isDaily }) {
  await client.query(
    `UPDATE player_stats SET
        games_played       = games_played + 1,
        best_game_score    = GREATEST(best_game_score, $2),
        best_game_accuracy = GREATEST(best_game_accuracy, $3),
        best_daily_score   = CASE WHEN $4 THEN GREATEST(best_daily_score, $2) ELSE best_daily_score END,
        updated_at         = NOW()
      WHERE player_id = $1`,
    [playerId, score, accuracy, Boolean(isDaily)],
  );
}

/** Public profile: another player's display name and stats. */
export async function getPublicProfile(playerId) {
  const row = await queryOne(
    `SELECT p.id, p.display_name, s.*
       FROM players p JOIN player_stats s ON s.player_id = p.id
      WHERE p.id = $1`,
    [playerId],
  );
  if (!row) throw notFound('Player not found.');

  const periods = await queryOne(
    `SELECT
       COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::int   AS daily,
       COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0)::int  AS weekly,
       COALESCE(SUM(points) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS monthly
     FROM score_events WHERE player_id = $1`,
    [playerId],
  );

  return {
    id: row.id,
    displayName: row.display_name,
    stats: shapeStats(row, periods),
  };
}
