import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateQuestion,
  validateBatch,
  fingerprint,
} from '../backend/services/questionValidator.js';

const SOURCE = 'https://example.org/news/story';

const good = (overrides = {}) => ({
  question: 'Which country hosted the 2026 summit described in the source material?',
  answers: ['Portugal', 'Denmark', 'Uruguay', 'Malaysia'],
  correctAnswer: 'Portugal',
  explanation: 'The summit was held in Portugal, according to the reporting on the day.',
  sourceUrl: SOURCE,
  ...overrides,
});

const context = { allowedSourceUrls: new Set([SOURCE]) };

test('a well-formed question is accepted', () => {
  const result = validateQuestion(good(), context);
  assert.equal(result.ok, true, result.reasons.join(', '));
  assert.equal(result.value.correctIndex, 0);
  assert.equal(result.value.answers.length, 4);
});

test('the correct answer must appear among the options', () => {
  const result = validateQuestion(good({ correctAnswer: 'Iceland' }), context);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('correct-answer-not-in-options'));
});

test('exactly four options are required', () => {
  const result = validateQuestion(good({ answers: ['Portugal', 'Denmark', 'Uruguay'] }), context);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('needs-exactly-four-answers'));
});

test('duplicate options are rejected', () => {
  const result = validateQuestion(
    good({ answers: ['Portugal', 'portugal', 'Uruguay', 'Malaysia'] }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('duplicate-answer-options'));
});

test('meta-options like "all of the above" are rejected', () => {
  const result = validateQuestion(
    good({ answers: ['Portugal', 'Denmark', 'Uruguay', 'All of the above'] }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('banned-answer-option'));
});

test('speculative questions are rejected', () => {
  const result = validateQuestion(
    good({ question: 'Which country might host the next summit according to observers?' }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith('speculative')));
});

test('opinion questions are rejected', () => {
  const result = validateQuestion(
    good({ question: 'Which country made the best case at the 2026 summit?' }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith('subjective')));
});

test('questions that reference the source article are rejected', () => {
  const result = validateQuestion(
    good({ question: 'According to the article, which country hosted the 2026 summit?' }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith('self-referential')));
});

test('relative dates are rejected because they expire in the cache', () => {
  const result = validateQuestion(
    good({ question: 'Which country hosted the summit that opened yesterday in Europe?' }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('relative-date-reference'));
});

test('a conspicuously long correct answer is rejected as a giveaway', () => {
  const result = validateQuestion(
    good({
      answers: [
        'The Portuguese Republic, which hosted the summit at its national conference centre in Lisbon',
        'Denmark',
        'Uruguay',
        'Malaysia',
      ],
      correctAnswer:
        'The Portuguese Republic, which hosted the summit at its national conference centre in Lisbon',
    }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('correct-answer-conspicuously-long'));
});

test('a source URL the generator invented is rejected', () => {
  const result = validateQuestion(good({ sourceUrl: 'https://not-supplied.example/made-up' }), context);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('source-url-not-in-supplied-material'));
});

test('provenance is optional for template-generated questions', () => {
  const result = validateQuestion(good({ sourceUrl: '' }), { requireSource: false });
  assert.equal(result.ok, true, result.reasons.join(', '));
});

test('questions must end in a question mark', () => {
  const result = validateQuestion(
    good({ question: 'Name the country that hosted the 2026 summit.' }),
    context,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('question-not-interrogative'));
});

test('duplicates within one batch are caught', () => {
  const { accepted, rejected } = validateBatch([good(), good()], context);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reasons.includes('duplicate-question'));
});

test('duplicates already in the bank are caught', () => {
  const existing = new Set([fingerprint(good().question, good().correctAnswer)]);
  const { accepted, rejected } = validateBatch([good()], {
    ...context,
    seenFingerprints: existing,
  });
  assert.equal(accepted.length, 0);
  assert.ok(rejected[0].reasons.includes('duplicate-question'));
});

test('fingerprints ignore punctuation, case and filler words', () => {
  const a = fingerprint('Which country hosted the 2026 summit?', 'Portugal');
  const b = fingerprint('which country hosted a 2026 summit!!', 'portugal');
  assert.equal(a, b);
});

test('fingerprints distinguish different answers to the same question', () => {
  const a = fingerprint('Which country hosted the 2026 summit?', 'Portugal');
  const b = fingerprint('Which country hosted the 2026 summit?', 'Denmark');
  assert.notEqual(a, b);
});
