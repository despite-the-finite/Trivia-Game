import { sha256 } from '../lib/ids.js';

/**
 * questionValidator — the gate between "a model produced something" and "a
 * player will be scored on it".
 *
 * Every check here answers one question: could a well-informed player dispute
 * this? Anything malformed, ambiguous, unverifiable, opinion-based, duplicated
 * or structurally giveaway-prone is rejected rather than patched.
 */

/** Wording that signals the answer is not objectively settled. */
const SPECULATIVE_TERMS = [
  'might', 'may ', 'could', 'possibly', 'perhaps', 'rumor', 'rumour', 'allegedly',
  'reportedly', 'is expected to', 'is set to', 'is poised to', 'critics say',
  'supporters say', 'some believe', 'many believe', 'arguably', 'seems to',
  'appears to', 'is likely to', 'analysts predict', 'speculation',
];

/** Wording that makes the question opinion or interpretation rather than fact. */
const SUBJECTIVE_TERMS = [
  'best', 'worst', 'most important', 'greatest', 'should ', 'ought to',
  'do you think', 'in your opinion', 'most impressive', 'most exciting',
  'most controversial', 'most beautiful', 'favourite', 'favorite',
];

/** Phrasing that only makes sense if you are holding the source article. */
const ARTICLE_REFERENCE_TERMS = [
  'according to the article', 'the article states', 'the article says',
  'in the passage', 'the passage', 'this report states', 'the above',
  'as mentioned', 'the text says', 'per the summary', 'the story says',
];

/** Options that are structurally unfair or lazy. */
const BANNED_OPTIONS = [
  'all of the above', 'none of the above', 'both a and b', 'all of these',
  'none of these', 'any of the above', 'not enough information',
  'cannot be determined', 'unknown', 'n/a',
];

const containsAny = (haystack, needles) => {
  const lower = haystack.toLowerCase();
  return needles.filter((needle) => lower.includes(needle));
};

/** Normalised text used for duplicate detection across regenerations. */
export function fingerprint(questionText, correctAnswer) {
  const normalise = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\b(the|a|an|of|in|on|at|to|for|is|was|were|are)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return sha256(`${normalise(questionText)}::${normalise(correctAnswer)}`);
}

/**
 * @param {object} candidate  Raw generated question.
 * @param {object} context
 * @param {Set<string>} context.allowedSourceUrls  URLs supplied to the generator.
 * @param {Set<string>} context.seenFingerprints   Fingerprints already accepted.
 * @param {boolean} context.requireSource          Current-events/science require provenance.
 * @returns {{ok: boolean, reasons: string[], value?: object}}
 */
export function validateQuestion(candidate, context = {}) {
  const {
    allowedSourceUrls = null,
    seenFingerprints = new Set(),
    requireSource = true,
  } = context;

  const reasons = [];
  const fail = (reason) => reasons.push(reason);

  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reasons: ['not-an-object'] };
  }

  // --- Shape ------------------------------------------------------------
  const question = typeof candidate.question === 'string' ? candidate.question.trim() : '';
  const explanation = typeof candidate.explanation === 'string' ? candidate.explanation.trim() : '';
  const answers = Array.isArray(candidate.answers) ? candidate.answers.map((a) => String(a).trim()) : [];
  const correctAnswer =
    typeof candidate.correctAnswer === 'string' ? candidate.correctAnswer.trim() : '';

  if (question.length < 15) fail('question-too-short');
  if (question.length > 280) fail('question-too-long');
  if (!question.endsWith('?')) fail('question-not-interrogative');
  if (explanation.length < 20) fail('explanation-too-short');
  if (explanation.length > 400) fail('explanation-too-long');

  // --- Answer options ---------------------------------------------------
  if (answers.length !== 4) fail('needs-exactly-four-answers');
  if (answers.some((a) => !a)) fail('empty-answer-option');
  if (answers.some((a) => a.length > 120)) fail('answer-option-too-long');

  const lowered = answers.map((a) => a.toLowerCase());
  if (new Set(lowered).size !== lowered.length) fail('duplicate-answer-options');
  if (lowered.some((a) => BANNED_OPTIONS.includes(a))) fail('banned-answer-option');

  if (!correctAnswer) fail('missing-correct-answer');
  const correctIndex = lowered.indexOf(correctAnswer.toLowerCase());
  if (correctAnswer && correctIndex === -1) fail('correct-answer-not-in-options');

  // A correct answer far longer than its distractors is guessable without
  // knowing anything — models do this constantly.
  if (correctIndex !== -1 && answers.length === 4) {
    const others = answers.filter((_, i) => i !== correctIndex);
    const avgOther = others.reduce((sum, a) => sum + a.length, 0) / others.length;
    if (avgOther > 0 && answers[correctIndex].length > Math.max(avgOther * 2.2, avgOther + 40)) {
      fail('correct-answer-conspicuously-long');
    }
  }

  // --- Content quality --------------------------------------------------
  const haystack = `${question} ${answers.join(' ')}`;
  const speculative = containsAny(haystack, SPECULATIVE_TERMS);
  if (speculative.length) fail(`speculative:${speculative[0].trim()}`);

  const subjective = containsAny(question, SUBJECTIVE_TERMS);
  if (subjective.length) fail(`subjective:${subjective[0].trim()}`);

  const articleRef = containsAny(`${question} ${explanation}`, ARTICLE_REFERENCE_TERMS);
  if (articleRef.length) fail(`self-referential:${articleRef[0].trim()}`);

  if (/\byesterday\b|\btoday\b|\btomorrow\b|\bthis morning\b|\blast night\b/i.test(question)) {
    // Relative dates stop being true the moment the question is cached.
    fail('relative-date-reference');
  }

  // --- Provenance -------------------------------------------------------
  const sourceUrl = typeof candidate.sourceUrl === 'string' ? candidate.sourceUrl.trim() : '';
  if (requireSource) {
    if (!/^https?:\/\//.test(sourceUrl)) fail('missing-source-url');
    else if (allowedSourceUrls && !allowedSourceUrls.has(sourceUrl)) {
      // The generator must cite one of the documents it was handed. A URL it
      // produced itself is, by definition, unverified.
      fail('source-url-not-in-supplied-material');
    }
  }

  // --- Duplicates -------------------------------------------------------
  const fp = fingerprint(question, correctAnswer);
  if (seenFingerprints.has(fp)) fail('duplicate-question');

  if (reasons.length) return { ok: false, reasons };

  return {
    ok: true,
    reasons: [],
    value: {
      question,
      answers,
      correctIndex,
      correctAnswer: answers[correctIndex],
      explanation,
      sourceUrl,
      fingerprint: fp,
    },
  };
}

/**
 * Validates a batch, tracking fingerprints across the batch so two questions in
 * the same generation cannot both survive if they ask the same thing.
 */
export function validateBatch(candidates, context = {}) {
  const seen = new Set(context.seenFingerprints ?? []);
  const accepted = [];
  const rejected = [];

  for (const candidate of candidates) {
    const result = validateQuestion(candidate, { ...context, seenFingerprints: seen });
    if (result.ok) {
      seen.add(result.value.fingerprint);
      accepted.push({ ...candidate, ...result.value });
    } else {
      rejected.push({ candidate, reasons: result.reasons });
    }
  }

  return { accepted, rejected, fingerprints: seen };
}
