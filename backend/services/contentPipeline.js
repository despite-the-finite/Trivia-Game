import { query, queryOne, queryRows, withTransaction, withAdvisoryLock, lockKey } from '../db/index.js';
import { CATEGORIES, CRON, FRESHNESS, IS_SERVERLESS } from '../lib/config.js';
import newsProvider from '../providers/newsProvider.js';
import scienceProvider from '../providers/scienceProvider.js';
import geographyProvider from '../providers/geographyProvider.js';
import { generateFromDocuments, generateGeography } from './questionGenerator.js';
import { isLlmEnabled } from './llm.js';

/**
 * contentPipeline — keeps the question bank fresh.
 *
 * Flow per category:
 *   1. collect factual source material from the provider
 *   2. persist those documents (URL, publisher, publication date, facts)
 *   3. hand the facts to the generator
 *   4. validate every candidate
 *   5. store accepted questions with their provenance and an expiry
 *
 * Players never trigger this synchronously. `/api/trivia` and `/api/session`
 * serve from the bank; if the bank is running low they kick off a refresh in
 * the background and serve what is already there.
 */

const PROVIDERS = {
  'current-events': newsProvider,
  science: scienceProvider,
  geography: geographyProvider,
};

/** Guards against two instances refreshing the same category at once. */
const inFlight = new Map();

/**
 * Background refreshes run one at a time, process-wide. Each holds a database
 * connection for its advisory lock across several seconds of upstream network
 * I/O; letting all three categories run concurrently starves the pool that
 * player requests are served from.
 */
let backgroundChain = Promise.resolve();

/**
 * Keeps a serverless invocation alive for work started after the response was
 * sent.
 *
 * On a long-lived server a dangling promise simply runs. On Vercel the instance
 * is frozen the moment the response finishes, so a fire-and-forget refresh would
 * be suspended mid-flight — leaving a half-written run, a held database
 * connection and nothing in the logs to explain it. The platform exposes a
 * `waitUntil` on its per-request context for exactly this; when it is not there
 * (local dev, tests, another host) the promise is left to run normally, which is
 * the correct behaviour off-platform.
 *
 * @returns {boolean} whether the platform is now holding the invocation open.
 */
export function keepAlive(promise) {
  try {
    const context = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    if (typeof context?.waitUntil === 'function') {
      context.waitUntil(promise);
      return true;
    }
  } catch {
    /* No request context available; fall through. */
  }
  return false;
}

export async function poolStatus(category) {
  const row = await queryOne(
    `SELECT
        COUNT(*)::int                                             AS total,
        COUNT(*) FILTER (WHERE difficulty = 'easy')::int          AS easy,
        COUNT(*) FILTER (WHERE difficulty = 'medium')::int        AS medium,
        COUNT(*) FILTER (WHERE difficulty = 'hard')::int          AS hard,
        MAX(generated_at)                                         AS newest
       FROM questions
      WHERE category = $1 AND active AND expires_at > NOW()`,
    [category],
  );
  const lastRun = await queryOne(
    `SELECT started_at, status FROM refresh_runs
      WHERE category = $1 AND status <> 'error'
      ORDER BY started_at DESC LIMIT 1`,
    [category],
  );
  return {
    category,
    total: row?.total ?? 0,
    byDifficulty: { easy: row?.easy ?? 0, medium: row?.medium ?? 0, hard: row?.hard ?? 0 },
    newest: row?.newest ?? null,
    lastRefreshAt: lastRun?.started_at ?? null,
  };
}

/**
 * True when the bank for `category` is stale or thin enough to warrant a
 * refresh. Freshness thresholds differ per category — see FRESHNESS in config.
 */
export async function needsRefresh(category) {
  const policy = FRESHNESS[category];
  const status = await poolStatus(category);
  if (status.total < Math.max(policy.targetPool * 0.4, 20)) return true;
  if (!status.lastRefreshAt) return true;
  return Date.now() - new Date(status.lastRefreshAt).valueOf() >= policy.refreshEveryMs;
}

async function persistSourceDocuments(client, documents) {
  const stored = [];
  for (const doc of documents) {
    const { rows } = await client.query(
      `INSERT INTO source_documents (provider, category, title, url, source_name, published_at, facts, checksum)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (checksum) DO UPDATE SET fetched_at = NOW()
         RETURNING id`,
      [
        doc.provider,
        doc.category,
        doc.title,
        doc.url,
        doc.sourceName,
        doc.publishedAt ?? null,
        JSON.stringify(doc.facts),
        doc.checksum,
      ],
    );
    stored.push({ ...doc, id: rows[0].id });
  }
  return stored;
}

async function storeQuestions(client, questions, { category, ttlMs }) {
  const expiresAt = new Date(Date.now() + ttlMs);
  let inserted = 0;

  for (const q of questions) {
    const { rowCount } = await client.query(
      `INSERT INTO questions
         (category, difficulty, question, answers, correct_index, explanation,
          source, source_url, source_published_at, source_document_id,
          generator, expires_at, fingerprint)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [
        category,
        q.difficulty,
        q.question,
        JSON.stringify(q.answers),
        q.correctIndex,
        q.explanation,
        q.source,
        q.sourceUrl || '',
        q.sourcePublishedAt ?? null,
        q.sourceDocumentId ?? null,
        q.generator ?? 'llm',
        expiresAt,
        q.fingerprint,
      ],
    );
    inserted += rowCount;
  }
  return inserted;
}

async function recordRejections(client, category, rejected) {
  for (const { candidate, reasons } of rejected.slice(0, 50)) {
    await client.query(
      'INSERT INTO rejected_questions (category, payload, reasons) VALUES ($1, $2::jsonb, $3)',
      [category, JSON.stringify(candidate ?? {}), reasons],
    );
  }
}

/**
 * Runs one refresh cycle for a category. Serialised across instances by a
 * Postgres advisory lock so we never pay for the same batch twice.
 */
export async function refreshCategory(category, { force = false } = {}) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }

  const lock = lockKey(`refresh:${category}`);
  const { acquired, result } = await withAdvisoryLock(lock, async () => {
    if (!force && !(await needsRefresh(category))) {
      return { skipped: true, reason: 'fresh' };
    }

    const policy = FRESHNESS[category];
    const provider = PROVIDERS[category];

    const run = await queryOne(
      'INSERT INTO refresh_runs (category) VALUES ($1) RETURNING id',
      [category],
    );

    try {
      const documents = await provider.collect({ limit: policy.batchSize });
      if (!documents.length) throw new Error(`${provider.name} returned no usable source material`);

      const storedDocs = await withTransaction((client) =>
        persistSourceDocuments(client, documents),
      );

      // Skip questions we already have, so a refresh adds new material rather
      // than re-generating the same facts.
      const existing = await queryRows(
        'SELECT fingerprint FROM questions WHERE category = $1 AND active',
        [category],
      );
      const seenFingerprints = new Set(existing.map((r) => r.fingerprint));

      const generated =
        category === 'geography'
          ? await generateGeography(storedDocs, {
              count: policy.batchSize,
              seenFingerprints,
            })
          : await generateFromDocuments(storedDocs, {
              category,
              count: policy.batchSize,
              seenFingerprints,
            });

      const inserted = await withTransaction(async (client) => {
        const n = await storeQuestions(client, generated.accepted, {
          category,
          ttlMs: policy.ttlMs,
        });
        await recordRejections(client, category, generated.rejected);
        return n;
      });

      await query(
        `UPDATE refresh_runs
            SET finished_at = NOW(), status = 'ok', sources_fetched = $2,
                generated = $3, accepted = $4, rejected = $5
          WHERE id = $1`,
        [run.id, storedDocs.length, generated.generated, inserted, generated.rejected.length],
      );

      // Retire anything past its freshness window.
      await query(
        'UPDATE questions SET active = FALSE WHERE category = $1 AND active AND expires_at <= NOW()',
        [category],
      );

      return {
        skipped: false,
        category,
        sourcesFetched: storedDocs.length,
        generated: generated.generated,
        accepted: inserted,
        rejected: generated.rejected.length,
        rejectionReasons: summariseRejections(generated.rejected),
      };
    } catch (err) {
      await query(
        `UPDATE refresh_runs SET finished_at = NOW(), status = 'error', error = $2 WHERE id = $1`,
        [run.id, err.message.slice(0, 500)],
      );
      throw err;
    }
  });

  if (!acquired) return { skipped: true, reason: 'locked-by-another-instance', category };
  return result;
}

function summariseRejections(rejected) {
  const counts = {};
  for (const { reasons } of rejected) {
    for (const reason of reasons) {
      const key = reason.split(':')[0];
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Fire-and-forget refresh used from read paths. Never awaited by a player
 * request and never allowed to surface an error to one.
 */
export function refreshInBackground(category) {
  if (inFlight.has(category)) return inFlight.get(category);

  const promise = backgroundChain
    .then(() => refreshCategory(category))
    .catch((err) => {
      console.warn(`[contentPipeline] background refresh for ${category} failed: ${err.message}`);
      return null;
    })
    .finally(() => inFlight.delete(category));

  inFlight.set(category, promise);
  // Keep the chain alive regardless of this run's outcome.
  backgroundChain = promise.then(
    () => undefined,
    () => undefined,
  );

  const held = keepAlive(promise);
  if (IS_SERVERLESS && !held) {
    // The platform will not hold the invocation open, so this run would be
    // frozen part-way through. Say so once: the scheduled refresh is then the
    // only thing keeping the bank fresh, and that is worth seeing in the logs.
    console.warn(
      `[contentPipeline] on-demand refresh for ${category} may be suspended when the response ends; ` +
        'the scheduled /api/cron/refresh run is the reliable path.',
    );
  }
  return promise;
}

/**
 * Orders categories by how overdue they are, most urgent first, so a run that
 * can only afford one category spends it on the one that needs it most.
 */
export async function categoriesByUrgency(categories = CATEGORIES) {
  const scored = await Promise.all(
    categories.map(async (category) => {
      const policy = FRESHNESS[category];
      const status = await poolStatus(category);
      const thin = Math.max(policy.targetPool * 0.4, 20);
      // An empty or thin bank always outranks a merely stale one: a category
      // with nothing in it is a category players cannot play.
      const starvation = status.total >= thin ? 0 : (thin - status.total) / thin;
      const age = status.lastRefreshAt
        ? Date.now() - new Date(status.lastRefreshAt).valueOf()
        : Number.POSITIVE_INFINITY;
      const overdue = age / policy.refreshEveryMs;
      return { category, urgency: starvation * 10 + Math.min(overdue, 10), overdue, total: status.total };
    }),
  );
  return scored.sort((a, b) => b.urgency - a.urgency);
}

/**
 * Refresh the categories whose policy says they are due, most urgent first.
 *
 * `limit` exists because each category costs an upstream fetch plus a model
 * call, and a serverless invocation has a hard wall-clock ceiling. Doing one
 * category per scheduled run and letting the next run take the next one keeps
 * every invocation comfortably inside that ceiling. Used by the cron job.
 */
export async function refreshDueCategories({ force = false, limit = CRON.categoriesPerRun } = {}) {
  const results = [];
  const ordered = await categoriesByUrgency();
  let ran = 0;

  for (const { category } of ordered) {
    if (category !== 'geography' && !isLlmEnabled()) {
      results.push({ category, skipped: true, reason: 'llm-not-configured' });
      continue;
    }
    if (Number.isFinite(limit) && ran >= limit) {
      results.push({ category, skipped: true, reason: 'deferred-to-next-run' });
      continue;
    }
    if (!force && !(await needsRefresh(category))) {
      results.push({ category, skipped: true, reason: 'fresh' });
      continue;
    }

    ran += 1;
    try {
      results.push(await refreshCategory(category, { force }));
    } catch (err) {
      console.error(`[contentPipeline] refresh for ${category} failed: ${err.message}`);
      results.push({ category, error: err.message });
    }
  }
  return results;
}
