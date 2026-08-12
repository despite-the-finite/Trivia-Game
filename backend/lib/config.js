/**
 * Central configuration. Every secret is read from the environment and is only
 * ever referenced from backend code — nothing here reaches the browser.
 */

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const CATEGORIES = ['current-events', 'science', 'geography'];
export const PLAYABLE_CATEGORIES = [...CATEGORIES, 'mixed'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

export const CATEGORY_LABELS = {
  'current-events': 'Current Events',
  science: 'Science',
  geography: 'Geography',
  mixed: 'Mixed',
};

/**
 * Freshness policy per category. `ttlMs` is how long a generated question stays
 * servable; `refreshEveryMs` is how often the pipeline re-gathers source
 * material. `targetPool` is how many live questions we try to keep banked so a
 * player request never has to wait on an upstream API or the LLM.
 */
export const FRESHNESS = {
  'current-events': {
    refreshEveryMs: int(process.env.REFRESH_CURRENT_EVENTS_MS, 45 * 60 * 1000), // ~45 min
    ttlMs: int(process.env.TTL_CURRENT_EVENTS_MS, 36 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_CURRENT_EVENTS, 80),
    batchSize: int(process.env.BATCH_CURRENT_EVENTS, 60),
  },
  science: {
    refreshEveryMs: int(process.env.REFRESH_SCIENCE_MS, 6 * 60 * 60 * 1000), // 6 hours
    ttlMs: int(process.env.TTL_SCIENCE_MS, 14 * 24 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_SCIENCE, 80),
    batchSize: int(process.env.BATCH_SCIENCE, 60),
  },
  geography: {
    refreshEveryMs: int(process.env.REFRESH_GEOGRAPHY_MS, 30 * 24 * 60 * 60 * 1000), // 30 days
    ttlMs: int(process.env.TTL_GEOGRAPHY_MS, 60 * 24 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_GEOGRAPHY, 150),
    batchSize: int(process.env.BATCH_GEOGRAPHY, 120),
  },
};

export const SCORING = {
  base: { easy: 100, medium: 150, hard: 200 },
  maxSpeedBonus: { easy: 50, medium: 75, hard: 100 },
  /** Answers at or under this are treated as "instant" and earn the full bonus. */
  fullBonusMs: int(process.env.SPEED_FULL_BONUS_MS, 2000),
  /** Per-question time limit. At or beyond this, the speed bonus is zero. */
  questionTimeLimitMs: int(process.env.QUESTION_TIME_LIMIT_MS, 20000),
  /**
   * Below this, a human could not have read the question. Such answers still
   * score base points if correct, but earn no speed bonus — so mashing a button
   * is never better than reading.
   */
  minPlausibleMs: int(process.env.MIN_PLAUSIBLE_RESPONSE_MS, 750),
  /** Allowance for network latency when reconciling client vs server timing. */
  networkGraceMs: int(process.env.NETWORK_GRACE_MS, 1500),
  streakBonuses: [
    { min: 10, multiplier: 1.3, label: '+30%' },
    { min: 5, multiplier: 1.2, label: '+20%' },
    { min: 3, multiplier: 1.1, label: '+10%' },
  ],
};

export const GAME = {
  defaultQuestionCount: int(process.env.DEFAULT_QUESTION_COUNT, 10),
  maxQuestionCount: int(process.env.MAX_QUESTION_COUNT, 20),
  dailyQuestionCount: int(process.env.DAILY_QUESTION_COUNT, 10),
  challengeQuestionCount: int(process.env.CHALLENGE_QUESTION_COUNT, 10),
  /** How long an unfinished session may be resumed / answered into. */
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 2 * 60 * 60 * 1000),
  challengeTtlMs: int(process.env.CHALLENGE_TTL_MS, 14 * 24 * 60 * 60 * 1000),
};

/**
 * Abuse-control ceilings. Account creation is per-IP, so operators whose users
 * share an egress address (schools, offices, carrier NAT) may need to raise it.
 */
export const LIMITS = {
  playerCreatePerHourPerIp: int(process.env.PLAYER_CREATE_LIMIT_PER_HOUR, 10),
  sessionsPerHour: int(process.env.SESSION_LIMIT_PER_HOUR, 60),
  answersPerHour: int(process.env.ANSWER_LIMIT_PER_HOUR, 400),
  friendAddsPerHour: int(process.env.FRIEND_ADD_LIMIT_PER_HOUR, 30),
  challengesPerHour: int(process.env.CHALLENGE_LIMIT_PER_HOUR, 30),
  recoveryCodesPerHour: int(process.env.RECOVERY_CODE_LIMIT_PER_HOUR, 5),
};

export const LLM = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  effort: process.env.ANTHROPIC_EFFORT || 'medium',
  maxTokens: int(process.env.ANTHROPIC_MAX_TOKENS, 16000),
  enabled: Boolean(process.env.ANTHROPIC_API_KEY),
};

export const APP = {
  databaseUrl: process.env.DATABASE_URL,
  publicUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  cronSecret: process.env.CRON_SECRET,
  /** Server-to-server key that unlocks the full question record on /api/trivia. */
  adminKey: process.env.TRIVIA_ADMIN_KEY,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  userAgent:
    process.env.FETCH_USER_AGENT ||
    'LiveTriviaBot/1.0 (+https://github.com/despite-the-finite/Trivia-Game)',
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 12000),
};

export function assertConfigured() {
  if (!APP.databaseUrl) {
    throw new Error('DATABASE_URL is not set. The API cannot run without a database.');
  }
}
