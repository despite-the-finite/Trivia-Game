import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreAnswer,
  speedBonus,
  streakMultiplier,
  reconcileResponseTime,
} from '../backend/services/scoringService.js';
import { SCORING } from '../backend/lib/config.js';

test('base points follow the flat scoring table', () => {
  const slow = SCORING.questionTimeLimitMs;
  const result = scoreAnswer({ correct: true, responseMs: slow, currentStreak: 0 });
  assert.equal(result.basePoints, SCORING.base);
  assert.equal(result.speedBonus, 0, 'no speed bonus at the time limit');
  assert.equal(result.points, SCORING.base);
});

test('an instant correct answer earns the full speed bonus', () => {
  const result = scoreAnswer({
    correct: true,
    responseMs: SCORING.fullBonusMs,
    currentStreak: 0,
  });
  assert.equal(result.speedBonus, SCORING.maxSpeedBonus);
  assert.equal(result.points, SCORING.base + SCORING.maxSpeedBonus);
});

test('the speed bonus decays monotonically with response time', () => {
  let previous = Infinity;
  for (let ms = SCORING.fullBonusMs; ms <= SCORING.questionTimeLimitMs; ms += 1000) {
    const bonus = speedBonus({ responseMs: ms, suspicious: false });
    assert.ok(bonus <= previous, `bonus should not increase at ${ms}ms`);
    previous = bonus;
  }
  assert.equal(previous, 0);
});

test('streak tiers match the published thresholds', () => {
  assert.equal(streakMultiplier(2).multiplier, 1);
  assert.equal(streakMultiplier(3).multiplier, 1.1);
  assert.equal(streakMultiplier(5).multiplier, 1.2);
  assert.equal(streakMultiplier(9).multiplier, 1.2);
  assert.equal(streakMultiplier(10).multiplier, 1.3);
  assert.equal(streakMultiplier(50).multiplier, 1.3);
});

test('a wrong answer scores zero and resets the streak', () => {
  const result = scoreAnswer({
    correct: false,
    responseMs: 500,
    currentStreak: 9,
  });
  assert.equal(result.points, 0);
  assert.equal(result.newStreak, 0);
});

test('rapid guessing is never advantageous', () => {
  // An implausibly fast correct answer forfeits the speed bonus, so it can
  // never beat a considered answer given at a human-plausible speed.
  const mashed = scoreAnswer({
    correct: true,
    responseMs: 120,
    currentStreak: 0,
  });
  const considered = scoreAnswer({
    correct: true,
    responseMs: SCORING.minPlausibleMs + 50,
    currentStreak: 0,
  });

  assert.equal(mashed.speedBonus, 0);
  assert.ok(mashed.flags.includes('implausibly-fast'));
  assert.ok(
    considered.points > mashed.points,
    'a plausibly fast answer must outscore a mashed one',
  );
});

test('expected value of a blind guess is far below answering correctly', () => {
  const base = SCORING.base;
  const guessEv = 0.25 * base; // 4 options, no speed bonus, streak reset on the other 75%
  const answered = scoreAnswer({
    correct: true,
    responseMs: 6000,
    currentStreak: 0,
  }).points;
  assert.ok(answered > guessEv * 2, 'reading and answering must dominate guessing');
});

test('client timing cannot claim to be faster than the server observed', () => {
  const { responseMs, flags } = reconcileResponseTime({
    clientMs: 100,
    serverElapsedMs: 14000,
  });
  assert.ok(flags.includes('client-timing-too-fast'));
  assert.equal(responseMs, 14000 - SCORING.networkGraceMs);
});

test('client timing is trusted when consistent with the server', () => {
  const { responseMs, flags } = reconcileResponseTime({
    clientMs: 4200,
    serverElapsedMs: 4600,
  });
  assert.equal(responseMs, 4200, 'network overhead is not charged to the player');
  assert.deepEqual(flags, []);
});

test('a missing client timing falls back to the server measurement', () => {
  const { responseMs, flags } = reconcileResponseTime({ clientMs: null, serverElapsedMs: 3000 });
  assert.equal(responseMs, 3000);
  assert.ok(flags.includes('missing-client-timing'));
});

test('response time is capped at the question time limit', () => {
  const { responseMs } = reconcileResponseTime({
    clientMs: 999999,
    serverElapsedMs: 999999,
  });
  assert.equal(responseMs, SCORING.questionTimeLimitMs);
});

test('worked example: fast answer on a 5-streak', () => {
  // 150 base + 75 speed = 225, x 1.2 streak = 270
  const result = scoreAnswer({
    correct: true,
    responseMs: 1500,
    currentStreak: 4,
  });
  assert.equal(result.newStreak, 5);
  assert.equal(result.streakMultiplier, 1.2);
  assert.equal(result.points, Math.round((SCORING.base + SCORING.maxSpeedBonus) * 1.2));
});
