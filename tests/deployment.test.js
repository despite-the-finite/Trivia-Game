import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Deployment tests: the things that only break once the app leaves localhost.
 *
 * This file checks the deployment configuration itself — where a Vercel deploy
 * actually fails: an invalid function runtime, a cron schedule the plan
 * rejects, a committed secret, a share link that comes out relative.
 *
 * Nothing here needs a database or the network, deliberately. These assertions
 * run on every `npm test`, and they cannot interfere with tests/e2e.test.js,
 * which truncates the tables it works on.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => JSON.parse(await readFile(join(root, p), 'utf8'));

// ---------------------------------------------------------------------------
// vercel.json — the file that decides whether a deploy happens at all
// ---------------------------------------------------------------------------

test('vercel.json does not pin a Node runtime in the functions block', async () => {
  const config = await readJson('vercel.json');
  for (const [pattern, settings] of Object.entries(config.functions ?? {})) {
    assert.equal(
      settings.runtime,
      undefined,
      `functions["${pattern}"].runtime must be unset — Vercel rejects values like "nodejs20.x" ` +
        'there with "Function Runtimes must have a valid version". The Node version comes from ' +
        'engines.node in package.json.',
    );
  }
});

test('every API function is covered by a max duration', async () => {
  const config = await readJson('vercel.json');
  const durations = Object.values(config.functions ?? {}).map((f) => f.maxDuration);
  assert.ok(durations.length > 0, 'expected a functions block covering api/**');
  for (const d of durations) {
    assert.ok(Number.isInteger(d) && d > 0 && d <= 60,
      `maxDuration ${d} must be a positive integer no greater than 60 — above that the value ` +
      'depends on the plan and on Fluid compute being enabled, and a wrong value fails the build.');
  }
});

test('the cron schedule is one a Hobby account will accept', async () => {
  const config = await readJson('vercel.json');
  assert.ok(config.crons?.length, 'expected at least one cron entry');

  for (const cron of config.crons) {
    const [minute, hour, dom, month, dow] = cron.schedule.trim().split(/\s+/);
    assert.equal(
      [minute, hour, dom, month, dow].length,
      5,
      `"${cron.schedule}" is not a 5-field cron expression`,
    );
    // Hobby accounts reject anything that would fire more than once a day, so
    // both the minute and the hour field must name a single fixed value.
    for (const [name, field] of [['minute', minute], ['hour', hour]]) {
      assert.match(
        field,
        /^\d+$/,
        `cron "${cron.schedule}" fires more than once a day (${name} field is "${field}"). ` +
          'Vercel Hobby accounts reject that at deploy time.',
      );
    }
  }
});

test('the cron path resolves to a real API function', async () => {
  const config = await readJson('vercel.json');
  for (const cron of config.crons) {
    const file = join(root, `${cron.path.replace(/^\//, '')}.js`);
    await assert.doesNotReject(readFile(file), `${cron.path} has no handler at ${file}`);
  }
});

test('static output and client-side routes are configured', async () => {
  const config = await readJson('vercel.json');
  assert.equal(config.outputDirectory, 'public');

  const sources = (config.rewrites ?? []).map((r) => r.source);
  // Anything the frontend can put in the address bar must fall back to the
  // shell, or a shared link 404s instead of opening the game.
  for (const route of ['/challenge/:slug', '/daily', '/leaderboard', '/friends']) {
    assert.ok(sources.includes(route), `missing a rewrite for ${route}`);
  }
  for (const rewrite of config.rewrites) {
    assert.equal(rewrite.destination, '/index.html');
  }
});

test('responses carry the baseline security headers', async () => {
  const config = await readJson('vercel.json');
  const headersFor = (path) =>
    Object.fromEntries(
      config.headers
        .filter((h) => new RegExp(`^${h.source.replace(/\(\.\*\)/g, '.*')}$`).test(path))
        .flatMap((h) => h.headers.map((x) => [x.key, x.value])),
    );

  const api = headersFor('/api/session');
  assert.equal(api['Cache-Control'], 'no-store', 'API responses must never be cached');
  assert.equal(api['X-Content-Type-Options'], 'nosniff');

  const page = headersFor('/index.html');
  assert.equal(page['X-Content-Type-Options'], 'nosniff');
  assert.match(page['Content-Security-Policy'] ?? '', /default-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(page['Content-Security-Policy'] ?? ''),
    'the CSP should not need unsafe-inline: the app has no inline scripts or styles');
});

// ---------------------------------------------------------------------------
// package.json / lockfile — reproducible installs on the build machine
// ---------------------------------------------------------------------------

test('engines.node names a Node version Vercel still supports', async () => {
  const pkg = await readJson('package.json');
  assert.match(
    pkg.engines?.node ?? '',
    /^(22|24)\.x$/,
    'Vercel wants a concrete major like "22.x". A range such as ">=20" is rejected, and Node 20 ' +
      'is deprecated for new deployments from 1 October 2026.',
  );
});

test('there is no build script for Vercel to trip over', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.scripts.build, undefined,
    'the site is served as-is from public/; a build script would make Vercel run one');
});

test('every locked dependency has a resolved URL and an integrity hash', async () => {
  const lock = await readJson('package-lock.json');
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.link) continue;
    assert.ok(entry.resolved, `${path} has no "resolved" URL, so npm ci cannot verify its origin`);
    assert.ok(entry.integrity, `${path} has no "integrity" hash, so npm ci cannot verify its contents`);
    assert.equal(new URL(entry.resolved).host, 'registry.npmjs.org');
  }
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test('.env files are excluded from git and .env.example is not', async () => {
  const check = (path) => {
    try {
      execFileSync('git', ['check-ignore', '-q', path], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  for (const path of ['.env', '.env.local', '.env.production']) {
    assert.ok(check(path), `${path} must be git-ignored`);
  }
  assert.ok(!check('.env.example'), '.env.example is documentation and must stay tracked');
});

test('no real credentials are committed', async () => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  // Anthropic keys, Postgres URLs carrying a password, and generic long
  // hex/base64 secrets assigned to an obviously secret-shaped name.
  // Angle brackets are excluded throughout: a real credential never contains
  // them, and documentation writes placeholders as <username>:<password>.
  const patterns = [
    [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
    [
      /postgres(ql)?:\/\/[^\s:@/<>]+:[^\s:@/<>]+@(?!host\b|localhost\b|127\.0\.0\.1)[^\s/<>]+/i,
      'a database URL with a password',
    ],
    [
      /(CRON_SECRET|TRIVIA_ADMIN_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*['"]?[A-Za-z0-9+/_-]{24,}/,
      'a hard-coded secret',
    ],
  ];

  // These two files exist to *describe* the variables, so they legitimately
  // contain lines of the form `CRON_SECRET=<placeholder>`. They get a stricter
  // check of their own below.
  const documentsSecrets = new Set(['.env.example', 'tests/deployment.test.js']);

  for (const file of files) {
    if (documentsSecrets.has(file)) continue;
    let text;
    try {
      text = await readFile(join(root, file), 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    for (const [pattern, what] of patterns) {
      const match = text.match(pattern);
      assert.equal(match, null, `${file} appears to contain ${what}: ${match?.[0]?.slice(0, 24)}…`);
    }
  }
});

test('.env.example ships placeholders, never a working value', async () => {
  const text = await readFile(join(root, '.env.example'), 'utf8');
  const values = Object.fromEntries(
    text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );

  // Only the variables a deployment cannot start without should be uncommented,
  // and each must obviously be a placeholder rather than something that works.
  assert.deepEqual(Object.keys(values).sort(), ['ANTHROPIC_API_KEY', 'CRON_SECRET', 'DATABASE_URL']);
  assert.match(values.ANTHROPIC_API_KEY, /^sk-ant-\.\.\.$/);
  assert.match(values.CRON_SECRET, /change-me/);
  assert.match(values.DATABASE_URL, /user:password@host/);
});

test('no secret is referenced from client-side code', async () => {
  const dir = join(root, 'public');
  const walk = async (d) => {
    const entries = await readdir(d, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };

  const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'CRON_SECRET', 'TRIVIA_ADMIN_KEY'];

  for (const file of await walk(dir)) {
    const text = await readFile(file, 'utf8');

    // Server environment is unreachable from a browser, so any attempt to read
    // it is either dead code or a misunderstanding worth catching.
    assert.ok(
      !text.includes('process.env'),
      `${file} reads process.env. Nothing in public/ runs on the server.`,
    );

    // Naming a variable in help text is fine and often necessary — setup.html
    // has to tell the operator which value to paste. What must never appear is
    // a secret being *given a value*: an assignment, a JSON field, or an
    // embedded literal, any of which would ship the value to every visitor.
    for (const name of SECRET_NAMES) {
      const assigned = new RegExp(`${name}\\s*[=:]\\s*['"\`]?[^\\s'"\`<>]`);
      const match = text.match(assigned);
      assert.equal(
        match,
        null,
        `${file} appears to assign a value to ${name}: "${match?.[0]}". A server secret ` +
          'must never be embedded in anything the browser downloads.',
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Production URL resolution
// ---------------------------------------------------------------------------

test('share links use the origin the request arrived on', async () => {
  const { requestOrigin, publicBaseUrl } = await import('../backend/lib/http.js');

  assert.equal(
    requestOrigin({ headers: { 'x-forwarded-host': 'trivia.example.com', 'x-forwarded-proto': 'https' } }),
    'https://trivia.example.com',
    'a custom domain must produce its own absolute links with no configuration',
  );
  assert.equal(
    requestOrigin({ headers: { host: 'live-trivia-abc123.vercel.app', 'x-forwarded-proto': 'https' } }),
    'https://live-trivia-abc123.vercel.app',
  );
  // Local development, where there is no proxy to set x-forwarded-proto.
  assert.equal(requestOrigin({ headers: { host: 'localhost:3000' } }), 'http://localhost:3000');
  // A host header is proxy-supplied input; a malformed one yields nothing
  // rather than a broken or injected URL.
  assert.equal(requestOrigin({ headers: { host: 'evil.com/\r\nX-Injected: 1' } }), '');
  assert.equal(requestOrigin({ headers: {} }), '');

  assert.equal(publicBaseUrl(undefined), (await import('../backend/lib/config.js')).APP.publicUrl || '');
});

test('PUBLIC_BASE_URL overrides the request origin when it is set', async () => {
  process.env.PUBLIC_BASE_URL = 'https://pinned.example.com/';
  try {
    const { publicBaseUrl } = await import(`../backend/lib/http.js?pinned=${Date.now()}`);
    assert.equal(
      publicBaseUrl({ headers: { host: 'something-else.vercel.app' } }),
      'https://pinned.example.com',
      'a configured origin wins, and a trailing slash is trimmed',
    );
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function fakeRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k] = v; } };
}

test('no CORS grant is issued by default', async () => {
  const { applyCors } = await import('../backend/lib/http.js');
  const res = fakeRes();
  applyCors({ headers: { origin: 'https://somewhere-else.example' } }, res);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined,
    'the game is same-origin with its API; a default cross-origin grant is needless exposure');
});

test('an allowlisted origin gets a credentialed grant and others do not', async () => {
  process.env.ALLOWED_ORIGINS = 'https://theentropic.studio';
  try {
    const { applyCors } = await import(`../backend/lib/http.js?allow=${Date.now()}`);

    const allowed = fakeRes();
    applyCors({ headers: { origin: 'https://theentropic.studio' } }, allowed);
    assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'https://theentropic.studio');
    assert.equal(allowed.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(allowed.headers.Vary, 'Origin');

    const denied = fakeRes();
    applyCors({ headers: { origin: 'https://attacker.example' } }, denied);
    assert.equal(denied.headers['Access-Control-Allow-Origin'], undefined);
  } finally {
    delete process.env.ALLOWED_ORIGINS;
  }
});

test('a wildcard grant never carries credentials', async () => {
  process.env.ALLOWED_ORIGINS = '*';
  try {
    const { applyCors } = await import(`../backend/lib/http.js?wild=${Date.now()}`);
    const res = fakeRes();
    applyCors({ headers: { origin: 'https://anyone.example' } }, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(res.headers['Access-Control-Allow-Credentials'], undefined,
      'reflecting any origin with credentials would hand every site an authenticated channel');
  } finally {
    delete process.env.ALLOWED_ORIGINS;
  }
});

// ---------------------------------------------------------------------------
// Database connection policy
// ---------------------------------------------------------------------------

test('database TLS certificates are verified unless explicitly waived', async () => {
  const { sslConfig } = await import('../backend/db/index.js');

  assert.deepEqual(
    sslConfig('postgres://u:p@db.neon.tech/trivia?sslmode=require'),
    { rejectUnauthorized: true },
    'a hosted database presents a public CA certificate; verify it',
  );
  assert.deepEqual(sslConfig('postgres://u:p@host/db'), { rejectUnauthorized: true });
  assert.deepEqual(sslConfig('postgres://u:p@host/db?sslmode=no-verify'), { rejectUnauthorized: false });
  assert.equal(sslConfig('postgres://u:p@localhost:5432/db?sslmode=disable'), false);
});

// ---------------------------------------------------------------------------
// API routing — the shape Vercel derives from the filesystem
// ---------------------------------------------------------------------------

async function apiRoutes() {
  const out = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, `${prefix}/${entry.name}`);
      else if (entry.name.endsWith('.js')) {
        out.push({ route: `${prefix}/${entry.name.replace(/\.js$/, '')}`, file: full });
      }
    }
  };
  await walk(join(root, 'api'), '/api');
  return out;
}

test('every file in api/ is a usable Vercel function', async () => {
  const routes = await apiRoutes();
  assert.ok(routes.length >= 9, `expected the full API surface, found ${routes.length}`);

  for (const { route, file } of routes) {
    const mod = await import(file);
    assert.equal(typeof mod.default, 'function', `${route} must default-export a handler`);
    // Vercel derives the URL from the path, so a nested file must stay nested.
    assert.match(route, /^\/api\/[a-z0-9/-]+$/, `${route} is not a clean URL path`);
  }

  assert.ok(routes.some((r) => r.route === '/api/cron/refresh'));
  for (const expected of ['/api/health', '/api/trivia', '/api/session', '/api/answer']) {
    assert.ok(routes.some((r) => r.route === expected), `missing ${expected}`);
  }
});

test('an unsupported method is refused with an Allow header, not a crash', async () => {
  const handler = (await import('../api/trivia.js')).default;
  const res = { ...fakeRes(), statusCode: 200, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (chunk) => { res.body = chunk ?? ''; };

  await handler({ method: 'DELETE', headers: {}, url: '/api/trivia' }, res);

  assert.equal(res.statusCode, 405);
  assert.match(res.headers.Allow ?? '', /GET/);
  assert.equal(JSON.parse(res.body).error.code, 'method_not_allowed');
});

test('a preflight request is answered without touching the database', async () => {
  const handler = (await import('../api/session.js')).default;
  const res = { ...fakeRes(), statusCode: 200, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = () => { res.ended = true; };

  await handler({ method: 'OPTIONS', headers: { origin: 'https://example.test' }, url: '/api/session' }, res);
  assert.equal(res.statusCode, 204);
  assert.ok(res.ended);
});

// ---------------------------------------------------------------------------
// The scheduled refresh endpoint
//
// This is the most expensive route in the app: every authorised call can mean a
// paid model request. Its gate is therefore tested directly, with no database
// and no network, so these assertions run on every `npm test` rather than only
// when someone has a Postgres to hand.
// ---------------------------------------------------------------------------

// Node lowercases incoming header names before a handler ever sees them, so a
// realistic fake request uses lowercase keys.
const cronReq = (headers = {}) => ({ method: 'GET', headers, url: '/api/cron/refresh' });

test('the refresh endpoint is closed when no CRON_SECRET is configured', async () => {
  delete process.env.CRON_SECRET;
  const { authorizeCronRequest } = await import(`../api/cron/refresh.js?nosecret=${Date.now()}`);

  // Notably including the header Vercel's own scheduler sends: on an inbound
  // request that header is set by whoever made the request, so treating it as
  // proof of anything would let a stranger spend the project's model budget.
  for (const headers of [{}, { 'x-vercel-cron': '1' }, { authorization: 'Bearer anything' }]) {
    assert.throws(
      () => authorizeCronRequest(cronReq(headers)),
      (err) => err.status === 403 && /CRON_SECRET/.test(err.message),
      `headers ${JSON.stringify(headers)} must not authorise a refresh`,
    );
  }
});

test('the refresh endpoint accepts only the configured secret', async () => {
  const secret = 'test-cron-secret-0123456789abcdef';
  process.env.CRON_SECRET = secret;
  try {
    const { authorizeCronRequest } = await import(`../api/cron/refresh.js?secret=${Date.now()}`);

    // What Vercel Cron itself sends, and the manual-curl alternative.
    assert.doesNotThrow(() => authorizeCronRequest(cronReq({ authorization: `Bearer ${secret}` })));
    assert.doesNotThrow(() => authorizeCronRequest(cronReq({ 'x-cron-secret': secret })));

    const refused = [
      {},
      { 'x-vercel-cron': '1' },
      { authorization: 'Bearer wrong-secret-entirely' },
      { authorization: `Bearer ${secret.slice(0, 12)}` },     // a prefix
      { authorization: `Bearer ${secret}x` },                  // a suffix
      { authorization: secret },                               // no Bearer scheme
      { authorization: `Bearer ${secret.toUpperCase()}` },     // wrong case
      { 'x-cron-secret': secret.slice(0, 12) },
    ];
    for (const headers of refused) {
      assert.throws(
        () => authorizeCronRequest(cronReq(headers)),
        (err) => err.status === 403,
        `headers ${JSON.stringify(headers)} must be refused`,
      );
    }
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('an unauthenticated refresh is refused before any work is done', async () => {
  delete process.env.CRON_SECRET;
  const handler = (await import(`../api/cron/refresh.js?http=${Date.now()}`)).default;

  const res = { ...fakeRes(), statusCode: 200, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (chunk) => { res.body = chunk ?? ''; };

  // No DATABASE_URL is needed for this to answer, which is the point: the gate
  // closes before the handler reaches the pipeline.
  await handler(cronReq({ 'x-vercel-cron': '1' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, 'forbidden');
});

// ---------------------------------------------------------------------------
// The browser setup route
//
// It applies a schema and can spend money at the model provider, so its gate
// gets the same scrutiny as the cron endpoint's.
// ---------------------------------------------------------------------------

test('setup refuses every request it cannot authenticate', async (t) => {
  const secret = 'setup-secret-0123456789abcdefgh';
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = secret;
  t.after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  const handler = (await import(`../api/setup.js?auth=${Date.now()}`)).default;

  const post = async (headers) => {
    const res = { ...fakeRes(), statusCode: 200, body: '' };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.end = (chunk) => { res.body = chunk ?? ''; };
    // No DATABASE_URL is touched: a refused request never reaches the database.
    await handler({ method: 'POST', headers, url: '/api/setup?action=migrate', query: { action: 'migrate' } }, res);
    return res;
  };

  for (const headers of [
    {},
    { 'x-vercel-cron': '1' },
    { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${secret.slice(0, 10)}` },
    { authorization: secret },
  ]) {
    const res = await post(headers);
    assert.equal(res.statusCode, 403, `headers ${JSON.stringify(headers)} must not reach the schema`);
    assert.equal(JSON.parse(res.body).error.code, 'forbidden');
  }
});

test('setup is disabled entirely when no CRON_SECRET is configured', async (t) => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  t.after(() => {
    if (saved !== undefined) process.env.CRON_SECRET = saved;
  });

  const handler = (await import(`../api/setup.js?nosecret=${Date.now()}`)).default;
  const res = { ...fakeRes(), statusCode: 200, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (chunk) => { res.body = chunk ?? ''; };

  await handler({ method: 'POST', headers: {}, url: '/api/setup', query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error.message, /CRON_SECRET/);
});

test('setup only accepts POST, so no link or crawler can trigger it', async () => {
  const handler = (await import('../api/setup.js')).default;
  const res = { ...fakeRes(), statusCode: 200, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (chunk) => { res.body = chunk ?? ''; };

  await handler({ method: 'GET', headers: {}, url: '/api/setup' }, res);
  assert.equal(res.statusCode, 405);
});

test('schema.sql ships with the setup function and is safe to re-run', async () => {
  const config = await readJson('vercel.json');
  assert.equal(
    config.functions['api/setup.js']?.includeFiles,
    'backend/db/schema.sql',
    'setup reads schema.sql by path at runtime; Vercel only traces imports, so it ' +
      'must be listed under includeFiles or it will be missing from the bundle.',
  );

  const sql = await readFile(join(root, 'backend/db/schema.sql'), 'utf8');
  // Applying this from a web request is only defensible because it cannot
  // destroy anything.
  assert.ok(!/\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)\b/i.test(sql), 'schema.sql must not drop anything');
  assert.ok(!/\bTRUNCATE\b/i.test(sql), 'schema.sql must not truncate anything');
  for (const table of ['players', 'questions', 'game_sessions']) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `${table} must be created only if missing, so a re-run is a no-op`,
    );
  }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('health reports a missing database as an error instead of crashing', async (t) => {
  const savedDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  t.after(() => {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
  });

  const handler = (await import(`../api/health.js?nodb=${Date.now()}`)).default;
  const res = { ...fakeRes(), statusCode: 200, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (chunk) => { res.body = chunk ?? ''; };

  await handler({ method: 'GET', headers: {}, url: '/api/health' }, res);

  assert.equal(res.statusCode, 200, 'health must answer even when the database is unreachable');
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'error');
  assert.match(body.database, /^error: /);
  // Reaching the database and having tables in it are different failures with
  // different fixes, and health has to tell them apart.
  assert.equal(body.schema, 'unknown', 'schema state is unknowable when the connection failed');
  assert.match(body.notes.join(' '), /DATABASE_URL/, 'it should say what is missing');
  assert.equal(typeof body.llmConfigured, 'boolean');
  assert.equal(typeof body.cronConfigured, 'boolean');
});

test('health never echoes a secret', async (t) => {
  const saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    TRIVIA_ADMIN_KEY: process.env.TRIVIA_ADMIN_KEY,
  };
  process.env.CRON_SECRET = 'cron-secret-value-must-not-appear';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-appear-in-output';
  process.env.TRIVIA_ADMIN_KEY = 'admin-key-must-not-appear';
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const handler = (await import(`../api/health.js?secrets=${Date.now()}`)).default;
  const res = { ...fakeRes(), statusCode: 200, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (chunk) => { res.body = chunk ?? ''; };

  await handler({ method: 'GET', headers: {}, url: '/api/health' }, res);

  for (const secret of Object.values({
    CRON_SECRET: process.env.CRON_SECRET,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    TRIVIA_ADMIN_KEY: process.env.TRIVIA_ADMIN_KEY,
  })) {
    assert.ok(!res.body.includes(secret), `health leaked ${secret.slice(0, 10)}…`);
  }
  const body = JSON.parse(res.body);
  assert.equal(body.llmConfigured, true, 'it may say whether a key is present');
  assert.equal(body.cronConfigured, true);
});
