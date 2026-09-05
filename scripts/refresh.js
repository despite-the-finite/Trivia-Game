#!/usr/bin/env node
/**
 * Runs the content pipeline from the command line — useful for seeding a fresh
 * deployment and for inspecting why generations are being rejected.
 *
 *   npm run refresh                        refresh whatever is due
 *   npm run refresh -- --force             ignore freshness windows
 *   npm run refresh -- geography           one category only
 *   npm run refresh -- geography --force   one category, ignoring freshness
 *
 * Valid categories are current-events, science and geography. This is how a new
 * deployment gets its first questions: point DATABASE_URL at the production
 * database and run it from your own machine, where nothing times out.
 */
import { loadDotEnv } from './load-env.js';

// Must happen before the config module reads process.env.
await loadDotEnv();

const { closePool } = await import('../backend/db/index.js');
const { assertConfigured, CATEGORIES } = await import('../backend/lib/config.js');
const { refreshCategory, refreshDueCategories, poolStatus } = await import(
  '../backend/services/contentPipeline.js'
);
const { isLlmEnabled } = await import('../backend/services/llm.js');

async function main() {
  assertConfigured();

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const category = args.find((a) => CATEGORIES.includes(a));

  if (!isLlmEnabled()) {
    console.warn(
      'ANTHROPIC_API_KEY is not set — only geography (structured data + templates) can be generated.\n',
    );
  }

  // From the command line there is no function time limit, so a seed run may do
  // every due category in one go — unlike the scheduled endpoint, which paces
  // itself to stay inside the serverless ceiling.
  const results = category
    ? [await refreshCategory(category, { force })]
    : await refreshDueCategories({ force, limit: Number.POSITIVE_INFINITY });

  for (const r of results) {
    if (r?.error) console.error(`  ${r.category}: ERROR ${r.error}`);
    else if (r?.skipped) console.log(`  ${r.category ?? category}: skipped (${r.reason})`);
    else {
      console.log(
        `  ${r.category}: ${r.accepted} accepted / ${r.generated} generated ` +
          `from ${r.sourcesFetched} sources (${r.rejected} rejected)`,
      );
      if (r.rejected) console.log(`     rejection reasons: ${JSON.stringify(r.rejectionReasons)}`);
    }
  }

  console.log('\nQuestion bank:');
  for (const cat of CATEGORIES) {
    const status = await poolStatus(cat);
    console.log(
      `  ${cat.padEnd(16)} ${String(status.total).padStart(4)} live ` +
        `(easy ${status.byDifficulty.easy}, medium ${status.byDifficulty.medium}, hard ${status.byDifficulty.hard})`,
    );
  }
}

main()
  .catch((err) => {
    console.error('Refresh failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
