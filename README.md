# Live Trivia

A trivia platform whose questions are built from the live internet, not from a
file in the JavaScript bundle. Questions about current events, science and world
geography are generated server-side from cited sources, validated, cached, and
served through a serverless API. Scores, friends, leaderboards and challenges are
all authoritative on the server.

New trivia appears on its own schedule. Nobody has to ship a new build.

**You do not need any of that to play.** Open `dist/trivia.html` in a browser and
the game runs — no install, no database, no API key, no network. That build
carries its own question bank and its own copy of the rules, so the geography and
science half of the game works standing alone. See
[Playing with no backend](#playing-with-no-backend).

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

**Just play it.** Open `dist/trivia.html` — double-click it, or drag it into a
browser tab. That is the entire procedure. It is one self-contained file: no
server, no build, no dependencies, and no network traffic of any kind.

To host it instead, `public/` is a static site that needs no build step. Serve
that directory from anything — `python3 -m http.server`, GitHub Pages, S3 — and
the game plays the same way; it looks for an API, finds none, and falls back to
the bundled bank.

**Run the whole thing.** The live backend adds Current Events questions written
from today's news, real leaderboards, friends and head-to-head challenges:

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

Calculated entirely on the server from the stored question. (Offline there is no
server, so the page applies the identical rules to the bundled question — see
[Playing with no backend](#playing-with-no-backend). A test scores the same matrix
of inputs through both implementations and asserts they agree, so the two cannot
drift.)

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

Every row above describes the hosted game and is unaffected by local mode. Local
mode makes no such claims and does not need to: with no server there is no ranking
to poison and no other player to cheat against, so the only person a local score
can mislead is the person who edited it.

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
  data/        packaged datasets for the offline bank: populations,
               peaks-rivers, evergreen-science
  db/          schema.sql, pool, transactions, advisory locks
  lib/         config, http, auth, ids, rate limiting, fetch helpers
  providers/   newsProvider, scienceProvider, geographyProvider,
               offlineGeographyProvider
  services/    contentPipeline, questionGenerator, questionValidator,
               geographyTemplates, questionService, scoringService,
               playerService, sessionService, leaderboardService,
               challengeService, dailyChallengeService, llm
public/
  data/        question-bank.json — the generated offline bank
  js/lib/      rng, scoring — pure rules shared with local play
  js/services/ TriviaService, PlayerService, LeaderboardService,
               ChallengeService, ShareService, ApiClient, LocalBackend
  js/ui/       DOM helpers
  js/app.js    screen routing and the game loop
scripts/       dev-server, migrate, refresh, build-bank, build-standalone
dist/          the single-file builds
tests/         unit tests, the local-mode suite, and a full end-to-end suite
```

No bundler and no frontend framework; `public/` is served as-is and needs no build
step. The two `build:` scripts exist only to produce the offline bank and the
single-file version, and both of their outputs are committed.

---

## Tests

```bash
npm test                                          # unit + local-mode tests
DATABASE_URL=postgres://… npm test                # + full end-to-end suite
```

`tests/localBackend.test.js` covers the offline half: it re-validates every banked
question through the production validator, plays whole games against the in-browser
backend, and asserts the security and fairness properties that still apply — a
question cannot be answered twice, a question outside the session is rejected, the
play shape carries no answer key, mashing forfeits the speed bonus, and the daily
challenge is identical across devices. It also pins the client copies of the RNG
and the scoring rules against the server's, so the shared logic cannot drift.

The end-to-end suite starts the real API handlers against a real Postgres, seeds
the bank through the real template and validation code, then plays games, submits
answers, runs challenges and daily challenges, and asserts the security
properties directly — that the answer key never reaches the client, that a
question cannot be answered twice, that a session rejects another player's
answers, and that both sides of a challenge get an identical test.

---

## Playing with no backend

Content being live is the point of this project. Needing a Postgres instance, an
API key and a deployment before anyone can answer a single question was not the
point — it was just the cost. Local mode removes that cost without weakening
anything above.

When the page loads and no API answers, `ApiClient` stops calling the network and
calls `LocalBackend` instead — an implementation of the same routes, with the same
request and response shapes, running inside the page against a question bank
generated at build time. Every screen, service and game-loop path above it is
byte-identical in both modes; only the thing at the bottom changes.

**What plays offline**

| | |
|---|---|
| Quick play | Geography and Science, any difficulty |
| Daily Challenge | Derived from the UTC date, so every device with this bank gets the same ten questions in the same order |
| Scoring | Base points, speed bonus, streak multipliers — the same numbers |
| Timer | 20 s per question, and backgrounding the tab still pauses it |
| Review | Every question, its explanation and its source |
| Stats and personal bests | Kept in `localStorage` |

**What needs the backend, and why**

| | |
|---|---|
| Current Events | Cannot be pre-baked without going stale, which is the whole premise |
| Friends, global leaderboards | Nobody to compare against on one device |
| Head-to-head challenges | Something has to hold both players' runs |
| Moving an account between devices | Requires a server to move it to |

Those controls are removed from the interface in local mode rather than left in
place to fail when tapped, and the home screen says which mode is running.

**On anti-cheat.** The hosted game never sends the answer key to the browser and
never accepts a score from it; that is unchanged. Local mode cannot make that
promise — there is no second party — so the page scores itself. A player who
opens devtools can award themselves points that nobody else will ever see. That is
the honest trade for a game that runs with nothing installed, and it applies only
when there is no server.

### The offline question bank

`npm run build:bank` writes `public/data/question-bank.json` (467 questions).
Nothing is invented for it:

- **Geography** is produced by `buildGeographyQuestions` — the same deterministic
  templates the live pipeline runs — over packaged datasets instead of live HTTP.
  Answers and distractors both come out of structured data, so a question is wrong
  only if the dataset is.
- **Science** is a curated set of settled facts, each citing a stable reference
  page from the body that is authoritative for it.
- **Both** are gated by the same `questionValidator` the live pipeline gates on.
  A question that would be rejected in production is rejected here.

Two things are deliberately excluded. Current Events, because a static file cannot
hold today's news. And population-comparison questions, because they state a
headcount that slowly stops being true — populations are still loaded, but only to
rank countries by prominence, which is what grades a question easy or hard and is
never shown to a player. Land area, capitals, borders, currencies, elevations and
river lengths have no such problem.

The build is deterministic: same inputs and seed, byte-identical bank, so a
rebuild shows up in review as a real content change or not at all.

### The single-file build

`npm run build:standalone` inlines the stylesheet, the modules and the bank into
one file:

```
dist/trivia.html            a complete document — open it, host it, email it
dist/trivia.fragment.html   the same page without the document wrapper
```

Both are committed, so playing needs no build step either. Rebuild them with
`npm run build` after changing anything in `public/`.

### Going offline mid-game

Unchanged for the hosted game: the timer stops rather than penalising the player.
The **TRY AGAIN** screen still exists, but it is now reached only when there is
neither a backend nor a bank — a broken deployment rather than an offline one.

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
- **Offline bank size.** 467 questions across two categories. Enough that runs stop
  repeating for a long while, not enough to be inexhaustible — a run prefers
  questions you have not seen and falls back to older ones rather than running dry.
- **Offline daily challenge.** Deterministic from the UTC date, so it matches for
  everyone on the same bank; regenerating the bank changes which questions a future
  day draws. There is no shared board to compare on, only your own score.
- **Border peaks.** The packaged mountain data leaves `country` null for summits on
  an international border, so the templates never ask which single country Everest
  is in. Those peaks still appear in height comparisons.
