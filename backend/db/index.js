import pg from 'pg';
import { APP, IS_SERVERLESS } from '../lib/config.js';

const { Pool, types } = pg;

// Return BIGINT/NUMERIC as JS numbers. Every bigint column here is a score or a
// counter, comfortably inside Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));

/**
 * TLS policy for the Postgres connection.
 *
 * Hosted Postgres (Neon, Supabase, RDS) presents a certificate from a public
 * CA, so the certificate is verified by default — an unverified TLS connection
 * to a database holding player data is a man-in-the-middle waiting to happen.
 * Two documented escape hatches exist for providers that present a self-signed
 * certificate: `sslmode=no-verify` in the connection string, or PGSSL_NO_VERIFY=1.
 * `sslmode=disable` turns TLS off entirely and is for a local server only.
 */
export function sslConfig(connectionString = APP.databaseUrl ?? '') {
  if (/[?&]sslmode=disable\b/.test(connectionString)) return false;
  const skipVerify =
    /[?&]sslmode=no-verify\b/.test(connectionString) ||
    process.env.PGSSL_NO_VERIFY === '1' ||
    process.env.PGSSL_NO_VERIFY === 'true';
  return { rejectUnauthorized: !skipVerify };
}

/**
 * A single pool is reused across warm serverless invocations. `max` is kept
 * small because every concurrent function instance holds its own pool and a
 * hosted database has a finite connection budget; use a pooled connection
 * string (PgBouncer / the Neon or Supabase pooler) in production.
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
      // its advisory lock (which spans upstream network I/O), so a long-lived
      // server needs headroom above the number of categories. A serverless
      // instance serves one request at a time and should stay frugal, because
      // the connection budget is shared across every warm instance.
      max: Number.parseInt(process.env.PGPOOL_MAX ?? '', 10) || (IS_SERVERLESS ? 3 : 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslConfig(APP.databaseUrl),
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
