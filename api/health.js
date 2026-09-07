import { createHandler } from '../backend/lib/http.js';
import { queryOne } from '../backend/db/index.js';
import { APP, CATEGORIES, LLM, configProblems } from '../backend/lib/config.js';
import { poolStatus } from '../backend/services/contentPipeline.js';

/**
 * GET /api/health
 *
 * Used by the frontend on boot: if this reports `error`, the app shows the
 * "Trivia needs an internet connection" screen instead of a broken game.
 *
 * It doubles as the deployment's own status page, so it names what is missing
 * — a database that cannot be reached, an empty question bank, a scheduled
 * refresh that is switched off. It reports only whether each secret is
 * configured, never any part of its value.
 */
export default createHandler({
  async GET() {
    const started = Date.now();
    let database = 'ok';
    let schema = 'ok';
    let pools = [];

    // Reaching the database and having the tables in it are separate failures
    // with completely different fixes, so they are checked separately. Rolling
    // them together reports a fresh, correctly-configured deployment as a
    // connection error and sends the operator hunting for the wrong problem.
    try {
      await queryOne('SELECT 1');
    } catch (err) {
      // A connection diagnostic (host unreachable, TLS rejected, bad
      // credentials), never the credential itself.
      database = `error: ${err.message}`;
      schema = 'unknown';
    }

    if (database === 'ok') {
      try {
        pools = await Promise.all(CATEGORIES.map((c) => poolStatus(c)));
      } catch (err) {
        schema = /does not exist/i.test(err.message) ? 'missing' : `error: ${err.message}`;
      }
    }

    const totalQuestions = pools.reduce((sum, p) => sum + p.total, 0);
    const notes = configProblems();

    if (schema === 'missing') {
      notes.push(
        'The database is reachable but its tables have not been created yet. ' +
          'Open /setup.html and run step 1, or run `npm run migrate` locally.',
      );
    } else if (database === 'ok' && schema === 'ok' && totalQuestions === 0) {
      notes.push(
        'The question bank is empty. Open /setup.html and run step 2, ' +
          'or run `npm run refresh -- --force` locally.',
      );
    }
    if (!APP.cronSecret) {
      notes.push('CRON_SECRET is not set, so the scheduled content refresh is disabled.');
    }
    if (!LLM.enabled) {
      notes.push('ANTHROPIC_API_KEY is not set, so only Geography questions can be generated.');
    }

    return {
      status:
        database !== 'ok' || schema !== 'ok'
          ? 'error'
          : totalQuestions > 0
            ? 'ok'
            : 'degraded',
      database,
      schema,
      llmConfigured: LLM.enabled,
      cronConfigured: Boolean(APP.cronSecret),
      totalQuestions,
      pools,
      notes,
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    };
  },
});
