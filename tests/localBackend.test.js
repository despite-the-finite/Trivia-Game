import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LocalBackend } from '../public/js/services/LocalBackend.js';
import { seededRandom as clientRng, shuffle as clientShuffle } from '../public/js/lib/rng.js';
import { scoreAnswer as clientScore, reconcileResponseTime as clientReconcile } from '../public/js/lib/scoring.js';
import { seededRandom as serverRng, shuffle as serverShuffle } from '../backend/lib/ids.js';
import { scoreAnswer as serverScore, reconcileResponseTime as serverReconcile } from '../backend/services/scoringService.js';
import { validateQuestion } from '../backend/services/questionValidator.js';

const bank = JSON.parse(readFileSync(new URL('../public/data/question-bank.json', import.meta.url)));

/** localStorage stand-in, so the backend can be exercised outside a browser. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const newBackend = () => new LocalBackend(bank, memoryStorage());

async function signedIn(name = 'Tester') {
  const backend = newBackend();
  await backend.request('/player', { method: 'POST', body: { displayName: name } });
  return backend;
}

/** Plays a whole run, always choosing the option the reveal says is correct. */
async function playPerfectly(backend, start, { responseMs = 3000 } = {}) {
  const results = [];
  for (const question of start.questions) {
    // The play shape carries no answer key, so the first pick is blind; we read
    // the correct index out of the response and use it for the next question.
    const previous = results[results.length - 1];
    const guess = previous ? previous.correctIndex : 0;
    results.push(
      await backend.request('/answer', {
        method: 'POST',
        body: { sessionId: start.session.id, questionId: question.id, selectedAnswer: guess, responseMs },
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// The bank itself
// ---------------------------------------------------------------------------

test('every banked question passes the same validator the live pipeline gates on', () => {
  for (const q of bank.questions) {
    const result = validateQuestion(
      {
        question: q.question,
        answers: q.answers,
        correctAnswer: q.answers[q.correctIndex],
        explanation: q.explanation,
        difficulty: q.difficulty,
        sourceUrl: q.sourceUrl,
      },
      { requireSource: true },
    );
    assert.ok(result.ok, `${q.id} rejected: ${result.reasons.join(', ')}`);
  }
});

test('the bank is large and varied enough to play', () => {
  assert.ok(bank.questions.length >= 300, 'bank should hold at least 300 questions');
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const count = bank.questions.filter((q) => q.difficulty === difficulty).length;
    assert.ok(count >= 40, `only ${count} ${difficulty} questions`);
  }
  // Ids must be stable and unique or sessions cannot pin a question set.
  assert.equal(new Set(bank.questions.map((q) => q.id)).size, bank.questions.length);
  // Current Events is deliberately absent: it cannot be pre-baked without
  // going stale, which is the premise of the project.
  assert.ok(!bank.questions.some((q) => q.category === 'current-events'));
});

test('correct answers are spread across all four positions', () => {
  const counts = [0, 0, 0, 0];
  for (const q of bank.questions) counts[q.correctIndex] += 1;
  // A bank that always puts the answer first is a bank you can beat blindfolded.
  for (const [index, count] of counts.entries()) {
    assert.ok(count > bank.questions.length / 8, `position ${index} holds only ${count} answers`);
  }
});

// ---------------------------------------------------------------------------
// The client copies of the shared rules must not drift from the server's
// ---------------------------------------------------------------------------

test('client and server RNG produce identical sequences', () => {
  for (const seed of ['daily:2026-01-01', 'daily:2026-09-01', '', 'a', 'challenge:xyz']) {
    const a = clientRng(seed);
    const b = serverRng(seed);
    for (let i = 0; i < 200; i += 1) assert.equal(a(), b(), `diverged at draw ${i} for seed "${seed}"`);
  }
});

test('client and server shuffles agree for a given seed', () => {
  const items = Array.from({ length: 40 }, (_, i) => i);
  for (const seed of ['x', 'daily-order:2026-09-01']) {
    assert.deepEqual(clientShuffle(items, clientRng(seed)), serverShuffle(items, serverRng(seed)));
  }
});

test('client and server scoring agree across the whole input matrix', () => {
  for (const correct of [true, false]) {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      for (const responseMs of [0, 400, 749, 750, 1999, 2000, 5000, 12000, 19999, 20000]) {
        for (const currentStreak of [0, 1, 2, 3, 4, 5, 9, 10, 25]) {
          const input = { correct, difficulty, responseMs, currentStreak };
          assert.deepEqual(
            clientScore(input),
            serverScore(input),
            `mismatch for ${JSON.stringify(input)}`,
          );
        }
      }
    }
  }
});

test('client and server reconcile response times identically', () => {
  for (const clientMs of [null, NaN, -50, 0, 300, 5000, 21600, 90000]) {
    for (const serverElapsedMs of [0, 500, 3000, 18000, 40000]) {
      assert.deepEqual(
        clientReconcile({ clientMs, serverElapsedMs }),
        serverReconcile({ clientMs, serverElapsedMs }),
        `mismatch for client=${clientMs} server=${serverElapsedMs}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Playing offline
// ---------------------------------------------------------------------------

test('health reports local mode and the categories actually available', async () => {
  const health = await newBackend().request('/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.mode, 'local');
  assert.deepEqual(health.categories, ['geography', 'science']);
});

test('a full quick game can be played, finished and reviewed', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: { category: 'mixed' } });

  assert.equal(start.questions.length, 10);
  assert.equal(start.scoring.questionTimeLimitMs, 20000);

  const results = await playPerfectly(backend, start);
  assert.equal(results.length, 10);
  for (const r of results) {
    assert.ok(typeof r.correctAnswer === 'string' && r.correctAnswer.length);
    assert.ok(typeof r.explanation === 'string' && r.explanation.length);
    assert.ok(/^https?:\/\//.test(r.sourceUrl));
  }

  const summary = await backend.request('/session', {
    method: 'POST',
    body: { sessionId: start.session.id },
  });
  assert.equal(summary.result.total, 10);
  assert.equal(summary.result.answered, 10);
  assert.equal(summary.result.score, results.reduce((s, r) => s + r.pointsEarned, 0));

  const review = await backend.request('/session', {
    query: { id: start.session.id, view: 'review' },
  });
  assert.equal(review.questions.length, 10);
  assert.ok(review.questions.every((q) => q.correctAnswer && q.source));
});

test('the play shape never carries the answer key', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });
  for (const q of start.questions) {
    // Local play cannot be server-authoritative, but leaking the key into the
    // question payload would let the UI spoil itself before an answer is given.
    assert.deepEqual(Object.keys(q).sort(), [
      'answers', 'category', 'difficulty', 'id', 'position', 'question',
    ]);
  }
});

test('a question cannot be answered twice in one game', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });
  const body = {
    sessionId: start.session.id,
    questionId: start.questions[0].id,
    selectedAnswer: 0,
    responseMs: 2000,
  };
  await backend.request('/answer', { method: 'POST', body });
  await assert.rejects(() => backend.request('/answer', { method: 'POST', body }), /already answered/);
});

test('a question outside the session is rejected', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });
  const inSession = new Set(start.questions.map((q) => q.id));
  const outsider = bank.questions.find((q) => !inSession.has(q.id));

  await assert.rejects(
    () =>
      backend.request('/answer', {
        method: 'POST',
        body: { sessionId: start.session.id, questionId: outsider.id, selectedAnswer: 0, responseMs: 2000 },
      }),
    /not part of this game/,
  );
});

test('an out-of-range option is rejected', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });
  await assert.rejects(
    () =>
      backend.request('/answer', {
        method: 'POST',
        body: { sessionId: start.session.id, questionId: start.questions[0].id, selectedAnswer: 9, responseMs: 2000 },
      }),
    /out of range/,
  );
});

test('running out of time scores zero and resets the streak', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });

  const first = await backend.request('/answer', {
    method: 'POST',
    body: { sessionId: start.session.id, questionId: start.questions[0].id, selectedAnswer: 0, responseMs: 1000 },
  });
  const timedOut = await backend.request('/answer', {
    method: 'POST',
    body: { sessionId: start.session.id, questionId: start.questions[1].id, selectedAnswer: null, responseMs: 20000 },
  });

  assert.equal(timedOut.correct, false);
  assert.equal(timedOut.pointsEarned, 0);
  assert.equal(timedOut.streak, 0);
  assert.ok(first.streak >= 0);
});

test('mashing an answer forfeits the speed bonus', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });
  const result = await backend.request('/answer', {
    method: 'POST',
    body: { sessionId: start.session.id, questionId: start.questions[0].id, selectedAnswer: 0, responseMs: 50 },
  });
  assert.equal(result.speedBonus, 0);
});

test('a difficulty filter is honoured', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', {
    method: 'POST',
    body: { category: 'geography', difficulty: 'easy' },
  });
  for (const q of start.questions) {
    assert.equal(q.difficulty, 'easy');
    assert.equal(q.category, 'geography');
  }
});

test('a run avoids questions from the run before it', async () => {
  const backend = await signedIn();
  const first = await backend.request('/session', { method: 'POST', body: {} });
  const second = await backend.request('/session', { method: 'POST', body: {} });
  const seen = new Set(first.questions.map((q) => q.id));
  const repeats = second.questions.filter((q) => seen.has(q.id));
  assert.equal(repeats.length, 0);
});

test('current events is refused with an explanation rather than an empty game', async () => {
  const backend = await signedIn();
  await assert.rejects(
    () => backend.request('/session', { method: 'POST', body: { category: 'current-events' } }),
    /live news/,
  );
});

test('stats accumulate across games', async () => {
  const backend = await signedIn();
  const start = await backend.request('/session', { method: 'POST', body: {} });
  const results = await playPerfectly(backend, start);
  await backend.request('/session', { method: 'POST', body: { sessionId: start.session.id } });

  const { stats } = await backend.request('/player');
  assert.equal(stats.gamesPlayed, 1);
  assert.equal(stats.questionsAnswered, 10);
  assert.equal(stats.totalScore, results.reduce((s, r) => s + r.pointsEarned, 0));
  assert.equal(stats.correctAnswers + stats.incorrectAnswers, 10);
  assert.ok(stats.accuracy >= 0 && stats.accuracy <= 100);
});

// ---------------------------------------------------------------------------
// The daily challenge
// ---------------------------------------------------------------------------

test('the daily challenge is identical for every device on the same day', async () => {
  const a = await signedIn('A');
  const b = await signedIn('B');
  const first = await a.request('/daily-challenge', { method: 'POST', body: {} });
  const second = await b.request('/daily-challenge', { method: 'POST', body: {} });

  assert.deepEqual(
    first.questions.map((q) => q.id),
    second.questions.map((q) => q.id),
  );
  // Same options in the same places, so two people genuinely take one test.
  assert.deepEqual(
    first.questions.map((q) => q.answers),
    second.questions.map((q) => q.answers),
  );
});

test('the daily challenge cannot be replayed for score', async () => {
  const backend = await signedIn();
  const start = await backend.request('/daily-challenge', { method: 'POST', body: {} });
  await playPerfectly(backend, start);
  await backend.request('/session', { method: 'POST', body: { sessionId: start.session.id } });

  const status = await backend.request('/daily-challenge');
  assert.equal(status.played, true);
  assert.equal(status.yourResult.total, 10);

  await assert.rejects(
    () => backend.request('/daily-challenge', { method: 'POST', body: {} }),
    /already played/,
  );
});

test('an unfinished daily challenge resumes rather than restarting', async () => {
  const backend = await signedIn();
  const first = await backend.request('/daily-challenge', { method: 'POST', body: {} });
  const resumed = await backend.request('/daily-challenge', { method: 'POST', body: {} });
  assert.equal(resumed.session.id, first.session.id);
});

// ---------------------------------------------------------------------------
// What local mode honestly cannot do
// ---------------------------------------------------------------------------

test('multiplayer features refuse clearly instead of failing obscurely', async () => {
  const backend = await signedIn();
  for (const [path, options] of [
    ['/friends', {}],
    ['/friends', { method: 'POST', body: { friendCode: 'ABCDE-1234' } }],
    ['/challenge', { method: 'POST', body: {} }],
  ]) {
    await assert.rejects(
      () => backend.request(path, options),
      (err) => err.code === 'local_mode_unsupported' && err.message.length > 20,
      `${path} should refuse with an explanation`,
    );
  }
});

test('the leaderboard becomes your own run history', async () => {
  const backend = await signedIn();
  for (let i = 0; i < 2; i += 1) {
    const start = await backend.request('/session', { method: 'POST', body: {} });
    await playPerfectly(backend, start);
    await backend.request('/session', { method: 'POST', body: { sessionId: start.session.id } });
  }

  const board = await backend.request('/leaderboard', { query: { period: 'all' } });
  assert.equal(board.scope, 'personal');
  assert.equal(board.entries.length, 2);
  assert.ok(board.entries[0].value >= board.entries[1].value, 'runs should be ranked by score');
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('a player and their stats survive a reload', async () => {
  const storage = memoryStorage();
  const first = new LocalBackend(bank, storage);
  await first.request('/player', { method: 'POST', body: { displayName: 'Karsh' } });
  const start = await first.request('/session', { method: 'POST', body: {} });
  await playPerfectly(first, start);
  await first.request('/session', { method: 'POST', body: { sessionId: start.session.id } });

  const reloaded = new LocalBackend(bank, storage);
  const { player, stats } = await reloaded.request('/player');
  assert.equal(player.displayName, 'Karsh');
  assert.equal(stats.gamesPlayed, 1);
  assert.equal(stats.questionsAnswered, 10);
});

test('a browser with storage disabled still plays', async () => {
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const backend = new LocalBackend(bank, hostile);
  await backend.request('/player', { method: 'POST', body: { displayName: 'Ghost' } });
  const start = await backend.request('/session', { method: 'POST', body: {} });
  const results = await playPerfectly(backend, start);
  assert.equal(results.length, 10);
});
