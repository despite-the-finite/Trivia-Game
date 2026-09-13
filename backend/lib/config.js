/**
 * Central configuration. Every secret is read from the environment and is only
 * ever referenced from backend code — nothing here reaches the browser.
 */

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const CATEGORIES = ['current-events', 'science', 'geography', 'general-knowledge'];
export const PLAYABLE_CATEGORIES = [...CATEGORIES, 'mixed'];

export const CATEGORY_LABELS = {
  'current-events': 'Current Events',
  science: 'Science',
  geography: 'Geography',
  'general-knowledge': 'General Knowledge',
  mixed: 'Mixed',
};

/**
 * Freshness policy per category. Every category now materializes one fixed,
 * shared question set per UTC day (see dailyChallengeService), so `targetPool`
 * only needs to comfortably cover that day's quiz plus validation attrition —
 * not a large rotating bank. `ttlMs` is kept a little above `refreshEveryMs` as
 * a safety buffer; `refreshEveryMs` is how often the pipeline re-gathers source
 * material.
 */
export const FRESHNESS = {
  'current-events': {
    refreshEveryMs: int(process.env.REFRESH_CURRENT_EVENTS_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_CURRENT_EVENTS_MS, 48 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_CURRENT_EVENTS, 20),
    batchSize: int(process.env.BATCH_CURRENT_EVENTS, 30),
  },
  science: {
    refreshEveryMs: int(process.env.REFRESH_SCIENCE_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_SCIENCE_MS, 48 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_SCIENCE, 20),
    batchSize: int(process.env.BATCH_SCIENCE, 30),
  },
  geography: {
    refreshEveryMs: int(process.env.REFRESH_GEOGRAPHY_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_GEOGRAPHY_MS, 48 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_GEOGRAPHY, 20),
    batchSize: int(process.env.BATCH_GEOGRAPHY, 30),
  },
  'general-knowledge': {
    refreshEveryMs: int(process.env.REFRESH_GENERAL_KNOWLEDGE_MS, 24 * 60 * 60 * 1000), // 24 hours
    ttlMs: int(process.env.TTL_GENERAL_KNOWLEDGE_MS, 48 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_GENERAL_KNOWLEDGE, 20),
    batchSize: int(process.env.BATCH_GENERAL_KNOWLEDGE, 30),
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
    'EntropicBrainwavesBot/1.0 (+https://github.com/despite-the-finite/Trivia-Game)',
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 12000),
};

export function assertConfigured() {
  if (!APP.databaseUrl) {
    throw new Error('DATABASE_URL is not set. The API cannot run without a database.');
  }
}
