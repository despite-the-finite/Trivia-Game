-- Entropic Brainwaves schema.
--
-- Design notes:
--  * Question content (`questions`) is fully separated from gameplay
--    (`game_sessions`, `session_answers`) so the same validated question can be
--    reused across sessions, challenges and daily challenges.
--  * `source_documents` keeps the raw factual material a question was derived
--    from, so provenance survives even if the question text is regenerated.
--  * `score_events` is an append-only ledger. Daily/weekly/monthly leaderboards
--    are derived from it, which keeps `player_stats` a pure cache that can be
--    rebuilt at any time.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS players (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    TEXT        NOT NULL,
  friend_code     TEXT        NOT NULL UNIQUE,
  token_hash      TEXT        NOT NULL UNIQUE,
  email           TEXT        UNIQUE,
  is_anonymous    BOOLEAN     NOT NULL DEFAULT TRUE,
  recovery_hash   TEXT,
  recovery_expires_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS players_friend_code_idx ON players (friend_code);

-- Denormalised counters. Rebuildable from score_events + game_sessions.
CREATE TABLE IF NOT EXISTS player_stats (
  player_id            UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  total_score          BIGINT  NOT NULL DEFAULT 0,
  games_played         INTEGER NOT NULL DEFAULT 0,
  questions_answered   INTEGER NOT NULL DEFAULT 0,
  correct_answers      INTEGER NOT NULL DEFAULT 0,
  incorrect_answers    INTEGER NOT NULL DEFAULT 0,
  current_streak       INTEGER NOT NULL DEFAULT 0,
  best_streak          INTEGER NOT NULL DEFAULT 0,
  total_response_ms    BIGINT  NOT NULL DEFAULT 0,
  current_events_score BIGINT  NOT NULL DEFAULT 0,
  science_score        BIGINT  NOT NULL DEFAULT 0,
  geography_score      BIGINT  NOT NULL DEFAULT 0,
  general_knowledge_score BIGINT NOT NULL DEFAULT 0,
  best_game_score      INTEGER NOT NULL DEFAULT 0,
  best_game_accuracy   NUMERIC(5,2) NOT NULL DEFAULT 0,
  best_daily_score     INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'player_stats' AND column_name = 'general_knowledge_score'
  ) THEN
    ALTER TABLE player_stats ADD COLUMN general_knowledge_score BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;

ALTER TABLE player_stats DROP COLUMN IF EXISTS easy_correct;
ALTER TABLE player_stats DROP COLUMN IF EXISTS medium_correct;
ALTER TABLE player_stats DROP COLUMN IF EXISTS hard_correct;

CREATE TABLE IF NOT EXISTS friendships (
  player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, friend_id),
  CHECK (player_id <> friend_id)
);

-- ---------------------------------------------------------------------------
-- Trivia content
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS source_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT        NOT NULL,          -- newsProvider | scienceProvider | geographyProvider | generalKnowledgeProvider
  category      TEXT        NOT NULL,          -- current-events | science | geography | general-knowledge
  title         TEXT        NOT NULL,
  url           TEXT        NOT NULL,
  source_name   TEXT        NOT NULL,
  published_at  TIMESTAMPTZ,
  facts         JSONB       NOT NULL,          -- extracted factual material handed to the generator
  checksum      TEXT        NOT NULL UNIQUE,   -- sha256 of provider + url + facts
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_documents_category_idx
  ON source_documents (category, fetched_at DESC);

CREATE TABLE IF NOT EXISTS questions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category            TEXT        NOT NULL,   -- current-events | science | geography | general-knowledge
  question            TEXT        NOT NULL,
  answers             JSONB       NOT NULL,   -- canonical order; index 0 is NOT necessarily correct
  correct_index       INTEGER     NOT NULL,
  explanation         TEXT        NOT NULL,
  source              TEXT        NOT NULL,
  source_url          TEXT        NOT NULL,
  source_published_at TIMESTAMPTZ,
  source_document_id  UUID        REFERENCES source_documents(id) ON DELETE SET NULL,
  generator           TEXT        NOT NULL,   -- llm | template | template+llm
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  fingerprint         TEXT        NOT NULL UNIQUE, -- normalised question text hash, blocks duplicates
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  times_served        INTEGER     NOT NULL DEFAULT 0,
  times_answered      INTEGER     NOT NULL DEFAULT 0,
  times_correct       INTEGER     NOT NULL DEFAULT 0,
  CHECK (correct_index >= 0),
  CHECK (jsonb_array_length(answers) BETWEEN 2 AND 6)
);

ALTER TABLE questions DROP COLUMN IF EXISTS difficulty;

DROP INDEX IF EXISTS questions_pool_idx;
CREATE INDEX IF NOT EXISTS questions_pool_idx
  ON questions (category, expires_at DESC)
  WHERE active;

CREATE INDEX IF NOT EXISTS questions_expiry_idx ON questions (expires_at) WHERE active;

-- Rejected generations, kept for pipeline observability.
CREATE TABLE IF NOT EXISTS rejected_questions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category     TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  reasons      TEXT[]      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bookkeeping for content freshness per category.
CREATE TABLE IF NOT EXISTS refresh_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category      TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'running', -- running | ok | error
  sources_fetched INTEGER   NOT NULL DEFAULT 0,
  generated     INTEGER     NOT NULL DEFAULT 0,
  accepted      INTEGER     NOT NULL DEFAULT 0,
  rejected      INTEGER     NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS refresh_runs_category_idx
  ON refresh_runs (category, started_at DESC);

-- ---------------------------------------------------------------------------
-- Gameplay
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode           TEXT        NOT NULL,        -- daily | challenge
  category       TEXT        NOT NULL,        -- includes 'mixed'
  question_ids   UUID[]      NOT NULL,
  answer_orders  JSONB       NOT NULL,        -- { [questionId]: [canonicalIndex, ...] }
  challenge_id   UUID,  -- FK added after `challenges` exists, see bottom of file
  daily_date     DATE,
  is_practice    BOOLEAN     NOT NULL DEFAULT FALSE, -- replay of a day's quiz after the scoring attempt
  total_score    INTEGER     NOT NULL DEFAULT 0,
  correct_count  INTEGER     NOT NULL DEFAULT 0,
  best_streak    INTEGER     NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL
);

ALTER TABLE game_sessions DROP COLUMN IF EXISTS difficulty;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'game_sessions' AND column_name = 'is_practice'
  ) THEN
    ALTER TABLE game_sessions ADD COLUMN is_practice BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS game_sessions_player_idx
  ON game_sessions (player_id, started_at DESC);

CREATE TABLE IF NOT EXISTS session_answers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID        NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  question_id  UUID        NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position     INTEGER     NOT NULL,
  selected_index INTEGER,                     -- canonical index; null == timed out
  correct      BOOLEAN     NOT NULL,
  points       INTEGER     NOT NULL,
  response_ms  INTEGER     NOT NULL,
  streak_after INTEGER     NOT NULL,
  flagged      TEXT,                          -- anti-cheat note, null when clean
  answered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One answer per question per session: the primary guard against replaying
  -- a question to farm points.
  UNIQUE (session_id, question_id)
);

CREATE TABLE IF NOT EXISTS score_events (
  id          BIGSERIAL PRIMARY KEY,
  player_id   UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  session_id  UUID        REFERENCES game_sessions(id) ON DELETE CASCADE,
  category    TEXT        NOT NULL,
  points      INTEGER     NOT NULL,
  correct     BOOLEAN     NOT NULL,
  response_ms INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE score_events DROP COLUMN IF EXISTS difficulty;

CREATE INDEX IF NOT EXISTS score_events_leaderboard_idx
  ON score_events (created_at DESC, player_id);
CREATE INDEX IF NOT EXISTS score_events_player_idx
  ON score_events (player_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Challenges
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT        NOT NULL UNIQUE,  -- short id used in the share URL
  challenger_id UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  category      TEXT        NOT NULL,
  question_ids  UUID[]      NOT NULL,
  answer_orders JSONB       NOT NULL,         -- fixed for every participant
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

ALTER TABLE challenges DROP COLUMN IF EXISTS difficulty;

CREATE TABLE IF NOT EXISTS challenge_participants (
  challenge_id UUID        NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  player_id    UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  session_id   UUID        REFERENCES game_sessions(id) ON DELETE SET NULL,
  role         TEXT        NOT NULL,          -- challenger | opponent
  score        INTEGER     NOT NULL DEFAULT 0,
  correct_count INTEGER    NOT NULL DEFAULT 0,
  total_response_ms INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (challenge_id, player_id)
);

-- One fixed, shared question set per (UTC day, category) — 'mixed' is the
-- original global Daily Challenge; every other category is that category's
-- own daily quiz (see dailyChallengeService).
CREATE TABLE IF NOT EXISTS daily_challenges (
  day           DATE        NOT NULL,
  category      TEXT        NOT NULL DEFAULT 'mixed',
  question_ids  UUID[]      NOT NULL,
  answer_orders JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'daily_challenges' AND column_name = 'category'
  ) THEN
    ALTER TABLE daily_challenges ADD COLUMN category TEXT NOT NULL DEFAULT 'mixed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'daily_challenges_pkey'
       AND conrelid = 'daily_challenges'::regclass
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE daily_challenges DROP CONSTRAINT daily_challenges_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'daily_challenges_pkey' AND conrelid = 'daily_challenges'::regclass
  ) THEN
    ALTER TABLE daily_challenges ADD CONSTRAINT daily_challenges_pkey PRIMARY KEY (day, category);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Basic abuse control
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Deferred constraints (declared here because of table ordering)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'game_sessions_challenge_id_fkey'
  ) THEN
    ALTER TABLE game_sessions
      ADD CONSTRAINT game_sessions_challenge_id_fkey
      FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Multiple attempts per (player, day, category) are allowed — replays after the
-- first completed one are marked is_practice and excluded from scoring, rather
-- than being blocked outright. See dailyChallengeService/sessionService.
DROP INDEX IF EXISTS game_sessions_daily_once_idx;
