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
feeds for science, Wikidata for geography — and store the
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

## Quick start (on your own machine)

```bash
npm install
cp .env.example .env          # then edit it: set DATABASE_URL, CRON_SECRET, ANTHROPIC_API_KEY
npm run migrate               # create the tables (safe to re-run)
npm run refresh -- --force    # build the first batch of questions
npm run dev                   # http://localhost:3000
```

`npm run doctor` checks the same setup and tells you what is missing before you
find out from a failing page. It never prints a secret.

`ANTHROPIC_API_KEY` is only needed for Current Events and Science. Geography
works without it, so `npm run refresh -- geography --force` is enough to get a
playable game.

---

## Deploying to Vercel

This section assumes you have never used Vercel, Postgres or environment
variables before. Follow it in order. Nothing here costs money: every service
used has a free tier that this app fits inside.

When you are done, the pieces fit together like this:

```
GitHub (main branch)  →  Vercel  →  the website people visit
                                 →  the API (api/*.js), running on demand
                                 →  your hosted Postgres database
```

**What Vercel does for you, and what you do yourself.** Vercel installs the
dependencies and publishes the site every time you push to `main`. It does *not*
create your database, apply the database schema, or write the first questions.
Those three are one-time jobs you run from your own computer in steps 10 and 11,
because they need your database credentials and because a job that runs on every
deploy is a job that can break every deploy.

### 1. Create a hosted Postgres database

The app stores players, questions and scores in Postgres. It cannot run without
one, and it must be a database on the internet — a database on your own laptop is
not reachable from Vercel.

**[Neon](https://neon.com)** has a free tier and is the quickest:

1. Go to <https://neon.com> and sign up (you can use your GitHub account).
2. Click **Create project**. Any name will do — `trivia` is fine.
3. Pick a region close to you and click **Create**.

**[Supabase](https://supabase.com)** works just as well if you prefer it: create
a project, then find the connection string under **Project Settings → Database**.

> You are not being asked to pay for anything. If a page offers you a paid plan,
> the free one is enough for this app.

### 2. Copy the DATABASE_URL

Your database's **connection string** is one long line that contains its
address, username and password. It looks roughly like:

```
postgresql://<username>:<password>@<host>.eu-central-1.aws.neon.tech/<database>?sslmode=require
```

(The angle brackets stand in for the real values, which your provider fills in
for you — your actual string will have no `<` or `>` in it.)

**Copy the *pooled* one.** In Neon it is the option labelled **Pooled
connection** (the hostname contains `-pooler`). In Supabase it is under
**Connection Pooling**, *Transaction* mode, port `6543`.

The reason: your API runs as many small short-lived programs rather than one
long-running server, and each one opens its own database connections. The
pooled address shares a small set of connections between all of them. The direct
address will run out and start refusing players.

This string contains your database password. Treat it like a password: paste it
into Vercel and into your local `.env` file, and nowhere else. Never put it in a
file you commit to GitHub.

### 3. Get an Anthropic API key (optional, but recommended)

Current Events and Science questions are written by a Claude model from real
source material that the app fetches first. Geography needs no key at all — its
answers come from geographic datasets through fixed templates.

If you want all three categories:

1. Go to <https://console.anthropic.com> and sign in.
2. Open **API keys** and click **Create key**.
3. Copy it. It starts with `sk-ant-`. You cannot view it again later, so paste it
   somewhere safe now.

This one *is* a paid service, billed per use. The app generates questions in
batches on a schedule, not per player, so cost tracks how often you refresh
rather than how many people play. You can skip this entirely and ship a
Geography-only game, then add the key later.

### 4. Create a Vercel account

Go to <https://vercel.com/signup> and sign up with **Continue with GitHub**. The
Hobby plan is free and is what the rest of these steps assume.

### 5–6. Import this repository

1. On your Vercel dashboard click **Add New… → Project**.
2. Vercel lists your GitHub repositories. Find **Trivia-Game** and click
   **Import**. If it is not listed, click **Adjust GitHub App Permissions** and
   grant Vercel access to it.
3. On the configuration screen, leave **Framework Preset** as *Other* and leave
   the Build and Output settings alone. `vercel.json` already sets them: there is
   no build step, and the site is served from `public/`.
4. **Do not click Deploy yet** — add the environment variables first (step 7).
   If you already clicked it, that is fine; the first deploy will simply show an
   error page. Add the variables and redeploy.

### 7. Add the environment variables

Environment variables are named settings that Vercel hands to your code at run
time. They exist so that secrets live in Vercel's settings rather than in your
source code, where anyone reading the repository would see them.

On the import screen open **Environment Variables** (or later:
**Project → Settings → Environment Variables**) and add these. Apply each to
**all** environments — Production, Preview and Development.

| Name | Value | Required? |
|---|---|---|
| `DATABASE_URL` | the pooled connection string from step 2 | **Yes** |
| `CRON_SECRET` | a long random string you generate — see step 9 | **Yes** |
| `ANTHROPIC_API_KEY` | your `sk-ant-…` key from step 3 | Only for Current Events and Science |
| `PUBLIC_BASE_URL` | leave this out — see step 8 | No |

Those are all of them. Everything else in `.env.example` is commented out and
has a working default.

### 8. What PUBLIC_BASE_URL should be set to

**Leave it unset.** When it is not set, the app builds shareable links from the
address the visitor is actually on, so a challenge link is correct on your
`*.vercel.app` URL, on preview deployments, and on a custom domain later —
without you having to remember to change anything.

Set it only if you want to force one canonical address, for example after you
attach `trivia.example.com` and want every shared link to use that name even when
someone plays on the `.vercel.app` address. In that case set it to the full
origin with no trailing slash:

```
PUBLIC_BASE_URL=https://trivia.example.com
```

### 9. What CRON_SECRET is and how to generate one

`/api/cron/refresh` is the endpoint that generates new questions. Every call to
it can mean a paid request to Anthropic, so it must not be open to the public.
`CRON_SECRET` is a password for that one endpoint. Vercel's scheduler sends it
automatically on every scheduled run; nobody else knows it.

**If `CRON_SECRET` is not set, that endpoint refuses every request** and no new
questions are ever generated on a schedule.

Generate one — a fresh random string, not a word you thought of:

```bash
openssl rand -hex 32
```

On Windows without `openssl`, in PowerShell:

```powershell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Paste the result as the value of `CRON_SECRET`. You never need to type it again.

### 10 & 11. Create the tables and the first questions

A new database is empty in two ways: it has no tables, and no questions. Both
are one-time jobs. There are two ways to do them — pick either.

#### The easy way: the setup page (no terminal needed)

Once the deployment is live, open:

```
https://<your-project>.vercel.app/setup.html
```

Paste your `CRON_SECRET` into the box, then press the two buttons in order:
**CREATE TABLES**, then **ADD QUESTIONS** (Geography is selected by default and
needs no API key). Each one reports what it did.

The key is sent as a request header, so it never lands in the address bar, your
browser history, or a server log. Nothing on that page works without it, so the
page is harmless to leave deployed.

Use this if you would rather not install Node. The rest of this section is the
equivalent from a terminal, and does exactly the same work.

#### The terminal way

This creates the tables. You run it once, from your own computer, pointed
at the hosted database. Vercel does not do it for you.

```bash
git clone https://github.com/despite-the-finite/Trivia-Game.git
cd Trivia-Game
npm install

# Paste your real connection string between the quotes.
export DATABASE_URL='postgresql://…the string from step 2…'

npm run doctor      # confirms it can reach the database
npm run migrate     # creates the tables
```

On Windows PowerShell, use `$env:DATABASE_URL='…'` instead of `export`.

`npm run migrate` is safe to run again at any time: every statement is guarded,
and it never drops or rewrites a table, so it will not delete players or scores.

Then populate the questions. The app serves from a bank of pre-generated
questions, so until this runs there is nothing to play. With the same
`DATABASE_URL` still set:

```bash
export ANTHROPIC_API_KEY='sk-ant-…'     # skip this line for Geography only
npm run refresh -- --force
```

This fetches source material, writes questions from it, validates them and stores
them. It takes a few minutes and prints what it accepted and rejected.

To do one category at a time:

```bash
npm run refresh -- geography --force        # no API key needed
npm run refresh -- science --force
npm run refresh -- current-events --force
```

Run this from your machine rather than through the deployed site: a serverless
function is stopped after 60 seconds, and a first full batch takes longer than
that. Afterwards the scheduled job (step 12) keeps the bank topped up on its own.

Check it worked:

```bash
npm run doctor      # prints how many live questions each category has
```

### 12. Deploy

Back in Vercel, click **Deploy** (or **Deployments → Redeploy** if you deployed
before adding the variables). It takes about a minute.

From now on, **every push to `main` deploys automatically**. There is nothing to
build and nothing to upload by hand.

**About the scheduled refresh.** `vercel.json` registers one cron job that calls
`/api/cron/refresh` once a day. It is deliberately once a day because *Hobby
accounts only allow daily cron jobs* — a more frequent schedule is rejected when
you deploy. Each run refreshes the single most out-of-date category, and the app
also tops the bank up in the background as people play. On a Pro plan you can
change the schedule in `vercel.json` to something more frequent:

```json
"crons": [{ "path": "/api/cron/refresh", "schedule": "0 */6 * * *" }]
```

### 13. Find your URL

On the project's **Deployments** page, click the newest deployment. The address
at the top is your live game — something like:

```
https://trivia-game-yourname.vercel.app
```

Open it. That link is the one to share.

**Using your own domain later.** In **Project → Settings → Domains**, click **Add**
and enter e.g. `trivia.example.com`, then add the DNS record Vercel shows you at
whoever manages that domain. Nothing in the code needs to change: leave
`PUBLIC_BASE_URL` unset and share links follow the new domain automatically.

### 14. Test the live game

1. Open your URL. You should see **Live Trivia** and a box asking for a display
   name.
2. Type a name and press **START PLAYING**.
3. Press **PLAY**. Ten questions should appear one at a time.
4. Answer one. The correct answer, an explanation and a source link appear
   *after* you answer — never before.
5. Finish the round and check the score screen.
6. Open `https://your-url.vercel.app/api/health` in a browser. You want:

```json
{ "status": "ok", "database": "ok", "totalQuestions": 240, "notes": [] }
```

`"status": "degraded"` means the database is fine but the bank is empty — go back
to step 11. `"status": "error"` means the database cannot be reached — see below.

### 15. Troubleshooting

**The page says "Trivia needs an internet connection".**
The frontend could not reach its own API. Open `/api/health` on your deployment;
its `notes` field usually names the problem outright.

**`/api/health` says `"database": "error: …"`.**
- *`DATABASE_URL is not set`* — the variable is missing in Vercel, or you added it
  to only one environment. Check **Settings → Environment Variables**, then
  **redeploy**: environment variable changes do not reach a deployment that
  already exists.
- *`ECONNREFUSED` / `timeout`* — the connection string is wrong, or it points at
  `localhost`. Vercel cannot reach your laptop.
- *`too many clients` / `remaining connection slots`* — you used the direct
  connection string. Switch to the pooled one (step 2) and redeploy.
- *`self-signed certificate in certificate chain`* — your provider presents a
  certificate that cannot be verified. If you trust the provider, add
  `?sslmode=no-verify` to the end of `DATABASE_URL`.

**The build fails with "Function Runtimes must have a valid version".**
Something re-added a `runtime` key to the `functions` block in `vercel.json`.
Remove it; the Node version comes from `engines.node` in `package.json`.

**The build fails with "Hobby accounts are limited to daily cron jobs".**
The cron schedule in `vercel.json` fires more than once a day. Change it back to
a single fixed time, e.g. `"0 6 * * *"`.

**`/api/health` says `"schema": "missing"`, or `relation "questions" does not exist`.**
The database is reachable — the credentials are right — but the tables have not
been created. Open `/setup.html` and press **CREATE TABLES**, or run
`npm run migrate` locally. This is the expected state of a brand new database.

**Playing says "No trivia is available right now".**
The bank is empty. Run step 11. Confirm with `npm run doctor`.

**No new questions ever appear.**
Check `/api/health` — if `cronConfigured` is `false`, `CRON_SECRET` is missing.
Otherwise open **Vercel → your project → Logs**, filter to `/api/cron/refresh`,
and look for the `[cron] refresh {…}` line: it names what ran, what it produced
and what failed. A `403` there means the secret in Vercel does not match the one
the scheduler sends — remove and re-add `CRON_SECRET`, then redeploy.

**Only Geography questions appear.**
`ANTHROPIC_API_KEY` is not set, or is invalid. `/api/health` reports
`"llmConfigured": false` when it is missing.

**A shared challenge link 404s.**
The client-side routes are handled by the `rewrites` block in `vercel.json`. If
you edited that file, make sure `/challenge/:slug`, `/daily`, `/leaderboard` and
`/friends` all still rewrite to `/index.html`.

---

## Linking this from another site

The game is a self-contained website at its own origin, so linking to it is just
an anchor:

```html
<a href="https://trivia.example.com">Play Live Trivia</a>
```

Nothing needs to be embedded and no keys are shared. If another site ever needs
to call this API from a browser, set `ALLOWED_ORIGINS` to that site's origin —
by default the API answers only its own pages, which is what the game itself
needs.

---

## Content freshness

Freshness is per category, because "recent" means different things in each.

| Category | Refresh | Question TTL | Target pool | Source |
|---|---|---|---|---|
| Current Events | ~45 min | 36 h | 80 | Reuters, AP, BBC, NPR, Al Jazeera, CBC, Guardian |
| Science | 6 h | 14 days | 80 | NASA, ESA, Nature, Phys.org, ScienceDaily, NOAA, NIH, CERN |
| Geography | 30 days | 60 days | 150 | Wikidata |

Every value is overridable by environment variable — see `.env.example`.

Upstream APIs and the model are **never** called on a player's request. The
pipeline generates batches ahead of time (30–120 questions per run) and gameplay
reads from that bank. If the bank runs thin, a refresh is kicked off in the
background and the player is served from what is already there.

Two things pace that work to fit a serverless deployment. A scheduled run
refreshes the **single most out-of-date category** rather than all three, because
each category is an upstream fetch plus a model call and doing all of them in one
invocation exceeds the function time limit; the next run takes the next category.
And a background refresh started from a read path is handed to the platform's
`waitUntil`, so it is not frozen the moment the response is sent. Set
`CRON_CATEGORIES_PER_RUN` higher if your plan allows longer functions.

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
| `POST /api/setup` | One-time deployment setup — `?action=status\|migrate\|seed`. Same `CRON_SECRET` gate; backs the `/setup.html` page so a new deployment can be prepared without a terminal |
| `GET /api/health` | Used by the frontend on boot to decide whether to show the offline screen, and as the deployment's own status page: it names what is missing without echoing any secret |

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
  setup.html   one-time deployment setup (schema + first questions)
  js/services/ TriviaService, PlayerService, LeaderboardService,
               ChallengeService, ShareService, ApiClient
  js/ui/       DOM helpers
  js/app.js    screen routing and the game loop
scripts/       dev-server, migrate, refresh, doctor, load-env
tests/         unit tests, deployment checks, a full end-to-end suite
vercel.json    routing, function limits, cron schedule, security headers
```

No build step, no bundler, no frontend framework. `public/` is served as-is.

---

## Tests

```bash
npm test                                          # unit + deployment checks
DATABASE_URL=postgres://… npm test                # + full end-to-end suite
```

The **end-to-end suite** starts the real API handlers against a real Postgres,
seeds the bank through the real template and validation code, then plays games,
submits answers, runs challenges and daily challenges, and asserts the security
properties directly — that the answer key never reaches the client, that a
question cannot be answered twice, that a session rejects another player's
answers, and that both sides of a challenge get an identical test.

The **deployment suite** (`tests/deployment.test.js`) needs neither a database
nor the network, so it runs every time. It covers the failures that only appear
once the app leaves localhost: a `functions.runtime` value Vercel rejects, a cron
schedule a Hobby account will not accept, a lockfile without integrity hashes, a
credential committed by accident, a secret referenced from `public/`, a share URL
that comes out relative, an over-permissive CORS grant, unverified database TLS,
and the refresh endpoint accepting anything other than `CRON_SECRET`.

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
- **Flag questions** are not implemented. The play shape carries text options
  only; adding image answers would mean extending that shape.
- **Geography sources.** Country data came from REST Countries until v3.1 was
  deprecated — it now answers 200 with an error object instead of the country
  array, and v5 requires an API key. It is Wikidata now: no key, the same source
  already used for peaks and rivers, and authoritative structured data, which is
  the property this category actually depends on.
- **Timezone.** The daily challenge day is UTC. A local-timezone daily would mean
  several concurrent boards and a much murkier "once per day" rule.
- **Rate limits** are per-IP for account creation, which can bite users behind
  shared NAT. Raise `PLAYER_CREATE_LIMIT_PER_HOUR` if that applies to you.
- **Generation cost.** A refresh generates a batch, not a question per request, so
  cost scales with the number of categories and the refresh interval rather than
  with the number of players.
- **Cron frequency on a free plan.** Vercel Hobby accounts only permit daily cron
  jobs, so the shipped schedule is daily and each run refreshes one category. On
  a plan with a shorter minimum, raise both the schedule and
  `CRON_CATEGORIES_PER_RUN`.
- **First run is a manual step.** `npm run migrate` and the first
  `npm run refresh -- --force` are run from a developer's machine, not by Vercel.
  A full first batch takes longer than a serverless function is allowed to live,
  and a migration that runs on every deploy is a migration that can fail on every
  deploy.
