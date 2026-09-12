import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * geographyProvider's upstream contracts.
 *
 * These exist because of a live failure: the countries request asked for 13
 * fields, REST Countries caps the list at 10 and answers 400, the error was
 * swallowed, and the deployment served a question bank made entirely of
 * "which mountain is highest" and "which river is longest" for a week. Neither
 * half of that is visible from a unit test of the templates, so both are
 * pinned here.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'backend/providers/geographyProvider.js'), 'utf8');

test('the countries request stays inside the REST Countries field limit', () => {
  const block = source.match(/const REST_COUNTRIES_FIELDS = \[([\s\S]*?)\]/);
  assert.ok(block, 'expected an explicit field list');

  const fields = block[1]
    .split(',')
    .map((f) => f.trim().replace(/['"]/g, ''))
    .filter(Boolean);

  assert.ok(fields.length > 0);
  assert.ok(
    fields.length <= 10,
    `REST Countries /all rejects more than 10 fields with a 400; this asks for ${fields.length} ` +
      `(${fields.join(', ')}). Going over costs the entire countries dataset, and with it every ` +
      'capital, border, currency, language, population and area question.',
  );

  // Each of these is read by a template; losing one silently removes a whole
  // family of questions.
  for (const required of ['name', 'cca3', 'capital', 'population', 'area', 'region', 'borders', 'currencies', 'languages']) {
    assert.ok(fields.includes(required), `${required} is used by a template but is not requested`);
  }
});

test('the countries dataset is marked required', async () => {
  const { DATASETS } = await import('../backend/providers/geographyProvider.js');
  const countries = DATASETS.find((d) => d.id === 'rest-countries');

  assert.ok(countries, 'the countries dataset must still exist');
  assert.equal(
    countries.required,
    true,
    'countries carry most of the question variety; a run without them must fail rather than ' +
      'quietly produce a bank of superlatives',
  );

  // The Wikidata sets are genuinely optional — losing one costs a question
  // family, not the whole batch.
  for (const optional of DATASETS.filter((d) => d.id !== 'rest-countries')) {
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
