import { generateJson, isLlmEnabled } from './llm.js';
import { buildGeographyQuestions } from './geographyTemplates.js';
import { validateBatch, fingerprint } from './questionValidator.js';
import { CATEGORY_LABELS } from '../lib/config.js';

/**
 * questionGenerator — turns source material into candidate questions.
 *
 * The hard rule: the model is never asked what is true. It is handed a bundle
 * of facts that were fetched from a named source and told to write questions
 * that can be answered from that bundle alone. For geography the model does not
 * even determine the answer — templates do, from structured data.
 */

const SYSTEM_PROMPT = `You write factual multiple-choice trivia questions for a live trivia game.

You will be given a numbered list of SOURCE DOCUMENTS. Each has an id, a publisher, a publication date, a URL, and factual material.

Absolute rules:
1. Use ONLY the supplied source material. Do not use anything you know from training, and do not infer facts that are not stated.
2. If a document does not contain a clean, checkable fact, skip it. Producing fewer good questions is always better than padding.
3. Every question must have exactly one objectively correct answer that a knowledgeable person would not dispute.
4. Provide exactly four answer options. The three wrong options must be plausible, of similar length and specificity to the correct one, and clearly wrong given the source.
5. The question must stand on its own. A player cannot see the source, so never write "according to the article", "the report says", "the passage", or similar.
6. Never use relative dates ("yesterday", "today", "last night"). Use absolute dates or no date.
7. Avoid anything opinion-based, speculative, rumoured, predictive, or a politically contested interpretation. Prefer who/what/where/how-many facts that were reported as settled.
8. Never use "all of the above", "none of the above", or similar meta-options.
9. Set sourceId to the id of the single document the question came from.
10. The explanation is one or two sentences stating the fact plainly, without referring to the source document as a document.

Difficulty guidance:
- easy: the central fact of a widely covered story.
- medium: a specific named detail (a number, a place, a title, a role).
- hard: a precise secondary detail that a careful reader would retain.`;

const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceId', 'difficulty', 'question', 'answers', 'correctAnswer', 'explanation'],
        properties: {
          sourceId: { type: 'integer' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
          question: { type: 'string' },
          answers: { type: 'array', items: { type: 'string' } },
          correctAnswer: { type: 'string' },
          explanation: { type: 'string' },
        },
      },
    },
  },
};

function renderDocuments(documents) {
  return documents
    .map((doc, index) => {
      const facts = doc.facts ?? {};
      return [
        `--- SOURCE DOCUMENT ${index + 1} ---`,
        `id: ${index + 1}`,
        `publisher: ${doc.sourceName}`,
        `published: ${doc.publishedAt ? new Date(doc.publishedAt).toISOString().slice(0, 10) : 'unknown'}`,
        `url: ${doc.url}`,
        `headline: ${facts.headline ?? doc.title}`,
        `factual material: ${facts.summary ?? ''}`,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * Generate questions from news/science source documents using the LLM.
 *
 * @param {Array} documents Source documents (already persisted or about to be).
 * @param {object} options
 * @param {Function} [options.generate] Override the model call (used by tests).
 * @returns {Promise<{accepted: Array, rejected: Array, generated: number}>}
 */
export async function generateFromDocuments(
  documents,
  { category, count, seenFingerprints, generate = generateJson } = {},
) {
  if (generate === generateJson && !isLlmEnabled()) {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured, so news and science questions cannot be generated.',
    );
  }
  if (!documents.length) {
    return { accepted: [], rejected: [], generated: 0 };
  }

  const label = CATEGORY_LABELS[category] ?? category;
  const prompt = [
    `Category: ${label}`,
    `Write up to ${count} questions total, at most 2 per source document, spread across easy, medium and hard.`,
    '',
    renderDocuments(documents),
    '',
    'Return the questions as JSON.',
  ].join('\n');

  const { data } = await generate({
    system: SYSTEM_PROMPT,
    prompt,
    schema: QUESTION_SCHEMA,
    // Generation is a batch job whose output is validated anyway; medium effort
    // is the right cost/quality point here.
    effort: 'medium',
  });

  const raw = Array.isArray(data?.questions) ? data.questions : [];

  // Attach provenance from OUR record of the document, never from the model's
  // own claim about a URL.
  const withSources = raw
    .map((q) => {
      const doc = documents[Number(q.sourceId) - 1];
      if (!doc) return null;
      return {
        ...q,
        category,
        source: doc.sourceName,
        sourceUrl: doc.url,
        sourcePublishedAt: doc.publishedAt,
        sourceDocumentId: doc.id ?? null,
        generator: 'llm',
      };
    })
    .filter(Boolean);

  const allowedSourceUrls = new Set(documents.map((d) => d.url));
  const { accepted, rejected } = validateBatch(withSources, {
    allowedSourceUrls,
    seenFingerprints,
    requireSource: true,
  });

  return { accepted, rejected, generated: raw.length };
}

const REPHRASE_SYSTEM = `You rewrite the wording of trivia questions to make them more engaging.

Rules you must not break:
1. The factual content, the correct answer and all four answer options must stay exactly as given. Never change, reorder or reword any answer option.
2. Only the question sentence may change. Keep it under 200 characters and keep it a single question ending in "?".
3. Do not add facts, hedges, hints, or anything that narrows down the answer.
4. If a question is already good, return it unchanged.`;

const REPHRASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question'],
        properties: {
          id: { type: 'integer' },
          question: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Optional polish pass for template-generated geography questions. The answer
 * always comes from structured data; this only varies the phrasing. If it fails
 * or is unavailable, the original template wording is used.
 */
async function rephraseTemplateQuestions(items) {
  if (!isLlmEnabled() || !items.length) return items;

  try {
    const prompt = [
      'Rewrite the wording of these trivia questions. Return one entry per id.',
      '',
      ...items.map((item, i) =>
        [
          `id: ${i + 1}`,
          `question: ${item.question}`,
          `options: ${item.answers.join(' | ')}`,
        ].join('\n'),
      ),
    ].join('\n\n');

    const { data } = await generateJson({
      system: REPHRASE_SYSTEM,
      prompt,
      schema: REPHRASE_SCHEMA,
      effort: 'low',
    });

    const rewrites = new Map(
      (Array.isArray(data?.questions) ? data.questions : []).map((r) => [Number(r.id), r.question]),
    );

    return items.map((item, i) => {
      const rewritten = rewrites.get(i + 1);
      if (typeof rewritten !== 'string') return item;
      const trimmed = rewritten.trim();
      // Reject a rewrite that leaked an answer option into the question text or
      // otherwise looks wrong; fall back to the template wording.
      const leaksAnswer = item.answers.some((a) =>
        trimmed.toLowerCase().includes(String(a).toLowerCase()),
      );
      if (
        !trimmed.endsWith('?') ||
        trimmed.length < 15 ||
        trimmed.length > 200 ||
        leaksAnswer
      ) {
        return item;
      }
      return {
        ...item,
        question: trimmed,
        generator: 'template+llm',
        fingerprint: fingerprint(trimmed, item.correctAnswer),
      };
    });
  } catch (err) {
    console.warn('[questionGenerator] rephrase pass skipped:', err.message);
    return items;
  }
}

/**
 * Geography generation: deterministic templates over authoritative structured
 * data, optionally rephrased by the model.
 */
export async function generateGeography(documents, { count, seenFingerprints, rng } = {}) {
  const records = documents.flatMap((doc) => doc.facts?.records ?? []);
  if (!records.length) return { accepted: [], rejected: [], generated: 0 };

  const datasetDoc = documents[0];
  const templated = buildGeographyQuestions(records, rng, count);

  const candidates = templated.map((t) => {
    const doc =
      documents.find((d) => {
        const id = d.facts?.datasetId;
        if (t.topic.startsWith('peak')) return id === 'wikidata-peaks';
        if (t.topic.startsWith('river')) return id === 'wikidata-rivers';
        return id === 'wikidata-countries';
      }) ?? datasetDoc;

    return {
      category: 'geography',
      difficulty: t.difficulty,
      question: t.question,
      answers: [t.correctAnswer, ...t.distractors],
      correctAnswer: t.correctAnswer,
      explanation: t.explanation,
      source: doc.sourceName,
      sourceUrl: doc.url,
      sourcePublishedAt: doc.publishedAt,
      sourceDocumentId: doc.id ?? null,
      generator: 'template',
    };
  });

  const { accepted, rejected } = validateBatch(candidates, {
    // Templates cite the dataset they came from; there is no article URL to
    // cross-check, so provenance is enforced by construction instead.
    requireSource: false,
    seenFingerprints,
  });

  const polished = await rephraseTemplateQuestions(accepted);

  return { accepted: polished, rejected, generated: candidates.length };
}
