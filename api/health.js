import { createHandler } from '../backend/lib/http.js';
import { queryOne } from '../backend/db/index.js';
import { CATEGORIES, LLM } from '../backend/lib/config.js';
import { poolStatus } from '../backend/services/contentPipeline.js';

/**
 * GET /api/health
 *
 * Used by the frontend on boot: if this fails, the app shows the "Trivia needs
 * an internet connection" screen instead of a broken game.
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
      database = `error: ${err.message}`;
    }

    const totalQuestions = pools.reduce((sum, p) => sum + p.total, 0);

    return {
      status: database === 'ok' && totalQuestions > 0 ? 'ok' : database === 'ok' ? 'degraded' : 'error',
      database,
      llmConfigured: LLM.enabled,
      totalQuestions,
      pools,
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    };
  },
});
