#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { collect } from '../backend/providers/offlineGeographyProvider.js';
import { buildGeographyQuestions } from '../backend/services/geographyTemplates.js';
import { validateBatch } from '../backend/services/questionValidator.js';
import { seededRandom, shuffle } from '../backend/lib/ids.js';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * build-bank — generates the question bank the browser plays offline.
 *
 * The live pipeline calls providers, hands source material to a model, validates
 * the result and writes it to Postgres. This does the same thing minus the
 * network and the model: it runs the *same* geography templates over packaged
 * datasets, adds a curated settled-science set, and puts both through the *same*
 * questionValidator the live pipeline gates on. A question that would be
 * rejected in production is rejected here.
 *
 * Output is deterministic: the same inputs and seed produce a byte-identical
 * bank, so a rebuild shows up in review as a real content change or not at all.
 *
 *   npm run build:bank [-- --seed=<string>] [--geography=<n>]
 */

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const SEED = args.get('seed') ?? 'live-trivia-offline-bank-v1';
/**
 * Geography questions to keep per difficulty.
 *
 * The templates generate over a thousand candidates, but they skew hard: most
 * countries are low-prominence, and several templates bump difficulty a step. A
 * bank in that natural ratio would hand a new player a wall of obscure currency
 * questions, so each difficulty is filled to its own quota instead.
 */
const GEOGRAPHY_PER_DIFFICULTY = Number.parseInt(args.get('geography') ?? '120', 10);

/**
 * Topics excluded from the offline bank.
 *
 * `population:` asks which of four countries is most populous and explains the
 * answer with a specific headcount. Populations move; a number frozen into a
 * static file slowly becomes wrong, and the whole point of this project is not
 * shipping stale facts. Land area, capitals, borders, currencies, elevations and
 * river lengths do not have that problem, so those templates stay.
 */
const EXCLUDED_TOPIC_PREFIXES = ['population'];

/**
 * Fills `quota` items from `items`, cycling through topic families rather than
 * taking the first N. Without this, "hard" fills up with capital-of and currency
 * questions purely because those templates produce the most candidates.
 */
function roundRobinByTopic(items, quota, rng) {
  const families = new Map();
  for (const item of items) {
    const family = item.topic.split(':')[0];
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(item);
  }

  const queues = shuffle([...families.values()], rng).map((group) => shuffle(group, rng));
  const picked = [];
  let cursor = 0;
  while (picked.length < quota && queues.some((q) => q.length)) {
    const queue = queues[cursor % queues.length];
    if (queue.length) picked.push(queue.shift());
    cursor += 1;
  }
  return picked;
}

/** Stable id for a question, so rebuilding does not churn every id. */
function stableId(category, question, correctAnswer) {
  const hex = createHash('sha256').update(`${category}|${question}|${correctAnswer}`).digest('hex');
  // Formatted as a UUID so offline records are shaped like the database's.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

function buildGeography(rng) {
  const documents = collect();
  const records = documents.flatMap((doc) => doc.facts.records);

  const countriesDoc = documents.find((d) => d.facts.datasetId === 'world-countries');
  const physicalDoc = documents.find((d) => d.facts.datasetId === 'physical-geography');
  // Peaks and rivers come from the physical dataset; everything else is country
  // reference data. Citing the document the facts actually came from is what
  // lets the validator's source check mean something.
  const documentFor = (topic) =>
    /^(peak|river)/.test(topic) ? physicalDoc : countriesDoc;

  // Ask for far more than we keep: the templates are the cheap part, and a wide
  // pool is what makes the per-difficulty quotas below fillable.
  const generated = buildGeographyQuestions(records, rng, Number.MAX_SAFE_INTEGER).filter(
    (q) => !EXCLUDED_TOPIC_PREFIXES.some((prefix) => q.topic.startsWith(`${prefix}:`)),
  );

  const selected = ['easy', 'medium', 'hard'].flatMap((difficulty) =>
    roundRobinByTopic(
      generated.filter((q) => q.difficulty === difficulty),
      GEOGRAPHY_PER_DIFFICULTY,
      rng,
    ),
  );

  return selected.map((q) => {
    const doc = documentFor(q.topic);
    return {
      category: 'geography',
      difficulty: q.difficulty,
      question: q.question,
      answers: shuffle([q.correctAnswer, ...q.distractors], rng),
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      source: doc.sourceName,
      sourceUrl: doc.url,
    };
  });
}

function buildScience(rng) {
  const { sources, questions } = require('../backend/data/evergreen-science.json');

  return shuffle(questions, rng).map((q) => {
    const source = sources[q.source];
    if (!source) throw new Error(`Unknown source key "${q.source}" in evergreen-science.json`);
    return {
      category: 'science',
      difficulty: q.difficulty,
      question: q.question,
      answers: shuffle([q.correctAnswer, ...q.distractors], rng),
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      source: source.name,
      sourceUrl: source.url,
    };
  });
}

function main() {
  const rng = seededRandom(SEED);

  const candidates = [...buildGeography(rng), ...buildScience(rng)];
  const allowedSourceUrls = new Set(candidates.map((c) => c.sourceUrl));

  const { accepted, rejected } = validateBatch(candidates, {
    allowedSourceUrls,
    requireSource: true,
  });

  const bank = accepted.map((q) => ({
    id: stableId(q.category, q.question, q.correctAnswer),
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    answers: q.answers,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    source: q.source,
    sourceUrl: q.sourceUrl,
  }));

  const ids = new Set(bank.map((q) => q.id));
  if (ids.size !== bank.length) throw new Error('Question id collision in the generated bank.');

  const byCategory = {};
  const byDifficulty = {};
  for (const q of bank) {
    byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] ?? 0) + 1;
  }

  const output = {
    version: 1,
    seed: SEED,
    note:
      'Generated by scripts/build-bank.js. Geography is produced by the same deterministic ' +
      'templates the live pipeline uses; Science is a curated settled-science set. Both are ' +
      'gated by the same questionValidator. Current Events is deliberately absent — it cannot ' +
      'be pre-baked without going stale, so it needs the live backend.',
    categories: Object.keys(byCategory).sort(),
    counts: { total: bank.length, byCategory, byDifficulty },
    questions: bank,
  };

  const outPath = resolve(root, 'public/data/question-bank.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(output)}\n`);

  const rejectionReasons = {};
  for (const r of rejected) {
    for (const reason of r.reasons) rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }

  console.log(`Wrote ${bank.length} questions to public/data/question-bank.json`);
  console.log(`  by category:   ${JSON.stringify(byCategory)}`);
  console.log(`  by difficulty: ${JSON.stringify(byDifficulty)}`);
  console.log(`  rejected:      ${rejected.length}${rejected.length ? ` ${JSON.stringify(rejectionReasons)}` : ''}`);
}

main();
