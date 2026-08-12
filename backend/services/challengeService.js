import { query, queryOne, queryRows, withTransaction } from '../db/index.js';
import { APP, GAME } from '../lib/config.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { challengeSlug, seededRandom } from '../lib/ids.js';
import { pickBalancedSet, buildAnswerOrders, getQuestionsByIds } from './questionService.js';
import {
  normalizeCategory,
  normalizeDifficulty,
  normalizeCount,
  createFixedSession,
  shapeSessionForPlay,
} from './sessionService.js';

/**
 * challengeService — head-to-head runs over a frozen question set.
 *
 * The challenge stores both the question ids AND the answer permutation, so the
 * opponent gets a genuinely identical test: same questions, same order, same
 * option placement. Nothing about the comparison depends on client behaviour.
 */

function challengeUrl(slug) {
  const base = APP.publicUrl || '';
  return `${base}/challenge/${slug}`;
}

export async function createChallenge(player, { category, difficulty, count } = {}) {
  const cat = normalizeCategory(category);
  const diff = normalizeDifficulty(difficulty);
  const n = normalizeCount(count, GAME.challengeQuestionCount);

  const questions = await pickBalancedSet({ category: cat, difficulty: diff, count: n });
  if (questions.length < Math.min(n, 5)) {
    throw conflict('Not enough fresh questions are available to build a challenge right now.');
  }

  const slug = challengeSlug();
  // Seeded from the slug so the permutation is reproducible and auditable.
  const answerOrders = buildAnswerOrders(questions, seededRandom(`challenge:${slug}`));

  const challenge = await queryOne(
    `INSERT INTO challenges (slug, challenger_id, category, difficulty, question_ids, answer_orders, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() + ($7 || ' milliseconds')::interval)
       RETURNING *`,
    [
      slug,
      player.id,
      cat,
      diff,
      questions.map((q) => q.id),
      JSON.stringify(answerOrders),
      String(GAME.challengeTtlMs),
    ],
  );

  await query(
    `INSERT INTO challenge_participants (challenge_id, player_id, role)
          VALUES ($1, $2, 'challenger') ON CONFLICT DO NOTHING`,
    [challenge.id, player.id],
  );

  return {
    challenge: shapeChallengeMeta(challenge),
    url: challengeUrl(slug),
    shareText: buildInviteText(player.displayName ?? player.display_name, challengeUrl(slug)),
  };
}

export async function getChallengeBySlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9]{4,16}$/.test(slug)) {
    throw badRequest('Invalid challenge link.');
  }
  const challenge = await queryOne('SELECT * FROM challenges WHERE slug = $1', [slug]);
  if (!challenge) throw notFound('That challenge link is not valid.');
  return challenge;
}

/**
 * Starts (or resumes) the caller's attempt at a challenge. The challenger's own
 * attempt goes through the same path, so both sides play identical sets.
 */
export async function joinChallenge(player, slug) {
  const challenge = await getChallengeBySlug(slug);
  if (new Date(challenge.expires_at) < new Date()) {
    throw conflict('This challenge has expired.');
  }

  const existing = await queryOne(
    'SELECT * FROM challenge_participants WHERE challenge_id = $1 AND player_id = $2',
    [challenge.id, player.id],
  );

  if (existing?.completed_at) {
    throw conflict('You have already played this challenge.');
  }

  if (existing?.session_id) {
    // Resume an attempt that was started but not finished.
    const session = await queryOne('SELECT * FROM game_sessions WHERE id = $1', [existing.session_id]);
    if (session && !session.completed_at && new Date(session.expires_at) > new Date()) {
      const questions = await getQuestionsByIds(session.question_ids);
      return { ...shapeSessionForPlay(session, questions), challenge: shapeChallengeMeta(challenge) };
    }
  }

  const role = challenge.challenger_id === player.id ? 'challenger' : 'opponent';
  const playable = await createFixedSession(player, {
    mode: 'challenge',
    questionIds: challenge.question_ids,
    answerOrders: challenge.answer_orders,
    category: challenge.category,
    difficulty: challenge.difficulty,
    challengeId: challenge.id,
  });

  await query(
    `INSERT INTO challenge_participants (challenge_id, player_id, role, session_id)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (challenge_id, player_id)
     DO UPDATE SET session_id = EXCLUDED.session_id`,
    [challenge.id, player.id, role, playable.session.id],
  );

  return { ...playable, challenge: shapeChallengeMeta(challenge) };
}

function shapeChallengeMeta(challenge) {
  return {
    id: challenge.id,
    slug: challenge.slug,
    category: challenge.category,
    difficulty: challenge.difficulty,
    questionCount: challenge.question_ids.length,
    createdAt: challenge.created_at,
    expiresAt: challenge.expires_at,
    url: challengeUrl(challenge.slug),
  };
}

/**
 * Results for a challenge: both scores, accuracy, response times and who won.
 */
export async function getChallengeResults(slug, viewerId = null) {
  const challenge = await getChallengeBySlug(slug);

  const participants = await queryRows(
    `SELECT cp.player_id, cp.role, cp.score, cp.correct_count, cp.total_response_ms,
            cp.completed_at, p.display_name
       FROM challenge_participants cp
       JOIN players p ON p.id = cp.player_id
      WHERE cp.challenge_id = $1
      ORDER BY cp.role = 'challenger' DESC, cp.score DESC`,
    [challenge.id],
  );

  const total = challenge.question_ids.length;
  const shaped = participants.map((p) => ({
    playerId: p.player_id,
    displayName: p.display_name,
    role: p.role,
    completed: Boolean(p.completed_at),
    completedAt: p.completed_at,
    score: p.score,
    correct: p.correct_count,
    total,
    accuracy: total ? Math.round((p.correct_count / total) * 1000) / 10 : 0,
    totalResponseMs: p.total_response_ms,
    averageResponseMs: p.correct_count || p.completed_at ? Math.round(p.total_response_ms / total) : 0,
    isViewer: p.player_id === viewerId,
  }));

  const finished = shaped.filter((p) => p.completed);
  let outcome = null;

  if (finished.length >= 2) {
    const [first, second] = [...finished].sort((a, b) => b.score - a.score);
    if (first.score === second.score) {
      outcome = { status: 'tie', headline: `${first.displayName} and ${second.displayName} tied` };
    } else {
      outcome = {
        status: 'decided',
        winnerId: first.playerId,
        winnerName: first.displayName,
        margin: first.score - second.score,
        headline: `${first.displayName} wins by ${(first.score - second.score).toLocaleString('en-US')} points`,
      };
    }
  } else if (finished.length === 1) {
    outcome = {
      status: 'awaiting-opponent',
      headline: `Waiting for someone to take on ${finished[0].displayName}`,
    };
  } else {
    outcome = { status: 'not-started', headline: 'Nobody has played this challenge yet' };
  }

  return {
    challenge: shapeChallengeMeta(challenge),
    participants: shaped,
    outcome,
    shareText: buildResultText(shaped, outcome, challengeUrl(challenge.slug)),
  };
}

export async function listChallengesForPlayer(playerId, limit = 20) {
  const rows = await queryRows(
    `SELECT c.slug, c.category, c.created_at, c.expires_at,
            array_length(c.question_ids, 1) AS question_count,
            cp.score, cp.completed_at,
            (SELECT COUNT(*) FROM challenge_participants x
              WHERE x.challenge_id = c.id AND x.completed_at IS NOT NULL)::int AS finished_count
       FROM challenge_participants cp
       JOIN challenges c ON c.id = cp.challenge_id
      WHERE cp.player_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [playerId, limit],
  );

  return rows.map((r) => ({
    slug: r.slug,
    url: challengeUrl(r.slug),
    category: r.category,
    questionCount: r.question_count,
    yourScore: r.completed_at ? r.score : null,
    played: Boolean(r.completed_at),
    finishedCount: r.finished_count,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

function buildInviteText(displayName, url) {
  return `${displayName} challenged you to a round of Daily Trivia. Same 10 questions, same order — think you can win?\n${url}`;
}

function buildResultText(participants, outcome, url) {
  const lines = participants
    .filter((p) => p.completed)
    .map((p) => `${p.displayName} — ${p.score.toLocaleString('en-US')}`);
  if (outcome?.headline && outcome.status === 'decided') lines.push(outcome.headline);
  lines.push(url);
  return lines.join('\n');
}
