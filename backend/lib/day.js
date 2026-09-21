import { GAME } from './config.js';

/**
 * The game's calendar day.
 *
 * Every "day" in the app — which daily quiz is live, which leaderboard a score
 * lands on, when the content bank refreshes — rolls over at midnight in
 * GAME.timezone (America/Denver by default), not UTC. Days are `YYYY-MM-DD`
 * strings in that zone. Denver observes daylight saving, so a game day is
 * occasionally 23 or 25 hours long; anything that needs the real instants
 * should use dayBounds() rather than assuming 24 hours.
 */

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: GAME.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(date) {
  const out = {};
  for (const { type, value } of partsFormat.formatToParts(date)) out[type] = Number(value);
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/** The game-timezone calendar day (`YYYY-MM-DD`) that contains `date`. */
export function gameDayOf(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export const todayGameDay = () => gameDayOf(new Date());

/** Hour of day (0-23) in the game timezone. */
export function gameHourNow(date = new Date()) {
  return zonedParts(date).hour;
}

/** Offset of the game timezone from UTC at `date`, in ms (negative west of UTC). */
function offsetMs(date) {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a game day begins (local midnight). */
export function gameDayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const wallClockAsUtc = Date.UTC(y, m - 1, d);
  // Two passes settle the offset even when it changes between the guess and
  // the answer (which only happens on a daylight-saving transition day).
  let instant = wallClockAsUtc - offsetMs(new Date(wallClockAsUtc));
  instant = wallClockAsUtc - offsetMs(new Date(instant));
  return new Date(instant);
}

/** Day string `count` days from `day` (negative goes back). */
export function shiftGameDay(day, count) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10);
}

/** Half-open `[start, end)` instants covering one game day. */
export function gameDayBounds(day) {
  return { start: gameDayStart(day), end: gameDayStart(shiftGameDay(day, 1)) };
}

/** The most recent `count` game days, today first. */
export function recentGameDays(count) {
  const today = todayGameDay();
  return Array.from({ length: count }, (_, i) => shiftGameDay(today, -i));
}
