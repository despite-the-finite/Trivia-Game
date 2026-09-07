import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHandler, getQuery, forbidden, badRequest } from '../backend/lib/http.js';
import { timingSafeEqual } from '../backend/lib/auth.js';
import { APP, CATEGORIES } from '../backend/lib/config.js';
import { getPool, queryOne } from '../backend/db/index.js';
import { refreshCategory, poolStatus } from '../backend/services/contentPipeline.js';

/**
 * POST /api/setup
 *
 * One-time deployment setup, from a browser instead of a terminal.
 *
 *   ?action=status     what state is this database in?
 *   ?action=migrate    apply backend/db/schema.sql
 *   ?action=seed&category=geography   generate the first questions
 *
 * This exists because the alternative — install Node, clone the repo, run two
 * npm scripts — is a real wall for someone deploying their own copy, and the
 * work itself is small: applying a schema that is idempotent by construction
 * (every statement is CREATE … IF NOT EXISTS; there is no DROP anywhere in it),
 * and calling the same content pipeline the scheduled job already calls.
 *
 * It is protected by CRON_SECRET, the same credential and the same timing-safe
 * comparison as /api/cron/refresh, because `seed` can spend money at the model
 * provider. `public/setup.html` is a small page that sends that secret as a
 * header so it never lands in a URL, a server log or browser history.
 *
 * Running migrations from a web request is not how a team with a deploy
 * pipeline should do this; `npm run migrate` remains the documented path and is
 * what CI or a release step would call. This is the single-operator escape
 * hatch, and it is safe to leave enabled: without the secret it does nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));

function authorize(req) {
  if (!APP.cronSecret) {
    throw forbidden('Setup is disabled because CRON_SECRET is not set on this deployment.');
  }
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : req.headers['x-cron-secret'];
  if (!provided || !timingSafeEqual(provided, APP.cronSecret)) {
    console.warn('[setup] refused: invalid credentials.');
    throw forbidden('That setup key does not match CRON_SECRET.');
  }
}

/** Which tables exist, so the caller can be told what still needs doing. */
async function schemaState() {
  const row = await queryOne(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('players','questions','game_sessions','session_answers')`,
  );
  return { tablesFound: row.n, applied: row.n === 4 };
}

async function applySchema() {
  // schema.sql is kept as the single source of truth and read at runtime;
  // vercel.json lists it under includeFiles so it ships with this function.
  const sql = await readFile(join(here, '..', 'backend', 'db', 'schema.sql'), 'utf8');
  const client = await getPool().connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

export default createHandler({
  async POST(req) {
    authorize(req);
    const q = getQuery(req);
    const action = (q.action ?? 'status').toLowerCase();

    if (action === 'status') {
      const schema = await schemaState();
      return {
        action,
        schema,
        pools: schema.applied ? await Promise.all(CATEGORIES.map((c) => poolStatus(c))) : [],
      };
    }

    if (action === 'migrate') {
      const before = await schemaState();
      await applySchema();
      const after = await schemaState();
      console.log(`[setup] migrate: ${before.tablesFound} -> ${after.tablesFound} core tables`);
      return {
        action,
        alreadyApplied: before.applied,
        schema: after,
        message: after.applied
          ? 'Tables are in place. Next: seed the question bank.'
          : 'The schema ran but the expected tables are still missing.',
      };
    }

    if (action === 'seed') {
      const category = (q.category ?? 'geography').toLowerCase();
      if (!CATEGORIES.includes(category)) {
        throw badRequest(`category must be one of: ${CATEGORIES.join(', ')}.`);
      }
      const schema = await schemaState();
      if (!schema.applied) {
        throw badRequest('Run the migrate step first — there are no tables to write into yet.');
      }

      const result = await refreshCategory(category, { force: true });
      console.log(`[setup] seed ${category}: ${JSON.stringify(result)}`);
      return {
        action,
        category,
        result,
        pools: await Promise.all(CATEGORIES.map((c) => poolStatus(c))),
      };
    }

    throw badRequest('Unknown action. Expected status, migrate or seed.');
  },
});
