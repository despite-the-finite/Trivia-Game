#!/usr/bin/env node
/**
 * Runs the content pipeline from the command line — useful for seeding a fresh
 * deployment and for inspecting why generations are being rejected.
 *
 *   npm run refresh                    refresh whatever is due
 *   npm run refresh -- --force         ignore freshness windows
 *   npm run refresh -- geography       one category only
 */
import { closePool } from '../backend/db/index.js';
import { assertConfigured, CATEGORIES } from '../backend/lib/config.js';
import { refreshCategory, refreshDueCategories, poolStatus } from '../backend/services/contentPipeline.js';
import { isLlmEnabled } from '../backend/services/llm.js';

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

  const results = category
    ? [await refreshCategory(category, { force })]
    : await refreshDueCategories({ force });

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
    console.log(`  ${cat.padEnd(18)} ${String(status.total).padStart(4)} live`);
  }
}

main()
  .catch((err) => {
    console.error('Refresh failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
