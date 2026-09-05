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
    batchSize: int(process.env.BATCH_CURRENT_EVENTS, 30),
  },
  science: {
    refreshEveryMs: int(process.env.REFRESH_SCIENCE_MS, 6 * 60 * 60 * 1000), // 6 hours
    ttlMs: int(process.env.TTL_SCIENCE_MS, 14 * 24 * 60 * 60 * 1000),
    targetPool: int(process.env.POOL_SCIENCE, 80),
    batchSize: int(process.env.BATCH_SCIENCE, 30),
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
  /**
   * How long a request may wait on a first-ever refresh when the bank is
   * completely empty. Deliberately far below the function time limit: a player
   * gets a clear "still being built" message rather than a platform timeout.
   */
  coldStartWaitMs: int(process.env.COLD_START_WAIT_MS, 12000),
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
  get apiKey() {
    return process.env.ANTHROPIC_API_KEY;
  },
  get enabled() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  effort: process.env.ANTHROPIC_EFFORT || 'medium',
  maxTokens: int(process.env.ANTHROPIC_MAX_TOKENS, 16000),
  /**
   * A generation that outlives the platform's function limit is killed with no
   * error we can log, so we time out first and record a real reason. On a
   * serverless invocation the budget is `maxDuration` in vercel.json minus room
   * to write the result; a command-line seed run has no such ceiling and is
   * given time to finish a large batch.
   */
  timeoutMs: int(process.env.ANTHROPIC_TIMEOUT_MS, process.env.VERCEL ? 45000 : 300000),
};

/**
 * True when this process is one of Vercel's serverless functions rather than a
 * long-lived server. A few behaviours differ there: work started after the
 * response is not guaranteed to run, and there is a hard wall-clock ceiling on
 * every invocation.
 */
export const IS_SERVERLESS = Boolean(process.env.VERCEL);

/**
 * The deployment's own public origin, when the platform tells us what it is.
 *
 * Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` to the project's stable
 * production hostname (which follows a custom domain once one is attached) and
 * `VERCEL_URL` to the hostname of this specific deployment. Neither includes a
 * scheme. Both are a fallback: the request's own Host header is preferred at
 * runtime, and `PUBLIC_BASE_URL` overrides everything.
 */
function platformOrigin() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host.replace(/\/+$/, '')}` : '';
}

/**
 * Deployment settings.
 *
 * The values that decide how the app presents itself to the outside world —
 * its public origin and who may call it cross-origin — are getters rather than
 * snapshots taken when this module first loaded. They are read on the request
 * path, they are the ones an operator is most likely to change in the Vercel
 * dashboard, and reading an environment variable costs nothing. It also means
 * the modules that depend on them no longer care whether they were imported
 * before or after a `.env` file was loaded, which is a real trap for the
 * command-line scripts.
 */
export const APP = {
  get databaseUrl() {
    return process.env.DATABASE_URL;
  },

  /**
   * Configured public origin, without a trailing slash. Optional: when it is
   * unset the API derives the origin from the incoming request, so share links
   * are correct on the *.vercel.app URL, on preview deployments and on a custom
   * domain without anyone having to remember to update a variable.
   */
  get publicUrl() {
    return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  },

  /** What the platform says this deployment's own hostname is. */
  get platformUrl() {
    return platformOrigin();
  },

  get cronSecret() {
    return process.env.CRON_SECRET;
  },

  /** Server-to-server key that unlocks the full question record on /api/trivia. */
  get adminKey() {
    return process.env.TRIVIA_ADMIN_KEY;
  },

  /**
   * Cross-origin callers allowed to use the API. Empty by default: the game and
   * its API are served from one origin, so no browser needs a CORS grant. Set
   * ALLOWED_ORIGINS only when another site must call this API directly.
   */
  get allowedOrigins() {
    return (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },

  userAgent:
    process.env.FETCH_USER_AGENT ||
    'LiveTriviaBot/1.0 (+https://github.com/despite-the-finite/Trivia-Game)',
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 12000),
};

export const CRON = {
  /**
   * How many categories one scheduled invocation may refresh. Each category is
   * an upstream fetch plus a model call; doing all three in one serverless
   * invocation reliably exceeds the function time limit, so by default a run
   * takes the single most-stale category and the next run takes the next one.
   */
  categoriesPerRun: Math.max(int(process.env.CRON_CATEGORIES_PER_RUN, 1), 1),
};

/**
 * Configuration problems that should stop a process rather than surface as a
 * confusing runtime error. Returns the list of problems; callers decide whether
 * to warn or to exit.
 */
export function configProblems({ requireCronSecret = false } = {}) {
  const problems = [];
  if (!APP.databaseUrl) {
    problems.push('DATABASE_URL is not set. The API cannot run without a database.');
  } else if (!/^postgres(ql)?:\/\//.test(APP.databaseUrl)) {
    problems.push('DATABASE_URL does not look like a postgres:// connection string.');
  }
  if (APP.publicUrl && !/^https?:\/\//.test(APP.publicUrl)) {
    problems.push('PUBLIC_BASE_URL must start with http:// or https:// (or be left unset).');
  }
  if (requireCronSecret && !APP.cronSecret) {
    problems.push('CRON_SECRET is not set, so the scheduled refresh endpoint is disabled.');
  }
  return problems;
}

export function assertConfigured() {
  const problems = configProblems();
  if (problems.length) throw new Error(problems.join(' '));
}
