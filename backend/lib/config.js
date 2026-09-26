/**
 * Central configuration. Every secret is read from the environment and is only
 * ever referenced from backend code — nothing here reaches the browser.
 */

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const CATEGORIES = ['current-events', 'science', 'geography', 'general-knowledge'];
export const PLAYABLE_CATEGORIES = CATEGORIES;

export const CATEGORY_LABELS = {
  'current-events': 'Current Events',
  science: 'Science',
  geography: 'Geography',
  'general-knowledge': 'General Knowledge',
};

/**
 * Freshness policy per category. Every category materializes one fixed, shared
 * 10-question quiz per game day (see dailyChallengeService), so each daily
 * refresh only generates `batchSize` (13) questions: the day's quiz plus a
 * little headroom for validation attrition. Keeping the batch small keeps each
 * refresh's LLM call well inside the function time limit. `ttlMs` is kept
 * above `refreshEveryMs` as a safety buffer; `refreshEveryMs` is how often the
 * pipeline re-gathers source material.
 */
export const FRESHNESS = {
  'current-events': {
    refreshEveryMs: int(process.env.REFRESH_CURRENT_EVENTS_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_CURRENT_EVENTS_MS, 48 * 60 * 60 * 1000),
    batchSize: int(process.env.BATCH_CURRENT_EVENTS, 13),
  },
  science: {
    refreshEveryMs: int(process.env.REFRESH_SCIENCE_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_SCIENCE_MS, 48 * 60 * 60 * 1000),
    batchSize: int(process.env.BATCH_SCIENCE, 13),
  },
  geography: {
    refreshEveryMs: int(process.env.REFRESH_GEOGRAPHY_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_GEOGRAPHY_MS, 48 * 60 * 60 * 1000),
    batchSize: int(process.env.BATCH_GEOGRAPHY, 13),
  },
  'general-knowledge': {
    refreshEveryMs: int(process.env.REFRESH_GENERAL_KNOWLEDGE_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_GENERAL_KNOWLEDGE_MS, 48 * 60 * 60 * 1000),
    batchSize: int(process.env.BATCH_GENERAL_KNOWLEDGE, 13),
  },
};

export const SCORING = {
  base: int(process.env.SCORING_BASE_POINTS, 150),
  maxSpeedBonus: int(process.env.SCORING_MAX_SPEED_BONUS, 75),
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
  /** How long an unfinished session may be resumed / answered into. */
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 2 * 60 * 60 * 1000),
  /**
   * IANA timezone whose midnight ends the game day: the daily quizzes roll
   * over, leaderboards reset and content refreshes then. Defaults to Mountain
   * time (handles daylight saving).
   */
  timezone: process.env.GAME_TIMEZONE || 'America/Denver',
};

/**
 * Abuse-control ceilings. Account creation is per-IP, so operators whose users
 * share an egress address (schools, offices, carrier NAT) may need to raise it.
 */
export const LIMITS = {
  playerCreatePerHourPerIp: int(process.env.PLAYER_CREATE_LIMIT_PER_HOUR, 10),
  sessionsPerHour: int(process.env.SESSION_LIMIT_PER_HOUR, 60),
  answersPerHour: int(process.env.ANSWER_LIMIT_PER_HOUR, 400),
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
    'EntropicBrainwavesBot/1.0 (+https://github.com/despite-the-finite/Trivia-Game)',
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 12000),
};

export function assertConfigured() {
  if (!APP.databaseUrl) {
    throw new Error('DATABASE_URL is not set. The API cannot run without a database.');
  }
}
