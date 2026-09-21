import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gameDayOf, gameDayBounds, gameHourNow, shiftGameDay, recentGameDays,
} from '../backend/lib/day.js';

// These assume the default game timezone (America/Denver).

test('the game day rolls over at Mountain midnight, not UTC midnight', () => {
  // 2026-07-01 05:59 UTC is 23:59 MDT on June 30; 06:00 UTC is midnight MDT.
  assert.equal(gameDayOf(new Date('2026-07-01T05:59:59Z')), '2026-06-30');
  assert.equal(gameDayOf(new Date('2026-07-01T06:00:00Z')), '2026-07-01');
  // Winter: MST is UTC-7.
  assert.equal(gameDayOf(new Date('2026-01-15T06:59:59Z')), '2026-01-14');
  assert.equal(gameDayOf(new Date('2026-01-15T07:00:00Z')), '2026-01-15');
});

test('the hour is read in the game timezone', () => {
  assert.equal(gameHourNow(new Date('2026-07-01T06:30:00Z')), 0);
  assert.equal(gameHourNow(new Date('2026-01-15T07:30:00Z')), 0);
  assert.equal(gameHourNow(new Date('2026-07-01T07:30:00Z')), 1);
});

test('day bounds start at local midnight in summer and winter', () => {
  assert.equal(gameDayBounds('2026-07-01').start.toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(gameDayBounds('2026-01-15').start.toISOString(), '2026-01-15T07:00:00.000Z');
});

test('days are 23 or 25 hours long across daylight-saving changes', () => {
  const hours = (day) => {
    const { start, end } = gameDayBounds(day);
    return (end - start) / 3_600_000;
  };
  assert.equal(hours('2026-03-08'), 23, 'spring forward');
  assert.equal(hours('2026-11-01'), 25, 'fall back');
  assert.equal(hours('2026-06-10'), 24);
});

test('bounds are contiguous and every instant in them maps back to the day', () => {
  const { start, end } = gameDayBounds('2026-03-08');
  assert.equal(gameDayOf(start), '2026-03-08');
  assert.equal(gameDayOf(new Date(end.getTime() - 1)), '2026-03-08');
  assert.equal(gameDayOf(end), '2026-03-09');
  assert.equal(gameDayBounds('2026-03-09').start.getTime(), end.getTime());
});

test('shifting and listing days', () => {
  assert.equal(shiftGameDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftGameDay('2026-12-31', 1), '2027-01-01');
  const days = recentGameDays(5);
  assert.equal(days.length, 5);
  assert.equal(days[0], gameDayOf(new Date()));
  assert.equal(days[1], shiftGameDay(days[0], -1));
});
