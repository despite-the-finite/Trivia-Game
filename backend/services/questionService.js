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
  category = 'mixed',
  count = 10,
  excludeIds = [],
} = {}) {
  const categories = category === 'mixed' ? CATEGORIES : [category];
  const params = [categories, count, excludeIds.length ? excludeIds : null];

  const rows = await queryRows(
    `SELECT id, category, question, answers, correct_index, explanation,
            source, source_url, source_published_at, generated_at, expires_at
       FROM questions
      WHERE active
        AND expires_at > NOW()
        AND category = ANY($1)
        AND ($3::uuid[] IS NULL OR NOT (id = ANY($3)))
      ORDER BY (times_served <= (SELECT COALESCE(MIN(times_served), 0) + 2
                                   FROM questions
                                  WHERE active AND expires_at > NOW() AND category = ANY($1))) DESC,
               random()
      LIMIT $2`,
    params,
  );

  return rows;
}

/**
 * Builds a balanced mixed set: for `mixed` we want an even spread across
 * categories rather than whatever the bank happens to be heaviest in.
 */
export async function pickBalancedSet({ category, count, excludeIds = [] }) {
  if (category !== 'mixed') {
    return pickQuestions({ category, count, excludeIds });
  }

  const perCategory = Math.ceil(count / CATEGORIES.length);
  const collected = [];
  const used = new Set(excludeIds);

  for (const cat of shuffle(CATEGORIES)) {
    const rows = await pickQuestions({
      category: cat,
      count: perCategory,
      excludeIds: [...used],
    });
    for (const row of rows) {
      used.add(row.id);
      collected.push(row);
    }
  }

  // Top up from anywhere if a category was short.
  if (collected.length < count) {
    const filler = await pickQuestions({
      category: 'mixed',
      count: count - collected.length,
      excludeIds: [...used],
    });
    collected.push(...filler);
  }

  return shuffle(collected).slice(0, count);
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
 * while the stored correct index stays authoritative — and lets a challenge
 * replay the exact same ordering for both participants.
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
