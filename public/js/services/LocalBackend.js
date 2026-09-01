import { seededRandom, shuffle, uuid } from '../lib/rng.js';
import { scoreAnswer, reconcileResponseTime, scoringRules, SCORING } from '../lib/scoring.js';

/**
 * LocalBackend — the API, reimplemented inside the browser.
 *
 * The hosted game is server-authoritative by design: the page never sees an
 * answer key and never computes a score. That design has one cost, which is the
 * reason this file exists — without a Postgres instance and a deployment, there
 * is no game at all. LocalBackend answers exactly the routes `api/` answers,
 * with the same request and response shapes, reading from a question bank
 * generated at build time and keeping state in localStorage. ApiClient hands it
 * requests when no server responds, so every screen above it is unchanged.
 *
 * What is honestly different in local mode, and why:
 *
 *   * Current Events is absent. It cannot be pre-generated without going stale,
 *     which is the premise of the whole project. Geography and Science can.
 *   * Scoring happens in the page. There is nobody else to do it. A player who
 *     opens devtools can give themselves points, and they are the only person
 *     who would ever see them — the score never leaves the device.
 *   * Friends, global boards and head-to-head challenges are unavailable.
 *     Those are inherently multi-player and need a server holding both sides.
 *
 * Everything else — the daily challenge, quick play, streaks, the speed bonus,
 * the timer, review with sources, personal stats — behaves as it does live.
 */

const STORAGE_KEY = 'live-trivia.local';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_QUESTION_COUNT = 10;
const DAILY_QUESTION_COUNT = 10;
const MAX_QUESTION_COUNT = 20;
const CATEGORIES = ['current-events', 'science', 'geography'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
/** Enough history to stop a run repeating what you just answered. */
const RECENT_MEMORY = 150;

export class LocalApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new LocalApiError(400, 'bad_request', message);
const notFound = (message) => new LocalApiError(404, 'not_found', message);
const conflict = (message) => new LocalApiError(409, 'conflict', message);
const unsupported = (message) => new LocalApiError(501, 'local_mode_unsupported', message);

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * Friend codes are generated even though local mode has no friends: the account
 * shape is shared with the hosted game, and showing a blank where a code goes
 * looks like a bug rather than a design decision.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function friendCode(displayName = '') {
  const random = (n) =>
    Array.from({ length: n }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  const stem = displayName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  return `${stem.length >= 3 ? stem : random(5)}-${random(4)}`;
}

function sanitizeDisplayName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1) throw badRequest('Pick a display name.');
  if (name.length > 24) throw badRequest('That name is too long (24 characters max).');
  return name;
}

function emptyStats() {
  return {
    totalScore: 0,
    gamesPlayed: 0,
    questionsAnswered: 0,
    correctAnswers: 0,
    incorrectAnswers: 0,
    currentStreak: 0,
    bestStreak: 0,
    totalResponseMs: 0,
    categoryScores: { 'current-events': 0, science: 0, geography: 0 },
    difficultyCorrect: { easy: 0, medium: 0, hard: 0 },
    bestGameScore: 0,
    bestGameAccuracy: 0,
    bestDailyScore: 0,
  };
}

function emptyState() {
  return {
    version: 1,
    player: null,
    stats: emptyStats(),
    sessions: {},
    scoreEvents: [],
    recent: [],
  };
}

// ---------------------------------------------------------------------------

export class LocalBackend {
  /**
   * @param {object} bank Parsed public/data/question-bank.json.
   * @param {Storage} storage Injectable so tests can run without a browser.
   */
  constructor(bank, storage = globalThis.localStorage) {
    this.bank = bank;
    this.questions = bank.questions ?? [];
    this.byId = new Map(this.questions.map((q) => [q.id, q]));
    /** Only categories actually present can be offered in the UI. */
    this.categories = [...new Set(this.questions.map((q) => q.category))].sort();
    this.storage = storage;
    this.state = this.#load();
  }

  // --- Persistence -------------------------------------------------------

  #load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      const parsed = JSON.parse(raw);
      // A partial or older record still yields a usable game rather than an
      // exception on boot; missing keys simply fall back to their empty form.
      return { ...emptyState(), ...parsed, stats: { ...emptyStats(), ...(parsed.stats ?? {}) } };
    } catch {
      return emptyState();
    }
  }

  #save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Private browsing, or the quota is full. The game still plays; it just
      // will not survive a reload, which beats refusing to start.
    }
  }

  #requirePlayer() {
    if (!this.state.player) {
      throw new LocalApiError(401, 'unauthorized', 'Set up a player first.');
    }
    return this.state.player;
  }

  // --- Question selection ------------------------------------------------

  #pool({ category, difficulty }) {
    const wanted = category === 'mixed' ? this.categories : [category];
    return this.questions.filter(
      (q) => wanted.includes(q.category) && (!difficulty || q.difficulty === difficulty),
    );
  }

  /**
   * Mirrors pickBalancedSet: an even spread across categories for `mixed`,
   * avoiding anything the player answered recently, and topping up from the
   * whole pool if a category comes up short.
   */
  #pick({ category, difficulty, count, rng = Math.random, avoidRecent = true }) {
    const recent = avoidRecent ? new Set(this.state.recent ?? []) : new Set();
    const chosen = [];
    const used = new Set();

    const drawFrom = (pool, n) => {
      const fresh = shuffle(pool.filter((q) => !used.has(q.id) && !recent.has(q.id)), rng);
      const stale = shuffle(pool.filter((q) => !used.has(q.id) && recent.has(q.id)), rng);
      // Recently-seen questions are the fallback, never the first choice, so a
      // small bank degrades into repetition gracefully instead of running dry.
      for (const q of [...fresh, ...stale].slice(0, n)) {
        used.add(q.id);
        chosen.push(q);
      }
    };

    if (category === 'mixed') {
      const perCategory = Math.ceil(count / this.categories.length);
      for (const cat of shuffle(this.categories, rng)) {
        drawFrom(this.#pool({ category: cat, difficulty }), perCategory);
      }
    } else {
      drawFrom(this.#pool({ category, difficulty }), count);
    }

    if (chosen.length < count) drawFrom(this.#pool({ category, difficulty }), count - chosen.length);

    return shuffle(chosen, rng).slice(0, count);
  }

  #answerOrders(questions, rng = Math.random) {
    const orders = {};
    for (const q of questions) orders[q.id] = shuffle(q.answers.map((_, i) => i), rng);
    return orders;
  }

  #shapeForPlay(session) {
    const questions = session.questionIds.map((id) => this.byId.get(id)).filter(Boolean);
    return {
      session: {
        id: session.id,
        mode: session.mode,
        category: session.category,
        difficulty: session.difficulty,
        challengeId: null,
        dailyDate: session.dailyDate ?? null,
        questionCount: session.questionIds.length,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
      },
      questions: questions.map((q, position) => ({
        id: q.id,
        position,
        category: q.category,
        difficulty: q.difficulty,
        question: q.question,
        answers: (session.answerOrders[q.id] ?? q.answers.map((_, i) => i)).map((i) => q.answers[i]),
      })),
      scoring: scoringRules(),
    };
  }

  #createSession({ mode, category, difficulty, questions, answerOrders, dailyDate = null }) {
    const session = {
      id: uuid(),
      mode,
      category,
      difficulty,
      dailyDate,
      questionIds: questions.map((q) => q.id),
      answerOrders,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      completedAt: null,
      answers: [],
    };
    this.state.sessions[session.id] = session;

    this.state.recent = [...session.questionIds, ...(this.state.recent ?? [])].slice(0, RECENT_MEMORY);
    this.#save();
    return session;
  }

  #getSession(id) {
    const session = this.state.sessions[id];
    if (!session) throw notFound('Session not found.');
    return session;
  }

  // --- Stats -------------------------------------------------------------

  #shapeStats() {
    const s = this.state.stats;
    const answered = s.questionsAnswered || 0;
    const since = (from) =>
      this.state.scoreEvents
        .filter((e) => new Date(e.at).valueOf() >= from)
        .reduce((sum, e) => sum + e.points, 0);

    const now = new Date();
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // Weeks start Monday, matching date_trunc('week') in the live boards.
    const dayOfWeek = (now.getUTCDay() + 6) % 7;
    const startOfWeek = startOfDay - dayOfWeek * 86400000;
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

    return {
      totalScore: s.totalScore,
      gamesPlayed: s.gamesPlayed,
      questionsAnswered: answered,
      correctAnswers: s.correctAnswers,
      incorrectAnswers: s.incorrectAnswers,
      accuracy: answered ? Math.round((s.correctAnswers / answered) * 1000) / 10 : 0,
      currentStreak: s.currentStreak,
      bestStreak: s.bestStreak,
      averageResponseMs: answered ? Math.round(s.totalResponseMs / answered) : 0,
      categoryScores: s.categoryScores,
      difficultyCorrect: s.difficultyCorrect,
      dailyScore: since(startOfDay),
      weeklyScore: since(startOfWeek),
      monthlyScore: since(startOfMonth),
      allTimeScore: s.totalScore,
      personalBests: {
        gameScore: s.bestGameScore,
        gameAccuracy: s.bestGameAccuracy,
        bestStreak: s.bestStreak,
        dailyChallengeScore: s.bestDailyScore,
      },
    };
  }

  // --- Routes ------------------------------------------------------------

  /**
   * Same signature as ApiClient.request, so ApiClient can delegate verbatim.
   * @returns {Promise<object>}
   */
  async request(path, { method = 'GET', body = null, query = {} } = {}) {
    const route = `${method} ${path}`;
    const handler = this.#route(route);
    if (!handler) throw notFound(`No local handler for ${route}.`);
    // Async so callers cannot come to depend on local mode resolving
    // synchronously — the hosted API never will.
    return handler.call(this, { body: body ?? {}, query: query ?? {} });
  }

  #route(route) {
    return {
      'GET /health': this.#health,
      'GET /trivia': this.#trivia,
      'GET /player': this.#getPlayer,
      'POST /player': this.#postPlayer,
      'PATCH /player': this.#patchPlayer,
      'POST /session': this.#postSession,
      'GET /session': this.#getSessionRoute,
      'POST /answer': this.#postAnswer,
      'GET /daily-challenge': this.#getDaily,
      'POST /daily-challenge': this.#postDaily,
      'GET /leaderboard': this.#getLeaderboard,
      'GET /friends': this.#friendsUnsupported,
      'POST /friends': this.#friendsUnsupported,
      'DELETE /friends': this.#friendsUnsupported,
      'GET /challenge': this.#challengeUnsupported,
      'POST /challenge': this.#challengeUnsupported,
    }[route];
  }

  #health() {
    return {
      status: 'ok',
      mode: 'local',
      questionCount: this.questions.length,
      categories: this.categories,
    };
  }

  /** The redacted read of the bank, matching GET /api/trivia without a key. */
  #trivia({ query }) {
    const category = this.#normalizeCategory(query.category);
    const difficulty = this.#normalizeDifficulty(query.difficulty);
    const count = Math.min(Number.parseInt(query.count ?? '10', 10) || 10, 50);
    const questions = this.#pick({ category, difficulty, count, avoidRecent: false });
    const orders = this.#answerOrders(questions);
    return {
      category,
      difficulty: difficulty ?? 'any',
      count: questions.length,
      requested: count,
      answersIncluded: false,
      questions: questions.map((q, position) => ({
        id: q.id,
        position,
        category: q.category,
        difficulty: q.difficulty,
        question: q.question,
        answers: orders[q.id].map((i) => q.answers[i]),
      })),
    };
  }

  #getPlayer({ query }) {
    if (query.id) throw unsupported('Other players are only visible with the live backend.');
    return { player: this.#requirePlayer(), stats: this.#shapeStats() };
  }

  #postPlayer({ body, query }) {
    const action = (query.action ?? body.action ?? 'create').toLowerCase();

    if (action === 'create') {
      const displayName = sanitizeDisplayName(body.displayName);
      this.state.player = {
        id: uuid(),
        displayName,
        friendCode: friendCode(displayName),
        isAnonymous: true,
        createdAt: new Date().toISOString(),
      };
      this.#save();
      // The token is meaningless locally — nothing verifies it — but ApiClient
      // stores one, and returning the same shape keeps that path identical.
      return { player: this.state.player, token: `local.${this.state.player.id}`, stats: this.#shapeStats() };
    }

    if (action === 'recovery-code' || action === 'claim') {
      throw unsupported(
        'Moving an account between devices needs the live backend — a local game lives in this browser only.',
      );
    }

    throw badRequest('Unknown action.');
  }

  #patchPlayer({ body }) {
    const player = this.#requirePlayer();
    player.displayName = sanitizeDisplayName(body.displayName);
    this.#save();
    return { player };
  }

  #normalizeCategory(value) {
    if (value === undefined || value === null || value === '') return 'mixed';
    const v = String(value).toLowerCase();
    if (v === 'mixed') return v;
    if (!CATEGORIES.includes(v)) throw badRequest('Unknown category.');
    if (!this.categories.includes(v)) {
      throw unsupported(
        'Current Events questions are written from live news, so they need the online backend. Try Science or Geography.',
      );
    }
    return v;
  }

  #normalizeDifficulty(value) {
    if (value === undefined || value === null || value === '' || value === 'any') return null;
    const v = String(value).toLowerCase();
    if (!DIFFICULTIES.includes(v)) throw badRequest('Unknown difficulty.');
    return v;
  }

  #postSession({ body, query }) {
    const action = (query.action ?? body.action ?? (body.sessionId ? 'finish' : 'start')).toLowerCase();
    if (action === 'finish') return this.#finish(body.sessionId ?? query.id);
    if (action !== 'start') throw badRequest('Unknown action. Expected start or finish.');

    this.#requirePlayer();
    const category = this.#normalizeCategory(body.category);
    const difficulty = this.#normalizeDifficulty(body.difficulty);
    const count = Math.min(
      Math.max(Number.parseInt(body.count ?? DEFAULT_QUESTION_COUNT, 10) || DEFAULT_QUESTION_COUNT, 1),
      MAX_QUESTION_COUNT,
    );

    const questions = this.#pick({ category, difficulty, count });
    if (!questions.length) {
      throw new LocalApiError(503, 'unavailable', 'No questions match that filter in the offline bank.');
    }

    const session = this.#createSession({
      mode: 'quick',
      category,
      difficulty,
      questions,
      answerOrders: this.#answerOrders(questions),
    });
    return this.#shapeForPlay(session);
  }

  #getSessionRoute({ query }) {
    this.#requirePlayer();
    const session = this.#getSession(query.id);
    if (query.view === 'review') return { sessionId: session.id, questions: this.#review(session) };
    if (session.completedAt) return this.#finish(session.id);

    return {
      ...this.#shapeForPlay(session),
      answered: session.answers.map((a) => ({
        questionId: a.questionId,
        correct: a.correct,
        points: a.points,
      })),
    };
  }

  #postAnswer({ body }) {
    this.#requirePlayer();
    const session = this.#getSession(body.sessionId);
    if (session.completedAt) throw conflict('This game is already finished.');
    if (new Date(session.expiresAt) < new Date()) throw conflict('This game has expired. Start a new one.');

    const question = this.byId.get(body.questionId);
    if (!question) throw notFound('Question not found.');
    const position = session.questionIds.indexOf(body.questionId);
    if (position === -1) throw badRequest('That question is not part of this game.');
    if (session.answers.some((a) => a.questionId === body.questionId)) {
      throw conflict('You have already answered that question in this game.');
    }

    const order = session.answerOrders[question.id] ?? question.answers.map((_, i) => i);

    let canonicalIndex = null;
    if (body.selectedAnswer !== null && body.selectedAnswer !== undefined) {
      const idx = Number.parseInt(body.selectedAnswer, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= order.length) {
        throw badRequest('selectedAnswer is out of range for this question.');
      }
      canonicalIndex = order[idx];
    }
    const correct = canonicalIndex !== null && canonicalIndex === question.correctIndex;

    // The same reconciliation the server does, against the same clock the
    // session was started on. It cannot defend against a determined local
    // player, but it does keep an accidentally-paused tab from banking a
    // twenty-second answer as instant.
    const spent = session.answers.reduce((sum, a) => sum + a.responseMs, 0);
    const timing = reconcileResponseTime({
      clientMs: Number(body.responseMs),
      serverElapsedMs: Math.max(0, Date.now() - new Date(session.startedAt).valueOf() - spent),
    });

    const result = scoreAnswer({
      correct,
      difficulty: question.difficulty,
      responseMs: timing.responseMs,
      currentStreak: this.state.stats.currentStreak,
      flags: timing.flags,
    });

    session.answers.push({
      questionId: question.id,
      position,
      selectedIndex: canonicalIndex,
      correct,
      points: result.points,
      responseMs: timing.responseMs,
      streakAfter: result.newStreak,
    });

    const stats = this.state.stats;
    stats.questionsAnswered += 1;
    stats.totalScore += result.points;
    stats.totalResponseMs += timing.responseMs;
    stats.currentStreak = result.newStreak;
    stats.bestStreak = Math.max(stats.bestStreak, result.newStreak);
    if (correct) {
      stats.correctAnswers += 1;
      stats.difficultyCorrect[question.difficulty] += 1;
    } else {
      stats.incorrectAnswers += 1;
    }
    stats.categoryScores[question.category] =
      (stats.categoryScores[question.category] ?? 0) + result.points;
    this.state.scoreEvents.push({ at: new Date().toISOString(), points: result.points });
    this.#save();

    return {
      correct,
      pointsEarned: result.points,
      basePoints: result.basePoints,
      speedBonus: result.speedBonus,
      streakMultiplier: result.streakMultiplier,
      streakLabel: result.streakLabel,
      streak: result.newStreak,
      responseMs: timing.responseMs,
      correctIndex: order.indexOf(question.correctIndex),
      correctAnswer: question.answers[question.correctIndex],
      explanation: question.explanation,
      source: question.source,
      sourceUrl: question.sourceUrl,
      sourcePublishedAt: null,
      answered: session.answers.length,
      questionCount: session.questionIds.length,
    };
  }

  #finish(sessionId) {
    const player = this.#requirePlayer();
    const session = this.#getSession(sessionId);
    const answers = [...session.answers].sort((a, b) => a.position - b.position);

    const totalScore = answers.reduce((sum, a) => sum + a.points, 0);
    const correctCount = answers.filter((a) => a.correct).length;
    const accuracy = answers.length ? Math.round((correctCount / answers.length) * 1000) / 10 : 0;
    const bestStreak = answers.reduce((max, a) => Math.max(max, a.streakAfter), 0);
    const totalResponseMs = answers.reduce((sum, a) => sum + a.responseMs, 0);

    if (!session.completedAt) {
      session.completedAt = new Date().toISOString();
      session.totalScore = totalScore;
      session.correctCount = correctCount;
      session.accuracy = accuracy;
      session.bestStreak = bestStreak;

      const stats = this.state.stats;
      stats.gamesPlayed += 1;
      stats.bestGameScore = Math.max(stats.bestGameScore, totalScore);
      stats.bestGameAccuracy = Math.max(stats.bestGameAccuracy, accuracy);
      if (session.mode === 'daily') stats.bestDailyScore = Math.max(stats.bestDailyScore, totalScore);
      this.#save();
    }

    return {
      session: {
        id: session.id,
        mode: session.mode,
        category: session.category,
        difficulty: session.difficulty,
        challengeId: null,
        dailyDate: session.dailyDate ?? null,
        completedAt: session.completedAt,
      },
      result: {
        score: session.totalScore ?? totalScore,
        correct: session.correctCount ?? correctCount,
        total: session.questionIds.length,
        answered: answers.length,
        accuracy: session.accuracy ?? accuracy,
        bestStreak: session.bestStreak ?? bestStreak,
        averageResponseMs: answers.length ? Math.round(totalResponseMs / answers.length) : 0,
        totalResponseMs,
      },
      // The live game compares you with your friends here. Local play compares
      // you with yourself, which is the only honest comparison available.
      comparison: this.#personalComparison(player, session.totalScore ?? totalScore),
    };
  }

  #personalComparison(player, score) {
    const previous = Object.values(this.state.sessions)
      .filter((s) => s.completedAt)
      .map((s) => s.totalScore ?? 0);
    if (previous.length <= 1) return null;

    const best = Math.max(...previous);
    const better = previous.filter((s) => s > score).length;
    return {
      scope: 'personal',
      period: 'all',
      rank: better + 1,
      of: previous.length,
      weeklyScore: score,
      playerAhead: score < best ? { displayName: 'Your best run', weeklyScore: best, gap: best - score } : null,
    };
  }

  #review(session) {
    if (!session.completedAt) throw conflict('Finish the game before reviewing it.');
    return [...session.answers]
      .sort((a, b) => a.position - b.position)
      .map((a) => {
        const q = this.byId.get(a.questionId);
        return {
          id: q.id,
          position: a.position,
          category: q.category,
          difficulty: q.difficulty,
          question: q.question,
          yourAnswer: a.selectedIndex === null ? null : q.answers[a.selectedIndex],
          correctAnswer: q.answers[q.correctIndex],
          correct: a.correct,
          points: a.points,
          responseMs: a.responseMs,
          explanation: q.explanation,
          source: q.source,
          sourceUrl: q.sourceUrl,
        };
      });
  }

  // --- Daily challenge ---------------------------------------------------

  /**
   * The day's set is derived from the date, not stored — so it is identical on
   * every device running the same bank, without anything to synchronise.
   */
  #materialiseDay(day) {
    const rng = seededRandom(`daily:${day}`);
    const questions = this.#pick({
      category: 'mixed',
      difficulty: null,
      count: DAILY_QUESTION_COUNT,
      rng,
      avoidRecent: false,
    });
    return { day, questions, answerOrders: this.#answerOrders(questions, seededRandom(`daily-order:${day}`)) };
  }

  #dailyAttempt(day) {
    return Object.values(this.state.sessions).find((s) => s.mode === 'daily' && s.dailyDate === day);
  }

  #getDaily({ query }) {
    const day = todayUtc();
    if (query.view === 'leaderboard') {
      const attempt = this.#dailyAttempt(day);
      return {
        day,
        scope: 'local',
        entries:
          attempt?.completedAt && this.state.player
            ? [
                {
                  rank: 1,
                  playerId: this.state.player.id,
                  displayName: this.state.player.displayName,
                  score: attempt.totalScore ?? 0,
                  accuracy: attempt.accuracy ?? 0,
                  completionMs: attempt.answers.reduce((sum, a) => sum + a.responseMs, 0),
                  isViewer: true,
                },
              ]
            : [],
      };
    }

    const daily = this.#materialiseDay(day);
    const attempt = this.#dailyAttempt(day);
    return {
      day,
      questionCount: daily.questions.length,
      played: Boolean(attempt?.completedAt),
      inProgress: Boolean(attempt && !attempt.completedAt),
      yourResult: attempt?.completedAt
        ? {
            sessionId: attempt.id,
            score: attempt.totalScore ?? 0,
            correct: attempt.correctCount ?? 0,
            total: daily.questions.length,
            accuracy: attempt.accuracy ?? 0,
            completedAt: attempt.completedAt,
          }
        : null,
      globalStats: { playersCompleted: 0, averageScore: 0 },
      shareUrl: globalThis.location?.origin ?? '',
    };
  }

  #postDaily() {
    this.#requirePlayer();
    const day = todayUtc();
    const existing = this.#dailyAttempt(day);
    if (existing?.completedAt) throw conflict("You have already played today's challenge.");
    if (existing) return this.#shapeForPlay(existing);

    const daily = this.#materialiseDay(day);
    if (!daily.questions.length) {
      throw new LocalApiError(503, 'unavailable', "Today's challenge could not be built.");
    }
    return this.#shapeForPlay(
      this.#createSession({
        mode: 'daily',
        category: 'mixed',
        difficulty: null,
        questions: daily.questions,
        answerOrders: daily.answerOrders,
        dailyDate: day,
      }),
    );
  }

  // --- Boards ------------------------------------------------------------

  /**
   * With no other players to rank against, the board becomes your own run
   * history — which is the thing a solo player actually wants to beat.
   */
  #getLeaderboard({ query }) {
    const player = this.#requirePlayer();
    const period = ['today', 'week', 'month', 'all'].includes(query.period) ? query.period : 'all';
    const cutoffs = { today: 86400000, week: 7 * 86400000, month: 30 * 86400000, all: Infinity };
    const cutoff = Date.now() - cutoffs[period];

    const runs = Object.values(this.state.sessions)
      .filter((s) => s.completedAt && new Date(s.completedAt).valueOf() >= cutoff)
      .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0))
      .slice(0, Number.parseInt(query.limit ?? '50', 10) || 50);

    return {
      period,
      scope: 'personal',
      board: 'runs',
      unit: 'points',
      entries: runs.map((s, i) => ({
        rank: i + 1,
        playerId: player.id,
        displayName: `${s.mode === 'daily' ? 'Daily' : labelFor(s.category)} · ${formatDay(s.completedAt)}`,
        value: s.totalScore ?? 0,
        accuracy: s.accuracy ?? 0,
        questionsAnswered: s.answers.length,
        isViewer: i === 0,
      })),
    };
  }

  #friendsUnsupported() {
    throw unsupported('Friends need the live backend — a local game has nobody to compare with.');
  }

  #challengeUnsupported() {
    throw unsupported(
      'Head-to-head challenges need the live backend to hold both players’ runs. Local play is solo.',
    );
  }
}

const labelFor = (category) =>
  ({ 'current-events': 'Current Events', science: 'Science', geography: 'Geography', mixed: 'Mixed' })[
    category
  ] ?? 'Quick play';

const formatDay = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
