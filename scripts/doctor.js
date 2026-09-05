#!/usr/bin/env node
/**
 * Pre-flight check. Answers "is this environment actually set up correctly?"
 * before you find out from a failing deployment.
 *
 *   npm run doctor
 *
 * Run it locally after filling in `.env`, and again with the production
 * DATABASE_URL in your shell before you run `npm run migrate` against it.
 * It never prints a secret — only whether one is present.
 */
import { loadDotEnv } from './load-env.js';

await loadDotEnv();

const { APP, LLM, CATEGORIES, configProblems } = await import('../backend/lib/config.js');
const { queryOne, closePool } = await import('../backend/db/index.js');
const { poolStatus } = await import('../backend/services/contentPipeline.js');

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

let failures = 0;

console.log('\nEnvironment');

if (APP.databaseUrl) {
  // Never print the connection string: it contains the database password.
  try {
    const url = new URL(APP.databaseUrl);
    ok(`DATABASE_URL is set (host ${url.hostname}, database ${url.pathname.slice(1) || '?'})`);
    if (/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      warn('DATABASE_URL points at localhost — that is fine locally, but Vercel cannot reach it.');
    }
    if (!/pool|pgbouncer/i.test(APP.databaseUrl) && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      warn('This does not look like a pooled connection string. Serverless deployments should use one.');
    }
  } catch {
    bad('DATABASE_URL is set but is not a valid URL.');
    failures += 1;
  }
} else {
  bad('DATABASE_URL is not set.');
  failures += 1;
}

if (LLM.enabled) ok(`ANTHROPIC_API_KEY is set (model ${LLM.model})`);
else warn('ANTHROPIC_API_KEY is not set — only Geography questions can be generated.');

if (APP.cronSecret) {
  ok('CRON_SECRET is set.');
  if (APP.cronSecret.length < 16) {
    warn('CRON_SECRET is short. Use at least 32 random characters.');
  }
} else {
  warn('CRON_SECRET is not set — the scheduled refresh endpoint will refuse every call.');
}

if (APP.publicUrl) ok(`PUBLIC_BASE_URL is ${APP.publicUrl}`);
else ok('PUBLIC_BASE_URL is not set — share links will use the origin each request arrives on.');

for (const problem of configProblems()) {
  bad(problem);
  failures += 1;
}

console.log('\nDatabase');
if (APP.databaseUrl) {
  try {
    const row = await queryOne('SELECT current_database() AS db, version() AS version');
    ok(`Connected to ${row.db} (${row.version.split(',')[0]})`);

    const tables = await queryOne(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('players','questions','game_sessions')`,
    );
    if (tables.n === 3) {
      ok('Schema is applied.');
      console.log('\nQuestion bank');
      let total = 0;
      for (const category of CATEGORIES) {
        const status = await poolStatus(category);
        total += status.total;
        console.log(`  ${category.padEnd(16)} ${String(status.total).padStart(4)} live questions`);
      }
      if (total === 0) {
        warn('The bank is empty. Run `npm run refresh -- --force` before playing.');
      } else {
        ok(`${total} questions available.`);
      }
    } else {
      bad('Schema is not applied. Run `npm run migrate`.');
      failures += 1;
    }
  } catch (err) {
    bad(`Could not connect: ${err.message}`);
    if (/self.signed|certificate/i.test(err.message)) {
      console.log(
        '    The database presented a certificate that could not be verified. If you trust the\n' +
          '    provider, add ?sslmode=no-verify to DATABASE_URL or set PGSSL_NO_VERIFY=1.',
      );
    }
    failures += 1;
  }
}

await closePool();

console.log('');
if (failures) {
  console.log(`${failures} problem(s) must be fixed before this will work in production.\n`);
  process.exitCode = 1;
} else {
  console.log('No blocking problems found.\n');
}
