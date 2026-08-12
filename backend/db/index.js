import pg from 'pg';
import { APP } from '../lib/config.js';

const { Pool, types } = pg;

// Return BIGINT/NUMERIC as JS numbers. Every bigint column here is a score or a
// counter, comfortably inside Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));

/**
 * A single pool is reused across warm serverless invocations. `max` is kept
 * small because each function instance holds its own pool; use a pooled
 * connection string (PgBouncer / Neon pooler) in production.
 */
let pool;

export function getPool() {
  if (!pool) {
    if (!APP.databaseUrl) {
      throw new Error('DATABASE_URL is not set.');
    }
    pool = new Pool({
      connectionString: APP.databaseUrl,
      // A background content refresh holds one connection for the duration of
      // its advisory lock (which spans upstream network I/O), so the pool needs
      // headroom above the number of categories or player requests starve.
      max: Number.parseInt(process.env.PGPOOL_MAX ?? '', 10) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=disable/.test(APP.databaseUrl)
        ? false
        : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function queryRows(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

export async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Postgres advisory lock, used so that only one serverless instance runs a
 * content refresh for a given category at a time. Returns false immediately if
 * another holder has it.
 */
export async function withAdvisoryLock(key, fn) {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (!rows[0].locked) return { acquired: false, result: null };
    try {
      const result = await fn(client);
      return { acquired: true, result };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}

/** Stable 64-bit-ish key for advisory locks derived from a string. */
export function lockKey(name) {
  let h = 0n;
  for (const ch of name) {
    h = (h * 31n + BigInt(ch.codePointAt(0))) % 9223372036854775783n;
  }
  return Number(h % 2147483647n);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
