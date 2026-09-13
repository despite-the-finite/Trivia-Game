# Entropic Brainwaves

A trivia platform whose questions are built from the live internet, not from a
file in the JavaScript bundle. Questions about current events, science, world
geography and general knowledge are generated server-side from cited sources,
validated, and cached. Scores, friends, leaderboards and challenges are all
authoritative on the server.

Every category resets once a day: at midnight UTC each one materialises a single
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
feeds for science, REST Countries and Wikidata for geography, Wikipedia's "On This
Day" API for general knowledge — and store the title, URL, publisher and
publication date. Only then is that material handed to a model, with instructions
to write questions from it and nothing else. The model is never asked what is true.

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
once every 24 hours (UTC), and every player who plays that category that day gets
exactly those questions in exactly that order — the same mechanism the original
Daily Challenge used, just applied per category. A player's first completed
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
`CRON_SECRET`. `vercel.json` registers the content-refresh cron at `*/30 * * * *`;
each category then decides for itself whether it is actually due.

Any Postgres works — Neon, Supabase, RDS, or a local server.

---

## Content freshness

Every category refreshes once every 24 hours and materialises one fixed quiz for
that day — see [Categories and the daily quiz](#categories-and-the-daily-quiz).

| Category | Refresh | Question TTL | Target pool | Source |
|---|---|---|---|---|
| Current Events | 24 h | 48 h | 20 | Reuters, AP, BBC, NPR, Al Jazeera, CBC, Guardian |
| Science | 24 h | 48 h | 20 | NASA, ESA, Nature, Phys.org, ScienceDaily, NOAA, NIH, CERN |
| Geography | 24 h | 48 h | 20 | REST Countries, Wikidata |
| General Knowledge | 24 h | 48 h | 20 | Wikipedia "On This Day" |

Every value is overridable by environment variable — see `.env.example`. The
target pool is small on purpose: each refresh only needs to comfortably cover
that day's ~10-question quiz, not a large rotating bank.

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

---

## Scoring

Calculated entirely on the server from the stored question. There are no
difficulty tiers — every correct answer is worth the same base points, with the
same speed-bonus ceiling.

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
| Grind a finished challenge | A completed participant cannot rejoin |
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
| `GET/POST /api/daily-challenge` | `?category=` selects the category's quiz (default `mixed`, the original Daily Challenge). GET returns today's status, POST starts or resumes today's attempt, `?view=leaderboard` returns its board |
| `POST /api/session` | `?action=finish` (or a body with `sessionId`) finalises a run and returns the summary |
| `GET /api/session?id=` | Resume a run, or `&view=review` for the per-question review |
| `POST /api/answer` | Submit one answer; returns correctness, points, explanation and source |
| `POST /api/player` | Create an account. `?action=recovery-code` / `?action=claim` move it to another device |
| `GET /api/player` | Your profile and statistics, or `?id=` for a public profile |
| `GET/POST/DELETE /api/friends` | List, add by friend code, remove |
| `GET /api/leaderboard` | `period` × `scope` × `board` |
| `POST /api/challenge` | Create a challenge, or `?action=join` to play one |
| `GET /api/challenge?slug=` | Challenge results and share text |
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
Knowledge — plus Mixed, which draws an even spread across all four. Each one is
materialised once per UTC day into a fixed set of questions in a fixed order,
seeded deterministically from the date and category, so everyone who plays a
given category that day gets an identical test. Mixed is the original Daily
Challenge; the other four are what "Quick Play" now means.

A player's first completed attempt at a day's quiz is the scored one — it is
what counts toward stats and the leaderboard. Playing the same quiz again that
day is allowed (it's still fun, and useful for practice), but the replay is
flagged `is_practice` and never touches score history. If a question in a stored
day's set ever becomes unavailable, the set rebuilds itself rather than failing
for everyone until midnight.

## Challenges

A challenge freezes both the **question ids** and the **answer permutation** at
creation, independently of the day's quiz — it's an ad-hoc set drawn for exactly
two players. Both players get the same questions, in the same order, with the
options in the same places. Results show both scores, accuracy, response times
and the margin:

```
Karsh — 1,840
Alex  — 1,620
Karsh wins by 220 points
```

Sharing uses the Web Share API where it exists (the OS sheet: Messages, WhatsApp,
Mail) and falls back to copying the link.

---

## Accounts

Onboarding is one field. Type a name, get a player id, a friend code like
`KARSH-7F4X`, and a token stored in `localStorage`. No password, no email, no
verification step.

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
               challengeService, dailyChallengeService, llm
public/
  js/services/ TriviaService, PlayerService, LeaderboardService,
               ChallengeService, ShareService, ApiClient
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
daily quiz, submits answers, runs challenges, and asserts the security properties
directly — that the answer key never reaches the client, that a question cannot
be answered twice, that a session rejects another player's answers, that both
sides of a challenge get an identical test, and that a replay of a completed
day's quiz is scored as practice rather than rejected outright.

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
- **Flag questions** are not implemented. REST Countries returns flag images, and
  the play shape currently carries text options only; adding image answers would
  mean extending that shape.
- **Timezone.** Every category's day is UTC. A local-timezone daily would mean
  several concurrent boards and a much murkier "once per day" rule.
- **Rate limits** are per-IP for account creation, which can bite users behind
  shared NAT. Raise `PLAYER_CREATE_LIMIT_PER_HOUR` if that applies to you.
- **Generation cost.** A refresh generates a batch, not a question per request, so
  cost scales with the number of categories and the refresh interval rather than
  with the number of players.
