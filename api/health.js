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
    let pools = [];

    try {
      await queryOne('SELECT 1');
      pools = await Promise.all(CATEGORIES.map((c) => poolStatus(c)));
    } catch (err) {
      // The message here is a connection diagnostic (host unreachable, TLS
      // rejected, database missing), not a credential.
      database = `error: ${err.message}`;
    }

    const totalQuestions = pools.reduce((sum, p) => sum + p.total, 0);
    const notes = configProblems();
    if (database === 'ok' && totalQuestions === 0) {
      notes.push('The question bank is empty. Run `npm run refresh -- --force` to populate it.');
    }
    if (!APP.cronSecret) {
      notes.push('CRON_SECRET is not set, so the scheduled content refresh is disabled.');
    }
    if (!LLM.enabled) {
      notes.push('ANTHROPIC_API_KEY is not set, so only Geography questions can be generated.');
    }

    return {
      status:
        database !== 'ok' ? 'error' : totalQuestions > 0 ? 'ok' : 'degraded',
      database,
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
