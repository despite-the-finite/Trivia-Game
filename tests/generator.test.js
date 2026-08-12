import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFromDocuments } from '../backend/services/questionGenerator.js';

/**
 * Tests for the news/science generation path with the model call stubbed.
 *
 * The property under test is the one that matters for trust: provenance on a
 * stored question comes from OUR record of the source document, never from
 * whatever the model claims, and anything the validator dislikes is dropped
 * rather than repaired.
 */

const documents = [
  {
    id: 'doc-1',
    provider: 'newsProvider',
    category: 'current-events',
    title: 'Harbour bridge reopens after two-year refit',
    url: 'https://reuters.example/harbour-bridge',
    sourceName: 'Reuters',
    publishedAt: new Date('2026-08-10T09:00:00Z'),
    facts: {
      headline: 'Harbour bridge reopens after two-year refit',
      summary: 'The bridge reopened on 10 August 2026 after a refit costing 412 million euros.',
    },
  },
  {
    id: 'doc-2',
    provider: 'newsProvider',
    category: 'current-events',
    title: 'Northern rail line extended to Kirkwall',
    url: 'https://bbc.example/rail-extension',
    sourceName: 'BBC News',
    publishedAt: new Date('2026-08-11T06:30:00Z'),
    facts: {
      headline: 'Northern rail line extended to Kirkwall',
      summary: 'The extension added 84 kilometres of track and four new stations.',
    },
  },
];

const stubModel = (questions) => async () => ({ data: { questions } });

test('provenance is taken from our document record, not the model', async () => {
  const result = await generateFromDocuments(documents, {
    category: 'current-events',
    count: 4,
    generate: stubModel([
      {
        sourceId: 1,
        difficulty: 'medium',
        question: 'How much did the harbour bridge refit cost?',
        answers: ['412 million euros', '180 million euros', '95 million euros', '600 million euros'],
        correctAnswer: '412 million euros',
        explanation: 'The refit cost 412 million euros and finished in August 2026.',
        // The model also tries to assert a URL of its own; it must be ignored.
        sourceUrl: 'https://totally-made-up.example/article',
      },
    ]),
  });

  assert.equal(result.accepted.length, 1, JSON.stringify(result.rejected));
  const [question] = result.accepted;
  assert.equal(question.sourceUrl, 'https://reuters.example/harbour-bridge');
  assert.equal(question.source, 'Reuters');
  assert.equal(question.sourceDocumentId, 'doc-1');
  assert.equal(question.generator, 'llm');
  assert.equal(question.category, 'current-events');
  assert.ok(question.fingerprint);
});

test('a question citing an unknown document id is dropped', async () => {
  const result = await generateFromDocuments(documents, {
    category: 'current-events',
    count: 4,
    generate: stubModel([
      {
        sourceId: 99,
        difficulty: 'easy',
        question: 'Which city hosted the ceremony described in a source we never supplied?',
        answers: ['Oslo', 'Lima', 'Cairo', 'Perth'],
        correctAnswer: 'Oslo',
        explanation: 'This question has no supplied source document behind it.',
      },
    ]),
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.generated, 1, 'the attempt is still counted for observability');
});

test('low-quality generations are rejected, good ones in the same batch survive', async () => {
  const result = await generateFromDocuments(documents, {
    category: 'current-events',
    count: 6,
    generate: stubModel([
      {
        sourceId: 1,
        difficulty: 'medium',
        question: 'How much did the harbour bridge refit cost?',
        answers: ['412 million euros', '180 million euros', '95 million euros', '600 million euros'],
        correctAnswer: '412 million euros',
        explanation: 'The refit cost 412 million euros and finished in August 2026.',
      },
      {
        // Speculative — not a settled fact.
        sourceId: 2,
        difficulty: 'medium',
        question: 'How many stations might the rail extension eventually add?',
        answers: ['Four', 'Six', 'Eight', 'Ten'],
        correctAnswer: 'Four',
        explanation: 'The extension added four new stations.',
      },
      {
        // Self-referential — the player cannot see the article.
        sourceId: 2,
        difficulty: 'easy',
        question: 'According to the article, how long is the new track?',
        answers: ['84 km', '12 km', '150 km', '210 km'],
        correctAnswer: '84 km',
        explanation: 'The extension added 84 kilometres of track.',
      },
      {
        // Only three options.
        sourceId: 1,
        difficulty: 'hard',
        question: 'In which month did the harbour bridge reopen?',
        answers: ['August', 'March', 'November'],
        correctAnswer: 'August',
        explanation: 'The bridge reopened in August 2026.',
      },
      {
        // Duplicate of the first accepted question.
        sourceId: 1,
        difficulty: 'hard',
        question: 'How much did the harbour bridge refit cost?',
        answers: ['412 million euros', '1 billion euros', '20 million euros', '75 million euros'],
        correctAnswer: '412 million euros',
        explanation: 'The refit cost 412 million euros.',
      },
    ]),
  });

  assert.equal(result.generated, 5);
  assert.equal(result.accepted.length, 1, 'only the clean question survives');
  assert.equal(result.rejected.length, 4);

  const reasons = result.rejected.flatMap((r) => r.reasons);
  assert.ok(reasons.some((r) => r.startsWith('speculative')));
  assert.ok(reasons.some((r) => r.startsWith('self-referential')));
  assert.ok(reasons.includes('needs-exactly-four-answers'));
  assert.ok(reasons.includes('duplicate-question'));
});

test('questions already in the bank are not regenerated', async () => {
  const first = await generateFromDocuments(documents, {
    category: 'current-events',
    count: 2,
    generate: stubModel([
      {
        sourceId: 2,
        difficulty: 'medium',
        question: 'How many kilometres of track did the rail extension add?',
        answers: ['84', '12', '150', '210'],
        correctAnswer: '84',
        explanation: 'The extension added 84 kilometres of track.',
      },
    ]),
  });
  assert.equal(first.accepted.length, 1);

  const second = await generateFromDocuments(documents, {
    category: 'current-events',
    count: 2,
    seenFingerprints: new Set([first.accepted[0].fingerprint]),
    generate: stubModel([
      {
        sourceId: 2,
        difficulty: 'medium',
        question: 'How many kilometres of track did the rail extension add?',
        answers: ['84', '12', '150', '210'],
        correctAnswer: '84',
        explanation: 'The extension added 84 kilometres of track.',
      },
    ]),
  });
  assert.equal(second.accepted.length, 0);
  assert.ok(second.rejected[0].reasons.includes('duplicate-question'));
});

test('an empty document set short-circuits without calling the model', async () => {
  let called = false;
  const result = await generateFromDocuments([], {
    category: 'science',
    count: 10,
    generate: async () => {
      called = true;
      return { data: { questions: [] } };
    },
  });
  assert.equal(called, false, 'no source material means no model call and no cost');
  assert.deepEqual(result, { accepted: [], rejected: [], generated: 0 });
});

test('the prompt hands the model the supplied facts and nothing else', async () => {
  let seenPrompt = '';
  let seenSchema = null;
  await generateFromDocuments(documents, {
    category: 'current-events',
    count: 3,
    generate: async ({ prompt, schema, system }) => {
      seenPrompt = prompt;
      seenSchema = schema;
      assert.match(system, /Use ONLY the supplied source material/);
      return { data: { questions: [] } };
    },
  });

  // Every document's publisher, date, URL and facts must reach the model.
  for (const doc of documents) {
    assert.ok(seenPrompt.includes(doc.url), `prompt should carry ${doc.url}`);
    assert.ok(seenPrompt.includes(doc.sourceName));
    assert.ok(seenPrompt.includes(doc.facts.summary));
  }
  assert.ok(seenPrompt.includes('2026-08-10'), 'publication dates are supplied');

  // The structured-output schema is what stops malformed JSON at the source.
  assert.equal(seenSchema.type, 'object');
  assert.equal(seenSchema.additionalProperties, false);
  const item = seenSchema.properties.questions.items;
  assert.deepEqual(item.properties.difficulty.enum, ['easy', 'medium', 'hard']);
  assert.ok(item.required.includes('correctAnswer'));
  assert.ok(item.required.includes('sourceId'));
});
