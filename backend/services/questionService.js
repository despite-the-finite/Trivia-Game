import { queryRows } from '../db/index.js';
import { CATEGORIES, FRESHNESS } from '../lib/config.js';
import { shuffle } from '../lib/ids.js';

/**
 * questionService — reads from the validated question bank and shapes records
 * for the wire.
 *
 * Two shapes exist and the difference is the whole anti-cheat story:
 *   * play shape    — id, question, answers, category. No answer.
 *   * full shape    — everything, including correctAnswer and explanation.
 * The play shape is what a browser gets before it submits an answer.
 */

export function isCategory(value) {
  return CATEGORIES.includes(value);
}

/**
 * Selects a random slice of the live bank.
 *
 * `ORDER BY random()` is fine at this table size and gives genuinely varied
 * sets; we bias toward fresher questions by scoping to non-expired rows and
 * lightly preferring the less-served ones so the bank gets even coverage.
 */
export async function pickQuestions({
  category,
  count = 10,
  excludeIds = [],
  difficulty = null,
} = {}) {
  if (count <= 0) return [];
  const params = [[category], count, excludeIds.length ? excludeIds : null, difficulty];

  const rows = await queryRows(
    `SELECT id, category, question, answers, correct_index, explanation,
            source, source_url, source_published_at, generated_at, expires_at, difficulty
       FROM questions
      WHERE active
        AND expires_at > NOW()
        AND category = ANY($1)
        AND ($3::uuid[] IS NULL OR NOT (id = ANY($3)))
        AND ($4::text IS NULL OR difficulty = $4)
      ORDER BY (times_served <= (SELECT COALESCE(MIN(times_served), 0) + 2
                                   FROM questions
                                  WHERE active AND expires_at > NOW() AND category = ANY($1))) DESC,
               random()
      LIMIT $2`,
    params,
  );

  return rows;
}

const DIFFICULTIES = ['easy', 'medium', 'hard'];

/**
 * Share of each quiz drawn from each tier. Weighted toward easy on purpose: a
 * day's quiz should feel winnable, with one or two genuine stretch questions
 * rather than a third of the set being hard.
 */
export const DIFFICULTY_MIX = { easy: 0.5, medium: 0.35, hard: 0.15 };

/**
 * Splits `count` across DIFFICULTIES by DIFFICULTY_MIX (largest-remainder, so
 * the shares always sum to `count`). Ties go to the easier tier.
 */
export function difficultyShares(count) {
  const exact = DIFFICULTIES.map((d) => count * DIFFICULTY_MIX[d]);
  const shares = exact.map(Math.floor);
  let remaining = count - shares.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, i) => ({ i, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (const { i } of byRemainder) {
    if (remaining <= 0) break;
    shares[i] += 1;
    remaining -= 1;
  }
  return shares;
}

/**
 * Picks `count` questions from one category following DIFFICULTY_MIX. A tier
 * that is running short is topped up from the next-easiest tier first, then
 * from anything, so a thin bank never makes the quiz harder than it has to be.
 */
async function pickDifficultyBalanced({ category, count, excludeIds = [] }) {
  const used = new Set(excludeIds);
  const collected = [];
  const shares = difficultyShares(count);

  for (const [i, difficulty] of DIFFICULTIES.entries()) {
    if (!shares[i]) continue;
    const rows = await pickQuestions({ category, count: shares[i], excludeIds: [...used], difficulty });
    for (const row of rows) {
      used.add(row.id);
      collected.push(row);
    }
  }

  for (const difficulty of [...DIFFICULTIES, null]) {
    if (collected.length >= count) break;
    const filler = await pickQuestions({
      category,
      count: count - collected.length,
      excludeIds: [...used],
      difficulty,
    });
    for (const row of filler) {
      used.add(row.id);
      collected.push(row);
    }
  }

  return shuffle(collected).slice(0, count);
}

/** Builds a category's set with an even spread across difficulty. */
export async function pickBalancedSet({ category, count, excludeIds = [] }) {
  return pickDifficultyBalanced({ category, count, excludeIds });
}

export async function getQuestionsByIds(ids) {
  if (!ids?.length) return [];
  const rows = await queryRows(
    `SELECT id, category, question, answers, correct_index, explanation,
            source, source_url, source_published_at, generated_at, expires_at
       FROM questions
      WHERE id = ANY($1)`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Produces a permutation per question mapping display position -> canonical
 * index. Storing the permutation (rather than the shuffled answers) means the
 * same question can be presented in a different order to different players
 * while the stored correct index stays authoritative — and lets a day's fixed
 * quiz replay the exact same ordering for everyone who plays it.
 */
export function buildAnswerOrders(questions, rng = Math.random) {
  const orders = {};
  for (const q of questions) {
    const indices = q.answers.map((_, i) => i);
    orders[q.id] = shuffle(indices, rng);
  }
  return orders;
}

const displayAnswers = (question, order) =>
  (order ?? question.answers.map((_, i) => i)).map((canonicalIndex) => question.answers[canonicalIndex]);

/** Wire shape sent to the browser BEFORE the player answers. No correct answer. */
export function toPlayShape(question, order, position) {
  return {
    id: question.id,
    position,
    category: question.category,
    question: question.question,
    answers: displayAnswers(question, order),
  };
}

/** Full record. Only returned to authenticated server-to-server callers. */
export function toFullShape(question, order = null) {
  const answers = displayAnswers(question, order);
  const correctDisplayIndex = (order ?? question.answers.map((_, i) => i)).indexOf(
    question.correct_index,
  );
  return {
    id: question.id,
    category: question.category,
    question: question.question,
    answers,
    correctAnswer: answers[correctDisplayIndex],
    correctIndex: correctDisplayIndex,
    explanation: question.explanation,
    source: question.source,
    sourceUrl: question.source_url,
    sourcePublishedAt: question.source_published_at,
    generatedAt: question.generated_at,
    expiresAt: question.expires_at,
  };
}

/** Metadata about a question's provenance, safe to reveal after answering. */
export function toRevealShape(question, order) {
  const canonicalOrder = order ?? question.answers.map((_, i) => i);
  return {
    correctIndex: canonicalOrder.indexOf(question.correct_index),
    correctAnswer: question.answers[question.correct_index],
    explanation: question.explanation,
    source: question.source,
    sourceUrl: question.source_url,
    sourcePublishedAt: question.source_published_at,
  };
}

export function ttlForCategory(category) {
  return FRESHNESS[category]?.ttlMs ?? FRESHNESS.geography.ttlMs;
}

export async function markServed(ids) {
  if (!ids?.length) return;
  try {
    await queryRows('UPDATE questions SET times_served = times_served + 1 WHERE id = ANY($1)', [ids]);
  } catch (err) {
    console.warn('[questionService] failed to bump times_served:', err.message);
  }
}
