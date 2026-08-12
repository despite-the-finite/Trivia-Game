#!/usr/bin/env node
/**
 * Applies backend/db/schema.sql. The schema is idempotent (every statement is
 * IF NOT EXISTS or guarded), so this is safe to re-run on every deploy.
 *
 *   npm run migrate
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from '../backend/db/index.js';
import { assertConfigured } from '../backend/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));

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
  process.exitCode = 1;
  closePool();
});
