import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * geographyProvider's upstream contracts.
 *
 * These exist because of a live failure: the countries dataset would not load,
 * the error was swallowed, and the deployment served a question bank made
 * entirely of "which mountain is highest" and "which river is longest" for a
 * week. The immediate cause was an over-long field list against REST Countries;
 * the underlying cause was that REST Countries v3.1 is deprecated and answers
 * with an error object rather than data. Country data comes from Wikidata now.
 * None of that is visible from a unit test of the templates, so the contracts
 * are pinned here.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'backend/providers/geographyProvider.js'), 'utf8');

test('country data is sourced from Wikidata, not the deprecated REST Countries API', async () => {
  const { DATASETS } = await import('../backend/providers/geographyProvider.js');

  assert.ok(
    !/restcountries\.com/.test(source),
    'REST Countries v3.1 returns an error object instead of countries, and v5 requires an API ' +
      'key; neither is a usable keyless source',
  );
  assert.ok(
    DATASETS.some((d) => d.id === 'wikidata-countries'),
    'the countries dataset must still exist under its new id',
  );
});

test('the country queries ask for every field a template reads', () => {
  // Each Wikidata property backs a family of questions. Losing one silently
  // removes that family, which is the failure this whole file exists for.
  for (const [property, what] of [
    ['P36', 'capital city'],
    ['P1082', 'population'],
    ['P2046', 'area'],
    ['P30', 'continent'],
    ['P47', 'shares border with'],
    ['P38', 'currency'],
    ['P37', 'official language'],
  ]) {
    assert.match(source, new RegExp(`P${property.slice(1)}\\b`), `no query asks for ${what} (${property})`);
  }
});

test('area is read as a normalised quantity, not a bare truth value', () => {
  // Wikidata stores areas against a unit. wdt: hands back the bare number, so a
  // country recorded in square miles would be compared directly against one in
  // square kilometres and produce a confidently wrong "which is largest".
  assert.match(
    source,
    /psn:P2046/,
    'area must come through psn: (normalised to square metres) so the values are comparable',
  );
  assert.ok(
    !/wdt:P2046/.test(source),
    'wdt:P2046 returns the raw value without its unit and must not be used for comparisons',
  );
});

test('the countries dataset is marked required', async () => {
  const { DATASETS } = await import('../backend/providers/geographyProvider.js');
  const countries = DATASETS.find((d) => d.id === 'wikidata-countries');

  assert.ok(countries, 'the countries dataset must still exist');
  assert.equal(
    countries.required,
    true,
    'countries carry most of the question variety; a run without them must fail rather than ' +
      'quietly produce a bank of superlatives',
  );

  // The Wikidata sets are genuinely optional — losing one costs a question
  // family, not the whole batch.
  for (const optional of DATASETS.filter((d) => d.id !== 'wikidata-countries')) {
    assert.notEqual(optional.required, true, `${optional.id} should not block a run`);
  }
});

test('a failed required dataset aborts the run instead of being swallowed', async (t) => {
  // Point the provider at a URL that cannot resolve, so the countries load
  // fails the way a 400 would, and assert the failure actually surfaces.
  const saved = { url: process.env.REST_COUNTRIES_URL, sparql: process.env.WIKIDATA_SPARQL_URL };
  process.env.REST_COUNTRIES_URL = 'http://127.0.0.1:1/countries';
  process.env.WIKIDATA_SPARQL_URL = 'http://127.0.0.1:1/sparql';
  t.after(() => {
    for (const [k, v] of [['REST_COUNTRIES_URL', saved.url], ['WIKIDATA_SPARQL_URL', saved.sparql]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const provider = await import(`../backend/providers/geographyProvider.js?fail=${Date.now()}`);

  await assert.rejects(
    () => provider.collect(),
    (err) => /incomplete|no geography dataset/i.test(err.message),
    'collect() must throw when the countries dataset cannot be loaded',
  );
});

test('the provider does not swallow dataset errors with settleAll', () => {
  assert.ok(
    !/settleAll/.test(source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
    'settleAll collects successes and discards failures, which is what made a half-loaded ' +
      'run indistinguishable from a healthy one',
  );
});

// ---------------------------------------------------------------------------
// Merging the three country queries
//
// The SPARQL itself can only be proven against Wikidata. What can be proven
// here is everything after the response arrives: entity ids become keys, areas
// convert from square metres, GROUP_CONCAT lists split, borders join by id, and
// the enrichment queries degrade without taking the run down.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { once } from 'node:events';

const Q = (id) => `http://www.wikidata.org/entity/${id}`;

/** A SPARQL JSON response body. */
const bindings = (rows) => ({ results: { bindings: rows } });
const lit = (value) => ({ type: 'literal', value: String(value) });
const uri = (value) => ({ type: 'uri', value });

/**
 * Serves canned answers keyed by a marker in the query text, so each of the
 * three queries can be answered — or failed — independently.
 */
async function withFakeWikidata(handlers, fn) {
  const server = http.createServer((req, res) => {
    const query = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('query') ?? '');
    const key = query.includes('P47') ? 'borders' : query.includes('P38') ? 'details' : 'core';
    const handler = handlers[key];
    if (handler === 'fail') {
      res.writeHead(500).end('upstream exploded');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
    res.end(JSON.stringify(handler));
  });
  server.listen(0);
  await once(server, 'listening');

  const saved = process.env.WIKIDATA_SPARQL_URL;
  process.env.WIKIDATA_SPARQL_URL = `http://127.0.0.1:${server.address().port}/sparql`;
  try {
    const provider = await import(`../backend/providers/geographyProvider.js?fake=${Math.random()}`);
    return await fn(provider);
  } finally {
    if (saved === undefined) delete process.env.WIKIDATA_SPARQL_URL;
    else process.env.WIKIDATA_SPARQL_URL = saved;
    server.close();
  }
}

const CORE = bindings([
  {
    c: uri(Q('Q142')), cLabel: lit('France'), capital: lit('Paris'),
    population: lit('68000000'), areaSquareMetres: lit('551695000000'), continent: lit('Europe'),
  },
  {
    c: uri(Q('Q183')), cLabel: lit('Germany'), capital: lit('Berlin'),
    population: lit('84000000'), areaSquareMetres: lit('357022000000'), continent: lit('Europe'),
  },
  {
    // No English label: Wikidata falls back to the entity id, which must never
    // reach a player as a country name.
    c: uri(Q('Q99999')), cLabel: lit('Q99999'), continent: lit('Europe'),
  },
  {
    // No continent, so it cannot supply same-region distractors.
    c: uri(Q('Q17')), cLabel: lit('Japan'), capital: lit('Tokyo'), population: lit('125000000'),
  },
]);

const BORDERS = bindings([
  { c: uri(Q('Q142')), borders: lit([Q('Q183'), Q('Q724'), Q('Q99999')].join('|')) },
]);

const DETAILS = bindings([
  { c: uri(Q('Q142')), currencies: lit('euro'), languages: lit('French|Occitan') },
  { c: uri(Q('Q183')), currencies: lit('euro'), languages: lit('Q12345') },
]);

test('country rows merge into the shape the templates expect', async () => {
  await withFakeWikidata({ core: CORE, borders: BORDERS, details: DETAILS }, async (provider) => {
    const docs = await provider.collect();
    const countries = docs.find((d) => d.facts.datasetId === 'wikidata-countries').facts.records;
    const byName = new Map(countries.map((c) => [c.name, c]));

    const france = byName.get('France');
    assert.ok(france, 'France should be present');
    assert.equal(france.code, 'Q142', 'the entity id becomes the key borders join against');
    assert.equal(france.capital, 'Paris');
    assert.equal(france.population, 68_000_000);
    assert.equal(france.area, 551_695, 'square metres must convert to square kilometres');
    assert.equal(france.region, 'Europe');
    assert.deepEqual(france.languages, ['French', 'Occitan'], 'GROUP_CONCAT lists split on |');
    assert.deepEqual(france.currencies, [{ code: 'euro', name: 'euro' }]);

    assert.deepEqual(
      france.borders,
      ['Q183'],
      'borders keep only ids present in this dataset — a neighbour we know nothing about ' +
        'cannot be named as an answer or checked as a distractor',
    );

    assert.equal(byName.has('Q99999'), false, 'an unlabelled entity is not a country name');
    assert.equal(byName.has('Japan'), false, 'a country with no continent is dropped');
    assert.deepEqual(byName.get('Germany').languages, [], 'unlabelled language ids are dropped');
  });
});

test('a failed enrichment query costs variety, not the whole run', async () => {
  await withFakeWikidata({ core: CORE, borders: 'fail', details: 'fail' }, async (provider) => {
    const docs = await provider.collect();
    const countries = docs.find((d) => d.facts.datasetId === 'wikidata-countries').facts.records;

    assert.ok(countries.length >= 2, 'core country data must still come through');
    const france = countries.find((c) => c.name === 'France');
    assert.equal(france.capital, 'Paris');
    assert.deepEqual(france.borders, []);
    assert.deepEqual(france.languages, []);
  });
});

test('an empty core query fails the run rather than banking nothing useful', async () => {
  await withFakeWikidata({ core: bindings([]), borders: BORDERS, details: DETAILS }, async (provider) => {
    await assert.rejects(() => provider.collect(), /no sovereign states|incomplete/i);
  });
});
