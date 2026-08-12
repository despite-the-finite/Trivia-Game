import { SCORING } from '../lib/config.js';

/**
 * scoringService — the single authority on how many points an answer is worth.
 *
 * The frontend never computes a score. It sends {questionId, selectedIndex,
 * responseMs}; everything below runs on the server against the stored question.
 *
 * Design constraint from the spec: rapid guessing must never be advantageous.
 * Three things enforce that:
 *   1. A wrong answer scores 0 and resets the streak, so the expected value of
 *      a blind guess (~25% of base) is far below reading and answering.
 *   2. Answers faster than a human could read earn base points only — the speed
 *      bonus is withheld, so mashing cannot beat a considered fast answer.
 *   3. The client's claimed response time is clamped against the server's own
 *      measurement, so it cannot report 200ms after thinking for 15 seconds.
 */

/**
 * Reconciles the client's stopwatch with the server's.
 *
 * The server knows when the session started and when the answer arrived, which
 * bounds how fast the response could possibly have been. The client's figure is
 * more precise (it excludes network time) so we prefer it — but only when it is
 * consistent with what the server observed.
 */
export function reconcileResponseTime({ clientMs, serverElapsedMs }) {
  const limit = SCORING.questionTimeLimitMs;
  const grace = SCORING.networkGraceMs;

  const client = Number.isFinite(clientMs) ? Math.max(0, Math.round(clientMs)) : null;
  const server = Number.isFinite(serverElapsedMs) ? Math.max(0, Math.round(serverElapsedMs)) : null;

  const flags = [];

  if (client === null) {
    flags.push('missing-client-timing');
    return { responseMs: Math.min(server ?? limit, limit), flags };
  }

  // A client claiming to be materially faster than the server observed is
  // either lying or on an impossibly fast link. Trust the server, minus grace.
  let responseMs = client;
  if (server !== null && client < server - grace) {
    responseMs = server - grace;
    flags.push('client-timing-too-fast');
  }
  if (client > limit + grace) {
    flags.push('over-time-limit');
  }

  responseMs = Math.min(Math.max(responseMs, 0), limit);
  return { responseMs, flags };
}

export function streakMultiplier(streak) {
  for (const tier of SCORING.streakBonuses) {
    if (streak >= tier.min) return tier;
  }
  return { min: 0, multiplier: 1, label: null };
}

/**
 * Speed bonus decays linearly from the full amount (at or under `fullBonusMs`)
 * to zero (at the time limit). Simple enough that a player can predict it.
 */
export function speedBonus({ difficulty, responseMs, suspicious }) {
  const max = SCORING.maxSpeedBonus[difficulty] ?? SCORING.maxSpeedBonus.easy;
  if (suspicious) return 0;

  const { fullBonusMs, questionTimeLimitMs } = SCORING;
  if (responseMs <= fullBonusMs) return max;
  if (responseMs >= questionTimeLimitMs) return 0;

  const span = questionTimeLimitMs - fullBonusMs;
  const remaining = questionTimeLimitMs - responseMs;
  return Math.round(max * (remaining / span));
}

/**
 * @param {object} input
 * @param {boolean} input.correct
 * @param {'easy'|'medium'|'hard'} input.difficulty
 * @param {number} input.responseMs   Already reconciled.
 * @param {number} input.currentStreak Streak BEFORE this answer.
 * @param {string[]} input.flags
 * @returns {{points:number, basePoints:number, speedBonus:number, streakMultiplier:number,
 *            streakLabel:string|null, newStreak:number, flags:string[]}}
 */
export function scoreAnswer({ correct, difficulty, responseMs, currentStreak = 0, flags = [] }) {
  const allFlags = [...flags];

  if (!correct) {
    return {
      points: 0,
      basePoints: 0,
      speedBonus: 0,
      streakMultiplier: 1,
      streakLabel: null,
      newStreak: 0,
      flags: allFlags,
    };
  }

  const suspicious = responseMs < SCORING.minPlausibleMs;
  if (suspicious) allFlags.push('implausibly-fast');

  const basePoints = SCORING.base[difficulty] ?? SCORING.base.easy;
  const bonus = speedBonus({ difficulty, responseMs, suspicious });
  const newStreak = currentStreak + 1;
  const tier = streakMultiplier(newStreak);
  const points = Math.round((basePoints + bonus) * tier.multiplier);

  return {
    points,
    basePoints,
    speedBonus: bonus,
    streakMultiplier: tier.multiplier,
    streakLabel: tier.label,
    newStreak,
    flags: allFlags,
  };
}

/** Exposed to the client so the scoring rules can be shown in the UI. */
export function scoringRules() {
  return {
    base: SCORING.base,
    maxSpeedBonus: SCORING.maxSpeedBonus,
    fullBonusMs: SCORING.fullBonusMs,
    questionTimeLimitMs: SCORING.questionTimeLimitMs,
    streakBonuses: SCORING.streakBonuses.map(({ min, label }) => ({ min, label })),
  };
}
