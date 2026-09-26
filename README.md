# Entropic Brainwaves

A trivia platform whose questions are built from the live internet, not from a
file in the JavaScript bundle. Questions about current events, science, world
geography and general knowledge are generated server-side from cited sources,
validated, and cached. Scores and the leaderboard are all authoritative on the
server.

Every category resets once a day: at midnight Mountain time each one materialises a single
fixed quiz that every player sees, so a day's game is directly comparable across
everyone who plays it. Nobody has to ship a new build for new trivia to appear.

---

## How it works

```
     ┌───────────── content pipeline (once every 24h per category) ────┐
     │                                                                 │
  providers                  questionGenerator        questionValidator
  ─────────                  ─────────────────        ─────────────────
  newsProvider           ──▶  facts → LLM        ──▶  reject malformed,   ──▶ questions
  scienceProvider              (source material         ambiguous,             table
  geographyProvider             only, never                unverifiable,       (cached,
  generalKnowledgeProvider      model knowledge)           duplicate            with TTL)
   (geography: structured                                 or opinion
    data, no model)                                                               │
                                                                                   ▼
                                                            dailyChallengeService: picks
                                                            that category's fixed quiz
                                                            for today (one set, shared
                                                            by everyone) ───┐
                                                                            │
  browser ──▶ /api/daily-challenge ──▶ today's questions WITHOUT the answer key
          ──▶ /api/answer          ──▶ server checks, scores, records, reveals
```

Three ideas carry most of the design:

**Facts and question-writing are separate jobs.** Providers fetch real source
material — wire-service and public-broadcaster feeds for news, research-institution
feeds for science, Wikidata for geography, Wikipedia's "On This Day" API for
general knowledge — and store the title, URL, publisher and publication date.
Only then is that material handed to a model, with instructions to write
questions from it and nothing else. The model is never asked what is true.

**Geography does not trust a model at all.** Its answers and its distractors both
come out of structured datasets, through deterministic templates. The model's only
optional role is rephrasing the question sentence, and a rephrase that leaks an
answer option is discarded.

**The browser never sees the answer key.** A question arrives as id, text, four
options and category. When the player answers, the server checks it, computes the
points, records the result, and only then returns the correct answer and the
explanation. There is no score for the client to submit and nothing in the page to
tamper with.

**Every category is one shared quiz a day.** There are no difficulty tiers and no
per-play random draw. Each category materialises a single fixed set of questions
once every 24 hours (midnight Mountain time), and every player who plays that category that day gets
exactly those questions in exactly that order. A player's first completed
attempt at a day's quiz is the one that counts for stats and leaderboards; playing
it again afterward is a practice run.

---

## Quick start

```bash
npm install
cp .env.example .env          # set DATABASE_URL and ANTHROPIC_API_KEY
npm run migrate               # apply the schema (idempotent)
npm run refresh -- --force    # build the first batch of questions
npm run dev                   # http://localhost:3000
```

`ANTHROPIC_API_KEY` is only needed for Current Events, Science and General
Knowledge. Geography works without it, so `npm run refresh -- geography` is
enough to get a playable game.

### Deploying

The `api/` directory is a set of Vercel serverless functions and `public/` is a
static frontend, so `vercel deploy` works with no build step. Set `DATABASE_URL`
(use a **pooled** connection string), `ANTHROPIC_API_KEY`, `PUBLIC_BASE_URL` and
`CRON_SECRET`. `vercel.json` registers the content-refresh cron for midnight Mountain time. Vercel
Cron is UTC-only and Mountain midnight is 06:00 UTC in summer but 07:00 UTC in
winter, so it fires at 06:00, 07:00 and 08:00 UTC and `/api/cron/refresh` acts
only on runs between local midnight and 2am. The first refreshes; later ones
are retries that only redo a category whose earlier run failed or was cut off,
since each category decides for itself whether it is due.

Any Postgres works — Neon, Supabase, RDS, or a local server.

---

## Content freshness

Every category refreshes once every 24 hours and materialises one fixed quiz for
that day — see [Categories and the daily quiz](#categories-and-the-daily-quiz).

| Category | Refresh | Question TTL | Target pool | Source |
|---|---|---|---|---|
| Current Events | 24 h | 48 h | 20 | Reuters, AP, BBC, NPR, Al Jazeera, CBC, Guardian |
| Science | 24 h | 48 h | 20 | NASA, ESA, Nature, Phys.org, ScienceDaily, MIT News, Science News, Live Science, USGS and others |
| Geography | 24 h | 48 h | 20 | Wikidata |
| General Knowledge | 24 h | 48 h | 20 | Wikipedia "On This Day" |

Every value is overridable by environment variable — see `.env.example`. The
target pool is small on purpose: each refresh only needs to comfortably cover
that day's ~10-question quiz, not a large rotating bank.

Science pulls from space agencies (NASA, ESA) alongside topic-specific feeds
for physics, chemistry, biology, health, earth science and technology. Every
document is tagged with a topic — by the feed it came from, or by keywords for
general feeds — and `scienceProvider` builds each batch round-robin across
topics, holding space to 15% of it. NASA and ESA publish far more often than
everything else, so any order- or source-based cut-off lets them crowd the
batch. A feed can be pinned to a topic in `SCIENCE_FEEDS` with a third field
(`Name|url|biology`).

Upstream APIs and the model are **never** called on a player's request. The
pipeline generates a batch ahead of time and gameplay reads from that bank. If
the bank runs thin, a refresh is kicked off in the background and the player is
served from what is already there.

Feeds are configurable: set `NEWS_FEEDS` / `SCIENCE_FEEDS` to a comma-separated
list of `Name|url` pairs to use your own sources. General Knowledge sources from
Wikipedia's "On This Day" API and has no feed override.

---

## Question validation

Generated questions are rejected, not repaired. A candidate must clear all of:

- exactly four distinct, non-empty options, none of them "all/none of the above"
- a correct answer that is one of those options
- a question that ends in a question mark, 15–280 characters
- an explanation of 20–400 characters
- no speculative language (`might`, `reportedly`, `is expected to`, …)
- no opinion framing (`best`, `most important`, `should`, …)
- no reference to the source as a document (`according to the article`, …)
- no relative dates (`yesterday`, `today`) — they stop being true once cached
- a source URL that is one of the URLs actually supplied to the generator
- a correct answer that is not conspicuously longer than its distractors
- a fingerprint not already present in the batch or in the bank

Rejections are written to `rejected_questions` with their reasons, and each run is
summarised in `refresh_runs`, so it is possible to see *why* a batch underperformed
rather than guessing.

### Avoiding repeats

A new day's quiz excludes every question used by that category's quizzes in the
previous 7 days. If the bank is too thin to fill a quiz that way, repeats are
allowed rather than failing. At refresh time, source
documents that already produced questions in the last 30 days are skipped (a
reworded question about the same article would otherwise get a new fingerprint
and slip through), and duplicate detection looks back 60 days including expired
questions.

### Difficulty mix

Every question is tagged `easy`, `medium` or `hard` at generation time. Quizzes
lean easy on purpose — about half easy, a third medium and one in six hard
(`DIFFICULTY_MIX` in `questionService.js`) — so a day's quiz feels winnable
with a couple of real stretch questions. For the
LLM categories, difficulty comes only from how well-known or precise the
underlying fact is — never from ambiguous wording — and the model is asked to
self-label each question against that rule. For geography, difficulty is
derived deterministically from how prominent the subject is (a top-40 country's
capital is easy; a country ranked 120th by population is hard). When a day's
quiz is materialised, `pickBalancedSet` draws that mix per category, topping
up a short tier from the next-easiest one (see [Categories and the daily quiz](#categories-and-the-daily-quiz)).
Difficulty never changes scoring — see [Scoring](#scoring).

---

## Scoring

Calculated entirely on the server from the stored question. Every quiz mixes
easy, medium and hard questions (see [Question validation](#question-validation)),
but difficulty never changes the payout — every correct answer is worth the
same base points, with the same speed-bonus ceiling, so a run of hard questions
never discourages a player relative to an easy one.

| | Points |
|---|---|
| Correct answer | 150 |
| Maximum speed bonus | +75 |

The speed bonus is full at ≤2s and decays linearly to zero at the 20s time limit.
Streaks multiply the total: **3 in a row +10%**, **5 +20%**, **10+ +30%**. A wrong
answer scores zero and resets the streak.

**Rapid guessing is never advantageous**, by three mechanisms:

1. A wrong answer is worth nothing *and* costs the streak, so a blind guess has an
   expected value far below reading the question.
2. An answer faster than a human could read (<750ms) still scores base points if
   correct, but forfeits the speed bonus — so mashing cannot beat a considered
   fast answer.
3. The client's claimed response time is reconciled against the server's own
   measurement. A client cannot report 200ms after thinking for fifteen seconds.

The frontend sends only `{questionId, selectedAnswer, responseMs}`.

---

## Anti-cheat

| Attack | What stops it |
|---|---|
| Read the answer from the page | The answer key is never sent before the player answers |
| Submit a score | No endpoint accepts one; the server computes it |
| Re-answer a question for more points | `UNIQUE (session_id, question_id)` |
| Answer a question not in your game | The question must be in the session's pinned list |
| Answer into someone else's game | The session must belong to the caller |
| Claim an impossibly fast answer | Reconciled against server-side elapsed time |
| Replay a day's quiz for extra score | Only the first completed attempt is scored; later plays are flagged `is_practice` and excluded from stats/leaderboards |
| Script the API | Per-player and per-IP fixed-window limits in Postgres |

This is not esports-grade anti-cheat, and it is not meant to be. It is meant to
make the browser devtools a dead end.

---

## API

All endpoints return JSON. Player identity is a bearer token issued at account
creation; only its SHA-256 is stored.

| Endpoint | Purpose |
|---|---|
| `GET /api/trivia` | Read-only preview of the question bank (`category`, `count`) — not used by the frontend, useful for admins/tests. Redacted by default; the full record (with `correctAnswer`, `explanation`, provenance) requires an `X-Admin-Key` header |
| `GET/POST /api/daily-challenge` | `?category=` selects the category's quiz (required: `current-events`, `science`, `geography` or `general-knowledge`). GET returns today's status, POST starts or resumes today's attempt, `?view=leaderboard` returns its board |
| `POST /api/session` | `?action=finish` (or a body with `sessionId`) finalises a run and returns the summary |
| `GET /api/session?id=` | Resume a run, or `&view=review` for the per-question review |
| `POST /api/answer` | Submit one answer; returns correctness, points, explanation and source |
| `POST /api/player` | Create an account. `?action=recovery-code` / `?action=claim` move it to another device |
| `GET /api/player` | Your profile and statistics, or `?id=` for a public profile |
| `GET /api/leaderboard` | `?day=` (default today, last 5 days only) — top players for that day, each broken out by category |
| `GET /api/cron/refresh` | Scheduled content generation (requires `CRON_SECRET`) |
| `GET /api/health` | Used by the frontend on boot to decide whether to show the offline screen |

`GET /api/trivia` returns the shape the spec asks for — `id`, `category`,
`question`, `answers`, `correctAnswer`, `explanation`, `source`, `sourceUrl`,
`sourcePublishedAt`, `generatedAt`, `expiresAt` — but only to an authenticated
server-to-server caller. Answering that with the key in a public response would
undo the anti-cheat model, so the browser gets the redacted shape.

---

## Categories and the daily quiz

There are four categories — Current Events, Science, Geography and General
Knowledge. Each one is
materialised once per Mountain-time day into a fixed set of questions in a fixed order,
seeded deterministically from the date and category, so everyone who plays a
given category that day gets an identical test. Each daily refresh generates
13 questions per category: the day's 10-question quiz plus headroom for
validation rejects.

A player's first completed attempt at a day's quiz is the scored one — it is
what counts toward stats and the leaderboard. Playing the same quiz again that
day is allowed (it's still fun, and useful for practice), but the replay is
flagged `is_practice` and never touches score history. If a question in a stored
day's set ever becomes unavailable, the set rebuilds itself rather than failing
for everyone until midnight.

## Leaderboard

There is one board, permanently visible on the home screen: the top 10 players
for **today** (Mountain time), ranked by points earned that calendar day, each row
broken out by category (Current Events, Science, Geography, General
Knowledge) so a player's strengths are visible at a glance. It is computed
from the `score_events` ledger filtered to that day — not an all-time total —
so the home board always reflects who's playing well today, not just whoever
has played the longest.

If the signed-in player is outside the top 10, their own row is appended below
with their real rank instead of being left off the board, and that row is
visually distinguished (bold, highlighted) so they can immediately spot
themselves. There is no friends list and no separate scope — the board is
global, for everyone.

A "History" link opens a day picker (Today, Yesterday, and the 3 days before
that) showing the same board for any of those days. `GET /api/leaderboard`
only accepts a `day` within that rolling 5-day window (`HISTORY_DAYS` in
`leaderboardService.js`) — anything older is refused with a 400 rather than
silently returning nothing. This is a query-side limit, not a retention
policy: `score_events` itself is untouched, since personal weekly/monthly
stats elsewhere read further back than 5 days.

## Inviting friends

There is no head-to-head matchmaking and no friends list — "Invite" and
"Invite a friend" just hand out a link to the app itself, so whoever opens it
plays that category's shared quiz for the day and
shows up on the leaderboard next to you. Sharing uses the Web Share API where
it exists (the OS sheet: Messages, WhatsApp, Mail) and falls back to copying
the link.

---

## Accounts

Onboarding is one field. Type a name, get a player id and a token stored in
`localStorage`. No password, no email, no verification step.

To move to another device, generate a one-time recovery code that expires in 30
minutes; redeeming it rotates the token onto the new device. That is the
"upgrade to a permanent account" path without standing up an email provider —
`players.email` exists in the schema if you later want to add magic links.

---

## Layout

```
api/                      serverless endpoints (one file per route)
backend/
  db/          schema.sql, pool, transactions, advisory locks
  lib/         config, http, auth, ids, rate limiting, fetch helpers
  providers/   newsProvider, scienceProvider, geographyProvider,
               generalKnowledgeProvider
  services/    contentPipeline, questionGenerator, questionValidator,
               geographyTemplates, questionService, scoringService,
               playerService, sessionService, leaderboardService,
               dailyChallengeService, llm
public/
  js/services/ TriviaService, PlayerService, LeaderboardService,
               ShareService, ApiClient
  js/ui/       DOM helpers
  js/app.js    screen routing and the game loop
scripts/       dev-server, migrate, refresh
tests/         unit tests + a full end-to-end suite
```

No build step, no bundler, no frontend framework. `public/` is served as-is.

---

## Tests

```bash
npm test                                          # unit tests
DATABASE_URL=postgres://… npm test                # + full end-to-end suite
```

The end-to-end suite starts the real API handlers against a real Postgres, seeds
the bank through the real template and validation code, then plays a category's
daily quiz, submits answers, and asserts the security properties directly — that
the answer key never reaches the client, that a question cannot be answered
twice, that a session rejects another player's answers, and that a replay of a
completed day's quiz is scored as practice rather than rejected outright.

---

## Online only

This is deliberate. There is no bundled question set and no offline fallback: the
whole point is that content is live. If the backend is unreachable the app shows
a single friendly screen with a **TRY AGAIN** button, and going offline mid-game
stops the timer rather than penalising the player.

---

## Notes and limits

- **Feed reachability.** The default news and science feeds are public RSS. Some
  networks and some hosting environments block them; `NEWS_FEEDS` and
  `SCIENCE_FEEDS` exist so you can point at reachable sources.
- **Flag questions** are not implemented. The play shape currently carries text
  options only; adding image answers would mean extending that shape.
- **Timezone.** Every category's day is Mountain time (`America/Denver`, daylight
  saving included; override with `GAME_TIMEZONE`), for everyone. Per-player local
  days would mean several concurrent boards and a much murkier "once per day"
  rule. Around a daylight-saving change a day is 23 or 25 hours long.
- **Rate limits** are per-IP for account creation, which can bite users behind
  shared NAT. Raise `PLAYER_CREATE_LIMIT_PER_HOUR` if that applies to you.
- **Generation cost.** A refresh generates a batch, not a question per request, so
  cost scales with the number of categories and the refresh interval rather than
  with the number of players.
