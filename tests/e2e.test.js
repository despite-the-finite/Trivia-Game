import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

/**
 * End-to-end test against a real Postgres and the real API handlers.
 *
 * Skipped unless DATABASE_URL points at a database you are happy to write to:
 *
 *   DATABASE_URL=postgresql://postgres@localhost:5432/trivia_test \
 *     npm run migrate && npm test
 *
 * The question bank is seeded from the geography templates over a fixture
 * dataset, so this exercises templates → validator → storage → gameplay →
 * scoring → leaderboards → challenges without needing network access or an
 * LLM key.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

function startQuiz(category, token) {
  return call(`/api/daily-challenge?category=${category}`, { method: 'POST', token });
}

// The suite creates many accounts from one address; raise the per-IP ceiling
// so the abuse limiter does not fire on the test itself.
process.env.PLAYER_CREATE_LIMIT_PER_HOUR = '500';
const describe = HAS_DB ? test : test.skip;

let server;
let baseUrl;
let db;

async function startServer() {
  const routes = {
    '/api/health': (await import('../api/health.js')).default,
    '/api/player': (await import('../api/player.js')).default,
    '/api/trivia': (await import('../api/trivia.js')).default,
    '/api/session': (await import('../api/session.js')).default,
    '/api/answer': (await import('../api/answer.js')).default,
    '/api/friends': (await import('../api/friends.js')).default,
    '/api/leaderboard': (await import('../api/leaderboard.js')).default,
    '/api/challenge': (await import('../api/challenge.js')).default,
    '/api/daily-challenge': (await import('../api/daily-challenge.js')).default,
  };

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = routes[url.pathname];
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    req.query = Object.fromEntries(url.searchParams.entries());
    await handler(req, res);
  });
  server.listen(0);
  await once(server, 'listening');
  baseUrl = `http://localhost:${server.address().port}`;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Seeds the question bank from geography templates over fixture data. */
async function seedQuestions() {
  const { buildGeographyQuestions } = await import('../backend/services/geographyTemplates.js');
  const { validateBatch } = await import('../backend/services/questionValidator.js');
  const { seededRandom } = await import('../backend/lib/ids.js');

  const countries = [
    ['France', 'FRA', 'Paris', 68e6, 551695, 'Europe', ['DEU'], 'Euro', ['French']],
    ['Germany', 'DEU', 'Berlin', 84e6, 357022, 'Europe', ['FRA'], 'Euro', ['German']],
    ['Spain', 'ESP', 'Madrid', 47e6, 505992, 'Europe', ['PRT'], 'Euro', ['Spanish']],
    ['Portugal', 'PRT', 'Lisbon', 10e6, 92090, 'Europe', ['ESP'], 'Euro', ['Portuguese']],
    ['Poland', 'POL', 'Warsaw', 38e6, 312679, 'Europe', ['DEU'], 'Zloty', ['Polish']],
    ['Italy', 'ITA', 'Rome', 59e6, 301340, 'Europe', ['FRA'], 'Euro', ['Italian']],
    ['Japan', 'JPN', 'Tokyo', 125e6, 377930, 'Asia', [], 'Japanese yen', ['Japanese']],
    ['Kenya', 'KEN', 'Nairobi', 54e6, 580367, 'Africa', [], 'Kenyan shilling', ['Swahili']],
    ['Brazil', 'BRA', 'Brasilia', 214e6, 8515767, 'Americas', [], 'Brazilian real', ['Portuguese']],
    ['Chile', 'CHL', 'Santiago', 19e6, 756102, 'Americas', [], 'Chilean peso', ['Spanish']],
    ['Peru', 'PER', 'Lima', 33e6, 1285216, 'Americas', [], 'Peruvian sol', ['Spanish']],
    ['Egypt', 'EGY', 'Cairo', 104e6, 1002450, 'Africa', [], 'Egyptian pound', ['Arabic']],
    ['Nepal', 'NPL', 'Kathmandu', 30e6, 147181, 'Asia', [], 'Nepalese rupee', ['Nepali']],
    ['Norway', 'NOR', 'Oslo', 5e6, 323802, 'Europe', ['SWE'], 'Norwegian krone', ['Norwegian']],
    ['Sweden', 'SWE', 'Stockholm', 10.4e6, 450295, 'Europe', ['NOR'], 'Swedish krona', ['Swedish']],
  ].map(([name, code, capital, population, area, region, borders, currency, languages]) => ({
    kind: 'country',
    name, code, capital, population, area, region, subregion: region, borders,
    currencies: [{ code: currency.slice(0, 3).toUpperCase(), name: currency }],
    languages,
  }));

  const built = buildGeographyQuestions(countries, seededRandom('e2e-seed'), 80);
  const { accepted } = validateBatch(
    built.map((t) => ({
      category: 'geography',
      question: t.question,
      answers: [t.correctAnswer, ...t.distractors],
      correctAnswer: t.correctAnswer,
      explanation: t.explanation,
      source: 'Fixture dataset',
      sourceUrl: 'https://example.test/dataset',
      generator: 'template',
    })),
    { requireSource: false },
  );

  assert.ok(accepted.length >= 30, `expected a usable seed batch, got ${accepted.length}`);

  for (const q of accepted) {
    await db.query(
      `INSERT INTO questions
         (category, question, answers, correct_index, explanation,
          source, source_url, generator, expires_at, fingerprint)
       VALUES ('geography',$1,$2::jsonb,$3,$4,'Fixture dataset','https://example.test/dataset',
               'template', NOW() + INTERVAL '7 days', $5)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [q.question, JSON.stringify(q.answers), q.correctIndex, q.explanation, q.fingerprint],
    );
  }
  return accepted.length;
}

test.before(async () => {
  if (!HAS_DB) return;
  db = await import('../backend/db/index.js');
  // Clean slate for repeat runs.
  await db.query(
    `TRUNCATE players, questions, source_documents, rate_limits,
              daily_challenges, challenges, refresh_runs CASCADE`,
  );
  await seedQuestions();
  await startServer();
});

test.after(async () => {
  if (!HAS_DB) return;
  server?.close();
  await db.closePool();
});

describe('health reports a live bank', async () => {
  const { status, body } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(body.database, 'ok');
  assert.ok(body.totalQuestions > 0);
});

describe('a full game: sign up, play, score, finish', async () => {
  const created = await call('/api/player', { method: 'POST', body: { displayName: 'Karsh' } });
  assert.equal(created.status, 201);
  const token = created.body.token;
  assert.match(created.body.player.friendCode, /^[A-Z0-9]+-[A-Z0-9]{4}$/);

  const started = await startQuiz('geography', token);
  assert.equal(started.status, 201);
  const { session, questions } = started.body;
  assert.ok(questions.length > 0);

  // The play shape must never carry the answer key.
  for (const q of questions) {
    assert.equal(q.answers.length, 4);
    assert.ok(!('correctAnswer' in q), 'correctAnswer must not reach the client');
    assert.ok(!('correctIndex' in q), 'correctIndex must not reach the client');
    assert.ok(!('explanation' in q), 'explanation must not reach the client before answering');
  }

  let score = 0;
  let correctCount = 0;
  for (const q of questions) {
    const answer = await call('/api/answer', {
      method: 'POST',
      token,
      body: { sessionId: session.id, questionId: q.id, selectedAnswer: 0, responseMs: 3000 },
    });
    assert.equal(answer.status, 200);
    assert.ok(typeof answer.body.correct === 'boolean');
    assert.ok(answer.body.explanation, 'the explanation is revealed after answering');
    assert.ok(answer.body.sourceUrl, 'provenance is revealed after answering');
    score += answer.body.pointsEarned;
    if (answer.body.correct) correctCount += 1;
  }

  // Re-submitting a question must be rejected — this is the replay guard.
  const replay = await call('/api/answer', {
    method: 'POST',
    token,
    body: { sessionId: session.id, questionId: questions[0].id, selectedAnswer: 1, responseMs: 500 },
  });
  assert.equal(replay.status, 409, 'a repeated answer must be refused');

  const finished = await call('/api/session', {
    method: 'POST',
    token,
    body: { sessionId: session.id },
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.result.score, score, 'server total must match the sum it awarded');
  assert.equal(finished.body.result.correct, correctCount);
  assert.equal(finished.body.result.total, questions.length);
});

describe('a question from another session is refused', async () => {
  const a = await call('/api/player', { method: 'POST', body: { displayName: 'Alex' } });
  const b = await call('/api/player', { method: 'POST', body: { displayName: 'Robin' } });

  const sessionA = await startQuiz('geography', a.body.token);
  const sessionB = await startQuiz('geography', b.body.token);

  // Both players play the same category on the same day, so they get the
  // identical fixed set — this in itself is the "everyone gets the same quiz"
  // guarantee.
  assert.deepEqual(
    sessionA.body.questions.map((q) => q.id),
    sessionB.body.questions.map((q) => q.id),
  );

  // B tries to answer into A's session.
  const crossSession = await call('/api/answer', {
    method: 'POST',
    token: b.body.token,
    body: {
      sessionId: sessionA.body.session.id,
      questionId: sessionA.body.questions[0].id,
      selectedAnswer: 0,
      responseMs: 2000,
    },
  });
  assert.equal(crossSession.status, 403, "a session must not accept another player's answers");

  // A real bank question that is not part of today's fixed set is refused even
  // for the session's own owner.
  const inSet = new Set(sessionA.body.questions.map((q) => q.id));
  const { rows } = await db.query(
    'SELECT id FROM questions WHERE category = $1 AND NOT (id = ANY($2)) LIMIT 1',
    ['geography', [...inSet]],
  );
  if (rows.length) {
    const wrongQuestion = await call('/api/answer', {
      method: 'POST',
      token: a.body.token,
      body: {
        sessionId: sessionA.body.session.id,
        questionId: rows[0].id,
        selectedAnswer: 0,
        responseMs: 2000,
      },
    });
    assert.equal(wrongQuestion.status, 400);
  }
});

describe('/api/trivia hides answers from the public and reveals them to admins', async () => {
  const publicView = await call('/api/trivia?category=geography&count=3');
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.answersIncluded, false);
  for (const q of publicView.body.questions) {
    assert.ok(!('correctAnswer' in q));
    assert.equal(q.answers.length, 4);
  }

  process.env.TRIVIA_ADMIN_KEY = 'test-admin-key';
  const res = await fetch(`${baseUrl}/api/trivia?category=geography&count=3`, {
    headers: { 'X-Admin-Key': 'test-admin-key' },
  });
  const adminView = await res.json();
  assert.equal(adminView.answersIncluded, true);
  for (const q of adminView.questions) {
    assert.ok(q.correctAnswer, 'admin view carries the answer key');
    assert.ok(q.answers.includes(q.correctAnswer));
    assert.ok(q.sourceUrl, 'provenance survives into the full record');
  }
  delete process.env.TRIVIA_ADMIN_KEY;
});

describe('a category quiz is a fixed set: replays reuse the same set and order as practice', async () => {
  const player = await call('/api/player', { method: 'POST', body: { displayName: 'Shuffle' } });

  const first = await startQuiz('geography', player.body.token);
  assert.equal(first.status, 201);
  assert.equal(first.body.session.isPractice, false);

  for (const q of first.body.questions) {
    await call('/api/answer', {
      method: 'POST',
      token: player.body.token,
      body: { sessionId: first.body.session.id, questionId: q.id, selectedAnswer: 0, responseMs: 3000 },
    });
  }
  await call('/api/session', {
    method: 'POST', token: player.body.token, body: { sessionId: first.body.session.id },
  });

  const replay = await startQuiz('geography', player.body.token);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.session.isPractice, true, 'a replay after the scored attempt is practice');
  assert.deepEqual(
    replay.body.questions.map((q) => q.id),
    first.body.questions.map((q) => q.id),
    'the fixed set is identical on replay',
  );
  assert.deepEqual(
    replay.body.questions.map((q) => q.answers),
    first.body.questions.map((q) => q.answers),
    'answer placement is identical on replay',
  );
});

describe('friends, leaderboards and comparison', async () => {
  const karsh = await call('/api/player', { method: 'POST', body: { displayName: 'Kara' } });
  const alex = await call('/api/player', { method: 'POST', body: { displayName: 'Alexi' } });

  const added = await call('/api/friends', {
    method: 'POST',
    token: karsh.body.token,
    body: { friendCode: alex.body.player.friendCode },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.added.displayName, 'Alexi');

  // Friendship is mutual, so Alexi sees Kara too.
  const alexFriends = await call('/api/friends', { token: alex.body.token });
  assert.ok(alexFriends.body.friends.some((f) => f.displayName === 'Kara'));

  const board = await call('/api/leaderboard?scope=friends&period=week&board=overall', {
    token: karsh.body.token,
  });
  assert.equal(board.status, 200);
  assert.equal(board.body.scope, 'friends');
  assert.equal(board.body.period, 'week');

  const globalBoard = await call('/api/leaderboard?scope=global&period=all');
  assert.equal(globalBoard.status, 200);

  // The friends board requires a token; global does not.
  const anon = await call('/api/leaderboard?scope=friends');
  assert.equal(anon.status, 400);
});

describe('a challenge gives both players the identical set and ordering', async () => {
  const host = await call('/api/player', { method: 'POST', body: { displayName: 'Host' } });
  const guest = await call('/api/player', { method: 'POST', body: { displayName: 'Guest' } });

  const created = await call('/api/challenge', {
    method: 'POST',
    token: host.body.token,
    body: { category: 'geography', count: 5 },
  });
  assert.equal(created.status, 201);
  const slug = created.body.challenge.slug;
  assert.match(created.body.url, /\/challenge\/[a-z0-9]{8}$/);

  const hostRun = await call('/api/challenge?action=join', {
    method: 'POST', token: host.body.token, body: { slug },
  });
  const guestRun = await call('/api/challenge?action=join', {
    method: 'POST', token: guest.body.token, body: { slug },
  });

  assert.deepEqual(
    hostRun.body.questions.map((q) => q.id),
    guestRun.body.questions.map((q) => q.id),
    'both players must get the same questions in the same order',
  );
  assert.deepEqual(
    hostRun.body.questions.map((q) => q.answers),
    guestRun.body.questions.map((q) => q.answers),
    'answer placement must be identical for both players',
  );

  for (const run of [
    { token: host.body.token, payload: hostRun.body },
    { token: guest.body.token, payload: guestRun.body },
  ]) {
    for (const q of run.payload.questions) {
      await call('/api/answer', {
        method: 'POST',
        token: run.token,
        body: {
          sessionId: run.payload.session.id,
          questionId: q.id,
          selectedAnswer: 0,
          responseMs: 4000,
        },
      });
    }
    await call('/api/session', {
      method: 'POST', token: run.token, body: { sessionId: run.payload.session.id },
    });
  }

  const results = await call(`/api/challenge?slug=${slug}`, { token: host.body.token });
  assert.equal(results.status, 200);
  assert.equal(results.body.participants.length, 2);
  assert.ok(results.body.participants.every((p) => p.completed));
  assert.ok(['decided', 'tie'].includes(results.body.outcome.status));
  assert.ok(results.body.shareText.includes('—'), 'share text lists the scores');

  // Replaying a finished challenge is refused.
  const replay = await call('/api/challenge?action=join', {
    method: 'POST', token: host.body.token, body: { slug },
  });
  assert.equal(replay.status, 409);
});

describe('the daily challenge is identical for everyone and scored once', async () => {
  const one = await call('/api/player', { method: 'POST', body: { displayName: 'DailyOne' } });
  const two = await call('/api/player', { method: 'POST', body: { displayName: 'DailyTwo' } });

  const runOne = await call('/api/daily-challenge', { method: 'POST', token: one.body.token });
  const runTwo = await call('/api/daily-challenge', { method: 'POST', token: two.body.token });
  assert.equal(runOne.status, 201);

  assert.deepEqual(
    runOne.body.questions.map((q) => q.id),
    runTwo.body.questions.map((q) => q.id),
    'every player gets the same daily set',
  );
  assert.deepEqual(
    runOne.body.questions.map((q) => q.answers),
    runTwo.body.questions.map((q) => q.answers),
    'daily answer placement is identical for everyone',
  );

  for (const q of runOne.body.questions) {
    await call('/api/answer', {
      method: 'POST',
      token: one.body.token,
      body: { sessionId: runOne.body.session.id, questionId: q.id, selectedAnswer: 0, responseMs: 3000 },
    });
  }
  await call('/api/session', {
    method: 'POST', token: one.body.token, body: { sessionId: runOne.body.session.id },
  });

  const replay = await call('/api/daily-challenge', { method: 'POST', token: one.body.token });
  assert.equal(replay.status, 201, 'a replay after completion is allowed, but as practice');
  assert.equal(replay.body.session.isPractice, true, 'the daily challenge is scored once per player');

  const status = await call('/api/daily-challenge', { token: one.body.token });
  assert.equal(status.body.played, true);
  assert.ok(status.body.yourResult.score >= 0);

  const board = await call('/api/daily-challenge?view=leaderboard&scope=global');
  assert.equal(board.status, 200);
  assert.ok(board.body.entries.length >= 1);
  assert.ok('completionMs' in board.body.entries[0]);
  assert.ok('accuracy' in board.body.entries[0]);
});

describe('account recovery moves a player to a new device', async () => {
  const player = await call('/api/player', { method: 'POST', body: { displayName: 'Mover' } });
  const code = await call('/api/player?action=recovery-code', {
    method: 'POST', token: player.body.token, body: {},
  });
  assert.match(code.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const claimed = await call('/api/player?action=claim', {
    method: 'POST', body: { code: code.body.code },
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.player.id, player.body.player.id);
  assert.notEqual(claimed.body.token, player.body.token, 'the token rotates on claim');

  // The code is single use.
  const reuse = await call('/api/player?action=claim', {
    method: 'POST', body: { code: code.body.code },
  });
  assert.equal(reuse.status, 404);
});

describe('unauthenticated gameplay is refused', async () => {
  const quiz = await call('/api/daily-challenge?category=geography', { method: 'POST', body: {} });
  assert.equal(quiz.status, 401);
  const session = await call('/api/session', { method: 'POST', body: {} });
  assert.equal(session.status, 401);
  const answer = await call('/api/answer', { method: 'POST', body: {} });
  assert.equal(answer.status, 401);
});
