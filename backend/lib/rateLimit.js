import { query } from '../db/index.js';
import { tooManyRequests } from './http.js';

/**
 * Fixed-window counter backed by Postgres so the limit holds across serverless
 * instances. This is deliberately coarse: it exists to blunt scripted abuse,
 * not to be a precise quota system.
 */
export async function enforceRateLimit(bucket, { limit, windowMs }) {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  let hits;
  try {
    const { rows } = await query(
      `INSERT INTO rate_limits (bucket, window_start, hits)
            VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start)
       DO UPDATE SET hits = rate_limits.hits + 1
         RETURNING hits`,
      [bucket, windowStart],
    );
    hits = rows[0].hits;
  } catch (err) {
    // Never let the limiter itself take the API down.
    console.warn('[rateLimit] check failed, allowing request:', err.message);
    return;
  }

  if (hits > limit) throw tooManyRequests();

  // Opportunistic cleanup of stale windows.
  if (hits % 200 === 0) {
    query('DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL \'1 day\'').catch(() => {});
  }
}
