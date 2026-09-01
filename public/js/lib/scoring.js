/**
 * Scoring rules, browser-side.
 *
 * In a deployed game the server owns scoring and the page never computes a
 * point — that is the whole anti-cheat model, and it is unchanged. This module
 * exists for local play, where there is no server to be authoritative and the
 * player is scoring themselves. Nothing here weakens the hosted game.
 *
 * The constants and the arithmetic mirror backend/lib/config.js and
 * backend/services/scoringService.js. tests/localBackend.test.js scores the same
 * matrix of inputs through both implementations and asserts they agree, so the
 * two cannot drift apart unnoticed.
 */

export const SCORING = {
  base: { easy: 100, medium: 150, hard: 200 },
  maxSpeedBonus: { easy: 50, medium: 75, hard: 100 },
  fullBonusMs: 2000,
  questionTimeLimitMs: 20000,
  minPlausibleMs: 750,
  networkGraceMs: 1500,
  streakBonuses: [
    { min: 10, multiplier: 1.3, label: '+30%' },
    { min: 5, multiplier: 1.2, label: '+20%' },
    { min: 3, multiplier: 1.1, label: '+10%' },
  ],
};

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

export function scoringRules() {
  return {
    base: SCORING.base,
    maxSpeedBonus: SCORING.maxSpeedBonus,
    fullBonusMs: SCORING.fullBonusMs,
    questionTimeLimitMs: SCORING.questionTimeLimitMs,
    streakBonuses: SCORING.streakBonuses.map(({ min, label }) => ({ min, label })),
  };
}
