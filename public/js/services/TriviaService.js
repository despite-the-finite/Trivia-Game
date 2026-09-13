import { api } from './ApiClient.js';

/**
 * TriviaService — owns a run of questions on the client.
 *
 * What it deliberately does NOT do: decide whether an answer is correct, or
 * compute a score. It sends {questionId, selectedAnswer, responseMs} and renders
 * whatever the server says. There is nothing in the page to tamper with,
 * because the answer key was never sent to the page.
 *
 * The whole question list arrives with the session, so advancing between
 * questions costs nothing — the only per-question round trip is the answer
 * submission, which has to hit the server by design.
 */
export class TriviaService {
  constructor(client = api) {
    this.api = client;
    this.reset();
  }

  reset() {
    this.session = null;
    this.questions = [];
    this.scoring = null;
    this.index = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.correctCount = 0;
    this.answers = [];
    this.questionShownAt = 0;
  }

  get current() {
    return this.questions[this.index] ?? null;
  }

  get isFinished() {
    return this.index >= this.questions.length;
  }

  get progress() {
    return { current: Math.min(this.index + 1, this.questions.length), total: this.questions.length };
  }

  adopt(payload) {
    this.reset();
    this.session = payload.session;
    this.questions = payload.questions ?? [];
    this.scoring = payload.scoring ?? null;
    this.challenge = payload.challenge ?? null;

    // A resumed run tells us what was already answered; skip past those.
    if (Array.isArray(payload.answered) && payload.answered.length) {
      const done = new Set(payload.answered.map((a) => a.questionId));
      this.score = payload.answered.reduce((sum, a) => sum + a.points, 0);
      this.correctCount = payload.answered.filter((a) => a.correct).length;
      this.index = this.questions.findIndex((q) => !done.has(q.id));
      if (this.index === -1) this.index = this.questions.length;
    }
    return this;
  }

  /** Starts (or resumes) the given category's fixed quiz for today. */
  async startCategoryQuiz(category = 'mixed') {
    const payload = await this.api.post('/daily-challenge', {}, { category });
    return this.adopt(payload);
  }

  async startDailyChallenge() {
    return this.startCategoryQuiz('mixed');
  }

  async startChallenge(slug) {
    const payload = await this.api.post('/challenge', { slug }, { action: 'join' });
    return this.adopt(payload);
  }

  async resume(sessionId) {
    const payload = await this.api.get('/session', { id: sessionId });
    if (payload.result) return null; // already finished
    return this.adopt(payload);
  }

  /** Call as the question becomes visible; starts the client-side stopwatch. */
  markShown() {
    this.questionShownAt = performance.now();
  }

  /**
   * @param {number|null} selectedIndex Index of the option as displayed, or
   *   null when the timer expired.
   */
  async submitAnswer(selectedIndex) {
    const question = this.current;
    if (!question) throw new Error('No question in progress.');

    const responseMs = this.questionShownAt
      ? Math.round(performance.now() - this.questionShownAt)
      : null;

    const result = await this.api.post('/answer', {
      sessionId: this.session.id,
      questionId: question.id,
      selectedAnswer: selectedIndex,
      responseMs,
    });

    // The server is the source of truth for all of these.
    this.score += result.pointsEarned;
    this.streak = result.streak;
    this.bestStreak = Math.max(this.bestStreak, result.streak);
    if (result.correct) this.correctCount += 1;
    this.answers.push({ questionId: question.id, ...result });

    return result;
  }

  advance() {
    this.index += 1;
    return this.current;
  }

  async finish() {
    return this.api.post('/session', { sessionId: this.session.id }, { action: 'finish' });
  }

  async review(sessionId = this.session?.id) {
    const data = await this.api.get('/session', { id: sessionId, view: 'review' });
    return data.questions;
  }

  async dailyStatus(category = 'mixed') {
    return this.api.get('/daily-challenge', { category });
  }

  async dailyLeaderboard(scope = 'global', category = 'mixed') {
    return this.api.get('/daily-challenge', { view: 'leaderboard', scope, category });
  }
}

export const triviaService = new TriviaService();
