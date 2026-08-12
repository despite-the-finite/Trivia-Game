import { query, queryOne, queryRows, withTransaction } from '../db/index.js';
import { friendCode, normalizeFriendCode, opaqueToken, recoveryCode, sha256 } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/http.js';

/**
 * playerService — lightweight persistent identities.
 *
 * Onboarding is one tap: the client posts a display name and gets back a player
 * id, a friend code and a bearer token. No password, no email, no verification
 * step. The account can later be moved to another device with a one-time
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

async function allocateFriendCode(client, displayName) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = friendCode(attempt < 4 ? displayName : '');
    const { rows } = await client.query('SELECT 1 FROM players WHERE friend_code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not allocate a unique friend code.');
}

export async function createAnonymousPlayer(displayNameRaw) {
  const displayName = sanitizeDisplayName(displayNameRaw);
  const token = opaqueToken();

  const player = await withTransaction(async (client) => {
    const code = await allocateFriendCode(client, displayName);
    const { rows } = await client.query(
      `INSERT INTO players (display_name, friend_code, token_hash)
            VALUES ($1, $2, $3)
         RETURNING id, display_name, friend_code, is_anonymous, created_at`,
      [displayName, code, sha256(token)],
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
       RETURNING id, display_name, friend_code, is_anonymous, created_at`,
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
       RETURNING id, display_name, friend_code, is_anonymous, created_at`,
    [sha256(code), sha256(token)],
  );
  if (!row) throw notFound('That recovery code is invalid or has expired.');
  return { player: shapePlayer(row), token };
}

export function shapePlayer(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    friendCode: row.friend_code,
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
    },
    difficultyCorrect: {
      easy: stats.easy_correct,
      medium: stats.medium_correct,
      hard: stats.hard_correct,
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
      current_events_score: 0, science_score: 0, geography_score: 0,
      easy_correct: 0, medium_correct: 0, hard_correct: 0,
      best_game_score: 0, best_game_accuracy: 0, best_daily_score: 0,
    },
    {},
  );
}

const CATEGORY_COLUMN = {
  'current-events': 'current_events_score',
  science: 'science_score',
  geography: 'geography_score',
};

const DIFFICULTY_COLUMN = { easy: 'easy_correct', medium: 'medium_correct', hard: 'hard_correct' };

/**
 * Applies one answer to the player's cached counters. Called inside the same
 * transaction that records the answer, so stats can never drift from the ledger.
 */
export async function applyAnswerToStats(client, playerId, { correct, points, category, difficulty, responseMs, newStreak }) {
  const categoryCol = CATEGORY_COLUMN[category];
  const difficultyCol = DIFFICULTY_COLUMN[difficulty];

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
        ${correct && difficultyCol ? `${difficultyCol} = ${difficultyCol} + 1,` : ''}
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

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

export async function addFriendByCode(playerId, rawCode) {
  const code = normalizeFriendCode(rawCode);
  if (!code) throw badRequest('That does not look like a friend code. They look like KARSH-7F4X.');

  const friend = await queryOne(
    'SELECT id, display_name, friend_code FROM players WHERE friend_code = $1',
    [code],
  );
  if (!friend) throw notFound('No player has that friend code.');
  if (friend.id === playerId) throw badRequest('That is your own friend code.');

  // Friendship is mutual: adding someone puts you on their Friends list too, so
  // there is no request/accept step to slow the UX down.
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO friendships (player_id, friend_id) VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [playerId, friend.id],
    );
  });

  return { id: friend.id, displayName: friend.display_name, friendCode: friend.friend_code };
}

export async function removeFriend(playerId, friendId) {
  const { rowCount } = await query(
    'DELETE FROM friendships WHERE (player_id = $1 AND friend_id = $2) OR (player_id = $2 AND friend_id = $1)',
    [playerId, friendId],
  );
  if (!rowCount) throw notFound('You are not friends with that player.');
  return { removed: true };
}

/** Friends list with the stats the Friends screen shows. */
export async function listFriends(playerId) {
  return queryRows(
    `SELECT p.id,
            p.display_name,
            p.friend_code,
            s.total_score,
            s.best_streak,
            s.questions_answered,
            s.correct_answers,
            COALESCE(w.weekly, 0)::int AS weekly_score
       FROM friendships f
       JOIN players p       ON p.id = f.friend_id
       JOIN player_stats s  ON s.player_id = p.id
       LEFT JOIN LATERAL (
            SELECT SUM(points) AS weekly
              FROM score_events e
             WHERE e.player_id = p.id
               AND e.created_at >= date_trunc('week', NOW())
       ) w ON TRUE
      WHERE f.player_id = $1
      ORDER BY weekly_score DESC, s.total_score DESC`,
    [playerId],
  ).then((rows) =>
    rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      friendCode: r.friend_code,
      weeklyScore: r.weekly_score,
      allTimeScore: r.total_score,
      accuracy: r.questions_answered
        ? Math.round((r.correct_answers / r.questions_answered) * 1000) / 10
        : 0,
      bestStreak: r.best_streak,
    })),
  );
}

/** Public profile used for head-to-head comparison. */
export async function getPublicProfile(playerId, viewerId) {
  const row = await queryOne(
    `SELECT p.id, p.display_name, p.friend_code, s.*
       FROM players p JOIN player_stats s ON s.player_id = p.id
      WHERE p.id = $1`,
    [playerId],
  );
  if (!row) throw notFound('Player not found.');

  const isFriend = viewerId
    ? Boolean(
        await queryOne('SELECT 1 FROM friendships WHERE player_id = $1 AND friend_id = $2', [
          viewerId,
          playerId,
        ]),
      )
    : false;

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
    friendCode: isFriend ? row.friend_code : undefined,
    isFriend,
    stats: shapeStats(row, periods),
  };
}

export async function areFriends(a, b) {
  return Boolean(
    await queryOne('SELECT 1 FROM friendships WHERE player_id = $1 AND friend_id = $2', [a, b]),
  );
}
