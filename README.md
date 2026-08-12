# Live Trivia

A trivia platform whose questions are built from the live internet, not from a
file in the JavaScript bundle. Questions about current events, science and world
geography are generated server-side from cited sources, validated, cached, and
served through a serverless API. Scores, friends, leaderboards and challenges are
all authoritative on the server.

New trivia appears on its own schedule. Nobody has to ship a new build.

---

## How it works

```
     ┌───────────── content pipeline (scheduled) ─────────────┐
     │                                                        │
  providers            questionGenerator        questionValidator
  ─────────            ─────────────────        ─────────────────
  newsProvider     ──▶  facts → LLM        ──▶  reject malformed,   ──▶ questions
  scienceProvider       (source material          ambiguous,             table
  geographyProvider      only, never                unverifiable,       (cached,
   (structured data)     model knowledge)           duplicate            with TTL)
                                                    or opinion
                                                                            │
  browser ──▶ /api/session ──▶ questions WITHOUT the answer key ────────────┘
          ──▶ /api/answer  ──▶ server checks, scores, records, reveals
```

Three ideas carry most of the design:

**Facts and question-writing are separate jobs.** Providers fetch real source
material — wire-service and public-broadcaster feeds for news, research-institution
feeds for science, REST Countries and Wikidata for geography — and store the
title, URL, publisher and publication date. Only then is that material handed to
a model, with instructions to write questions from it and nothing else. The model
is never asked what is true.

**Geography does not trust a model at all.** Its answers and its distractors both
come out of structured datasets, through deterministic templates. The model's only
optional role is rephrasing the question sentence, and a rephrase that leaks an
answer option is discarded.

**The browser never sees the answer key.** A question arrives as id, text, four
options, category, difficulty. When the player answers, the server checks it,
computes the points, records the result, and only then returns the correct answer
and the explanation. There is no score for the client to submit and nothing in the
page to tamper with.

---

## Quick start

```bash
npm install
cp .env.example .env          # set DATABASE_URL and ANTHROPIC_API_KEY
npm run migrate               # apply the schema (idempotent)
npm run refresh -- --force    # build the first batch of questions
npm run dev                   # http://localhost:3000
```

`ANTHROPIC_API_KEY` is only needed for Current Events and Science. Geography works
without it, so `npm run refresh -- geography` is enough to get a playable game.

### Deploying

The `api/` directory is a set of Vercel serverless functions and `public/` is a
static frontend, so `vercel deploy` works with no build step. Set `DATABASE_URL`
(use a **pooled** connection string), `ANTHROPIC_API_KEY`, `PUBLIC_BASE_URL` and
`CRON_SECRET`. `vercel.json` registers the content-refresh cron at `*/30 * * * *`;
each category then decides for itself whether it is actually due.

Any Postgres works — Neon, Supabase, RDS, or a local server.

---

## Content freshness

Freshness is per category, because "recent" means different things in each.

| Category | Refresh | Question TTL | Target pool | Source |
|---|---|---|---|---|
| Current Events | ~45 min | 36 h | 80 | Reuters, AP, BBC, NPR, Al Jazeera, CBC, Guardian |
| Science | 6 h | 14 days | 80 | NASA, ESA, Nature, Phys.org, ScienceDaily, NOAA, NIH, CERN |
| Geography | 30 days | 60 days | 150 | REST Countries, Wikidata |

Every value is overridable by environment variable — see `.env.example`.

Upstream APIs and the model are **never** called on a player's request. The
pipeline generates batches ahead of time (50–120 questions per run) and gameplay
reads from that bank. If the bank runs thin, a refresh is kicked off in the
background and the player is served from what is already there.

Feeds are configurable: set `NEWS_FEEDS` / `SCIENCE_FEEDS` to a comma-separated
list of `Name|url` pairs to use your own sources.

---

## Question validation

Generated questions are rejected, not repaired. A candidate must clear all of:

- exactly four distinct, non-empty options, none of them "all/none of the above"
- a correct answer that is one of those options
- a question that ends in a question mark, 15–280 characters
- an explanation of 20–400 characters
- a difficulty of easy / medium / hard
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

Calculated entirely on the server from the stored question.

| | Easy | Medium | Hard |
|---|---|---|---|
| Correct answer | 100 | 150 | 200 |
| Maximum speed bonus | +50 | +75 | +100 |

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
| Replay the daily challenge | Partial unique index on `(player_id, daily_date)` |
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
| `GET /api/trivia` | Read the question bank. `category`, `difficulty`, `count`. Redacted by default; the full record (with `correctAnswer`, `explanation`, provenance) requires an `X-Admin-Key` header |
| `POST /api/session` | Start a run. `?action=finish` finalises it and returns the summary |
| `GET /api/session?id=` | Resume a run, or `&view=review` for the per-question review |
| `POST /api/answer` | Submit one answer; returns correctness, points, explanation and source |
| `POST /api/player` | Create an account. `?action=recovery-code` / `?action=claim` move it to another device |
| `GET /api/player` | Your profile and statistics, or `?id=` for a public profile |
| `GET/POST/DELETE /api/friends` | List, add by friend code, remove |
| `GET /api/leaderboard` | `period` × `scope` × `board` |
| `POST /api/challenge` | Create a challenge, or `?action=join` to play one |
| `GET /api/challenge?slug=` | Challenge results and share text |
| `GET/POST /api/daily-challenge` | Today's challenge, `?view=leaderboard` for its board |
| `GET /api/cron/refresh` | Scheduled content generation (requires `CRON_SECRET`) |
| `GET /api/health` | Used by the frontend on boot to decide whether to show the offline screen |

`GET /api/trivia` returns the shape the spec asks for — `id`, `category`,
`difficulty`, `question`, `answers`, `correctAnswer`, `explanation`, `source`,
`sourceUrl`, `sourcePublishedAt`, `generatedAt`, `expiresAt` — but only to an
authenticated server-to-server caller. Answering that with the key in a public
response would undo the anti-cheat model, so the browser gets the redacted shape.

---

## Challenges and the daily challenge

A challenge freezes both the **question ids** and the **answer permutation** at
creation. Both players therefore get the same questions, in the same order, with
the options in the same places. Results show both scores, accuracy, response times
and the margin:

```
Karsh — 1,840
Alex  — 1,620
Karsh wins by 220 points
```

The daily challenge is one global set per UTC day, materialised on first request
and seeded deterministically from the date, so everyone gets an identical test.
It is scored once per player. If a question in a stored daily set ever becomes
unavailable, the set rebuilds itself rather than failing for everyone until
midnight.

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
  providers/   newsProvider, scienceProvider, geographyProvider
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
the bank through the real template and validation code, then plays games, submits
answers, runs challenges and daily challenges, and asserts the security
properties directly — that the answer key never reaches the client, that a
question cannot be answered twice, that a session rejects another player's
answers, and that both sides of a challenge get an identical test.

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
- **Timezone.** The daily challenge day is UTC. A local-timezone daily would mean
  several concurrent boards and a much murkier "once per day" rule.
- **Rate limits** are per-IP for account creation, which can bite users behind
  shared NAT. Raise `PLAYER_CREATE_LIMIT_PER_HOUR` if that applies to you.
- **Generation cost.** A refresh generates a batch, not a question per request, so
  cost scales with the number of categories and the refresh interval rather than
  with the number of players.
