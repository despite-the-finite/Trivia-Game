import { fetchJson, settleAll } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';
import { todayGameDay } from '../lib/day.js';

/**
 * geographyProvider — structured, authoritative geographic data.
 *
 * Geography is the category where we deliberately do NOT let a model decide
 * what is true. Every fact here comes from a structured dataset fetched over
 * the network (Wikidata), and the question templates derive the answer *and*
 * the distractors from that same data. The LLM's only optional role
 * downstream is rephrasing the question text — never determining the answer.
 *
 * Country data used to come from REST Countries, which deprecated its free
 * v3.1 API (it now returns HTTP 200 with an error payload instead of data —
 * see https://restcountries.com/docs/countries/legacy-api-deprecation). This
 * pulls the same facts from Wikidata instead, the same source already used
 * for mountains and rivers below.
 */

const WIKIDATA_SPARQL = process.env.WIKIDATA_SPARQL_URL || 'https://query.wikidata.org/sparql';

/**
 * The public Wikidata endpoint is shared infrastructure and can be slow or
 * briefly rate-limit under load. One retry after a short pause absorbs that
 * without needing the whole category refresh to fail and wait a day.
 */
async function sparql(query, { timeoutMs = 45000, retries = 1 } = {}) {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const body = await fetchJson(url, { accept: 'application/sparql-results+json', timeoutMs });
      return body?.results?.bindings ?? [];
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const cell = (binding, key) => binding[key]?.value ?? null;

// Every sovereign UN member: wdt:P31 (instance of) sovereign state, member of
// the UN (wd:Q1065). This mirrors REST Countries' old independent+unMember
// filter reasonably closely (~193 states).
const COUNTRY_PATTERN = 'wdt:P31 wd:Q3624078; wdt:P298 ?code; wdt:P463 wd:Q1065';

/**
 * Countries: capitals, populations, area, continent, borders, currencies,
 * languages — from Wikidata.
 *
 * Each multi-valued property (a country can have several borders, currencies,
 * languages, or even capitals) is its own simple query, merged by ISO code in
 * JS. Combining them into one query would join every combination of those
 * properties together — a cartesian blow-up — for no benefit.
 */
async function collectCountries() {
  // One at a time rather than in parallel: all five queries hit the same
  // shared Wikidata endpoint, and firing them together makes an already
  // slow public service more likely to time out or rate-limit every one of
  // them at once. This runs as a background refresh, not on a player
  // request, so trading a slower total time for reliability is the right
  // call.
  const core = await sparql(`
    SELECT ?code (SAMPLE(?countryLabel) AS ?name) (SAMPLE(?continentLabel) AS ?continent)
           (MAX(?population) AS ?pop) (MAX(?area) AS ?ar) WHERE {
      ?country ${COUNTRY_PATTERN}.
      OPTIONAL { ?country wdt:P1082 ?population. }
      OPTIONAL { ?country wdt:P2046 ?area. }
      OPTIONAL { ?country wdt:P30 ?continent. }
      SERVICE wikibase:label {
        bd:serviceParam wikibase:language "en".
        ?country rdfs:label ?countryLabel.
        ?continent rdfs:label ?continentLabel.
      }
    }
    GROUP BY ?code
  `);
  // Not grouped/sampled: combining SAMPLE() with the label service silently
  // drops the label on this endpoint. A plain pair list, deduped in JS, is
  // both correct and simpler.
  const capitals = await sparql(`
    SELECT ?code ?capitalItemLabel WHERE {
      ?country ${COUNTRY_PATTERN}; wdt:P36 ?capitalItem.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `);
  const borders = await sparql(`
    SELECT ?code ?borderCode WHERE {
      ?country ${COUNTRY_PATTERN}; wdt:P47 ?border.
      ?border wdt:P298 ?borderCode.
    }
  `);
  const currencies = await sparql(`
    SELECT ?code ?currencyLabel WHERE {
      ?country ${COUNTRY_PATTERN}; wdt:P38 ?currency.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `);
  const languages = await sparql(`
    SELECT ?code ?languageLabel WHERE {
      ?country ${COUNTRY_PATTERN}; wdt:P37 ?language.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `);

  // The label service occasionally can't resolve a label (rare, but seen in
  // practice for a handful of currency items) and falls back to printing the
  // raw entity id instead — e.g. "Q4916" rather than "Euro". Reject anything
  // shaped like a bare Wikidata id, the same guard already used for mountain
  // and river names below.
  const isRealLabel = (value) => typeof value === 'string' && value.length > 0 && !/^Q\d+$/.test(value);

  const firstByCode = (rows, valueKey) => {
    const map = new Map();
    for (const row of rows) {
      const code = cell(row, 'code');
      const val = cell(row, valueKey);
      if (code && isRealLabel(val) && !map.has(code)) map.set(code, val);
    }
    return map;
  };

  const setsByCode = (rows, valueKey) => {
    const map = new Map();
    for (const row of rows) {
      const code = cell(row, 'code');
      const val = cell(row, valueKey);
      if (!code || !isRealLabel(val)) continue;
      if (!map.has(code)) map.set(code, new Set());
      map.get(code).add(val);
    }
    return map;
  };

  const capitalByCode = firstByCode(capitals, 'capitalItemLabel');
  const bordersByCode = setsByCode(
    borders.filter((r) => cell(r, 'code') !== cell(r, 'borderCode')),
    'borderCode',
  );
  const currenciesByCode = setsByCode(currencies, 'currencyLabel');
  const languagesByCode = setsByCode(languages, 'languageLabel');

  return core
    .map((row) => {
      const code = cell(row, 'code');
      const name = cell(row, 'name');
      if (!code || !isRealLabel(name)) return null;

      const population = Number.parseFloat(cell(row, 'pop'));
      const area = Number.parseFloat(cell(row, 'ar'));
      const continent = cell(row, 'continent');

      return {
        kind: 'country',
        name,
        code,
        capital: capitalByCode.get(code) ?? null,
        population: Number.isFinite(population) ? population : null,
        area: Number.isFinite(area) ? area : null,
        region: isRealLabel(continent) ? continent : null,
        subregion: null,
        borders: [...(bordersByCode.get(code) ?? [])],
        currencies: [...(currenciesByCode.get(code) ?? [])].map((currencyName) => ({
          code: '',
          name: currencyName,
        })),
        languages: [...(languagesByCode.get(code) ?? [])],
      };
    })
    .filter((c) => c && c.region);
}

async function collectPeaks() {
  const rows = await sparql(`
    SELECT ?mountainLabel ?elevation ?countryLabel WHERE {
      ?mountain wdt:P31/wdt:P279* wd:Q8502 ;
                wdt:P2044 ?elevation ;
                wdt:P17 ?country .
      FILTER(?elevation > 4000)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    ORDER BY DESC(?elevation)
    LIMIT 120
  `);
  const seen = new Set();
  return rows
    .map((r) => ({
      kind: 'mountain',
      name: r.mountainLabel?.value,
      elevation: Number.parseFloat(r.elevation?.value),
      country: r.countryLabel?.value,
    }))
    .filter((m) => {
      if (!m.name || !Number.isFinite(m.elevation) || /^Q\d+$/.test(m.name)) return false;
      if (seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
}

async function collectRivers() {
  const rows = await sparql(`
    SELECT ?riverLabel ?length ?continentLabel WHERE {
      ?river wdt:P31/wdt:P279* wd:Q4022 ;
             wdt:P2043 ?length .
      OPTIONAL { ?river wdt:P30 ?continent . }
      FILTER(?length > 1000)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    ORDER BY DESC(?length)
    LIMIT 100
  `);
  const seen = new Set();
  return rows
    .map((r) => ({
      kind: 'river',
      name: r.riverLabel?.value,
      lengthKm: Number.parseFloat(r.length?.value),
      continent: r.continentLabel?.value ?? null,
    }))
    .filter((r) => {
      if (!r.name || !Number.isFinite(r.lengthKm) || /^Q\d+$/.test(r.name)) return false;
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    });
}

const DATASETS = [
  {
    id: 'wikidata-countries',
    sourceName: 'Wikidata',
    url: 'https://query.wikidata.org/',
    title: 'Country reference data (capitals, populations, borders, currencies, languages)',
    load: collectCountries,
  },
  {
    id: 'wikidata-peaks',
    sourceName: 'Wikidata',
    url: 'https://query.wikidata.org/',
    title: 'Mountain elevations (Wikidata structured query)',
    load: collectPeaks,
  },
  {
    id: 'wikidata-rivers',
    sourceName: 'Wikidata',
    url: 'https://query.wikidata.org/',
    title: 'River lengths (Wikidata structured query)',
    load: collectRivers,
  },
];

/**
 * Returns one source document per dataset. `facts.records` holds the structured
 * rows the templates draw both answers and distractors from.
 */
export async function collect() {
  const now = new Date();
  // All three datasets query the same shared Wikidata endpoint, and this is a
  // background refresh rather than a player-facing request, so run them one
  // at a time rather than piling concurrent load onto a public service.
  const loaded = await settleAll(
    DATASETS.map((dataset) => async () => {
      const records = await dataset.load();
      if (!records.length) throw new Error(`${dataset.id} returned no rows`);
      return { dataset, records };
    }),
    { concurrency: 1, label: 'geographyProvider' },
  );

  return loaded.map(({ dataset, records }) => ({
    provider: 'geographyProvider',
    category: 'geography',
    title: dataset.title,
    url: dataset.url,
    sourceName: dataset.sourceName,
    publishedAt: now,
    facts: { datasetId: dataset.id, recordCount: records.length, records },
    // Checksum includes the row count so a materially changed snapshot is
    // stored as a new document rather than silently deduplicated away.
    checksum: sha256(`geographyProvider|${dataset.id}|${records.length}|${todayGameDay()}`),
  }));
}

export default { collect, name: 'geographyProvider' };
