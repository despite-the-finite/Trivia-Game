#!/usr/bin/env node
/**
 * Applies backend/db/schema.sql.
 *
 *   npm run migrate
 *
 * The schema is idempotent — every statement is CREATE … IF NOT EXISTS or an
 * equivalent guard — so running it twice against the same database is safe and
 * does nothing the second time. It never drops or rewrites a table, so it will
 * not destroy existing players, questions or scores.
 *
 * Vercel does not run this for you: there is no build step to hang it off, and a
 * migration that runs on every deploy is a migration that can fail on every
 * deploy. Run it yourself, once, against the production database:
 *
 *   DATABASE_URL='postgres://…' npm run migrate
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv } from './load-env.js';

const here = dirname(fileURLToPath(import.meta.url));

// Must happen before the config module reads process.env.
await loadDotEnv();

const { getPool, closePool } = await import('../backend/db/index.js');
const { assertConfigured } = await import('../backend/lib/config.js');

async function main() {
  assertConfigured();
  const sql = await readFile(join(here, '..', 'backend', 'db', 'schema.sql'), 'utf8');
  const client = await getPool().connect();
  try {
    console.log('Applying schema…');
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    console.log(`Done. ${rows.length} tables present:`);
    for (const r of rows) console.log(`  - ${r.table_name}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  if (/self.signed|certificate/i.test(err.message)) {
    console.error(
      'The database presented a certificate that could not be verified. If you trust the\n' +
        'provider, add ?sslmode=no-verify to DATABASE_URL or set PGSSL_NO_VERIFY=1.',
    );
  }
  process.exitCode = 1;
  closePool();
});
