import { fetchJson } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';

/**
 * geographyProvider — structured, authoritative geographic data.
 *
 * Geography is the category where we deliberately do NOT let a model decide
 * what is true. Every fact here comes from a structured dataset fetched over
 * the network (Wikidata), and the question templates derive the
 * answer *and* the distractors from that same data. The LLM's only optional
 * role downstream is rephrasing the question text — never determining the
 * answer.
 */

/**
 * Country reference data comes from Wikidata.
 *
 * It used to come from REST Countries, which is now deprecated: v3.1 answers a
 * 200 carrying an error object rather than the country array, and v5 requires
 * an API key. Wikidata needs no key, is already the source for peaks and
 * rivers, and is authoritative structured data — which is the property this
 * category depends on, since geography answers and distractors both come
 * straight from the dataset and are never decided by a model.
 *
 * Three queries rather than one. Every OPTIONAL in SPARQL multiplies the
 * intermediate result, and a single query carrying capital, population, area,
 * continent, borders, currencies and languages is heavy enough to risk
 * Wikidata's own query timeout. Splitting also means a failure is partial: the
 * core query is what a run cannot do without, and the other two each cost one
 * family of questions if they fail.
 */

/** Instances of this are sovereign states. */
const SOVEREIGN_STATE = 'wd:Q3624078';

/** Shared preamble: current sovereign states, with an English label. */
const COUNTRY_BASE = `
  ?c wdt:P31 ${SOVEREIGN_STATE} ;
     rdfs:label ?cLabel .
  FILTER(lang(?cLabel) = "en")
  FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
`;

/**
 * Capital, population, area and continent.
 *
 * Area is read through `psn:` — the normalised value — rather than `wdt:`.
 * Wikidata stores areas against a unit, and truth values hand back the bare
 * number, so a country recorded in square miles or square metres would be
 * compared directly against one recorded in square kilometres and produce a
 * confidently wrong "which is largest" answer. Normalised quantities are always
 * in the SI unit, square metres, which converts cleanly.
 */
const COUNTRY_CORE_QUERY = `
  SELECT ?c ?cLabel
         (SAMPLE(?capLabel) AS ?capital)
         (MAX(?pop)   AS ?population)
         (MAX(?areaM2) AS ?areaSquareMetres)
         (SAMPLE(?contLabel) AS ?continent)
  WHERE {
    ${COUNTRY_BASE}
    OPTIONAL { ?c wdt:P36 ?cap . ?cap rdfs:label ?capLabel . FILTER(lang(?capLabel) = "en") }
    OPTIONAL { ?c wdt:P1082 ?pop }
    OPTIONAL { ?c p:P2046/psn:P2046/wikibase:quantityAmount ?areaM2 }
    OPTIONAL { ?c wdt:P30 ?cont . ?cont rdfs:label ?contLabel . FILTER(lang(?contLabel) = "en") }
  }
  GROUP BY ?c ?cLabel
`;

/**
 * Land borders, as entity ids so they join against the country list by key
 * rather than by name. Restricted to borders with other sovereign states, which
 * is what a "which country borders X?" question means.
 */
const COUNTRY_BORDER_QUERY = `
  SELECT ?c (GROUP_CONCAT(DISTINCT ?border; separator="|") AS ?borders)
  WHERE {
    ${COUNTRY_BASE}
    ?c wdt:P47 ?border .
    ?border wdt:P31 ${SOVEREIGN_STATE} .
    FILTER NOT EXISTS { ?border wdt:P576 ?borderDissolved }
  }
  GROUP BY ?c
`;

/** Official currency and official language. Both are genuinely multi-valued. */
const COUNTRY_DETAIL_QUERY = `
  SELECT ?c
         (GROUP_CONCAT(DISTINCT ?curLabel;  separator="|") AS ?currencies)
         (GROUP_CONCAT(DISTINCT ?langLabel; separator="|") AS ?languages)
  WHERE {
    ${COUNTRY_BASE}
    OPTIONAL { ?c wdt:P38 ?cur  . ?cur  rdfs:label ?curLabel  . FILTER(lang(?curLabel)  = "en") }
    OPTIONAL { ?c wdt:P37 ?lang . ?lang rdfs:label ?langLabel . FILTER(lang(?langLabel) = "en") }
  }
  GROUP BY ?c
`;

const WIKIDATA_SPARQL = process.env.WIKIDATA_SPARQL_URL || 'https://query.wikidata.org/sparql';

async function sparql(query) {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const body = await fetchJson(url, { accept: 'application/sparql-results+json', timeoutMs: 25000 });
  return body?.results?.bindings ?? [];
}

/** "http://www.wikidata.org/entity/Q30" -> "Q30". Used as each country's key. */
const entityId = (uri) => (typeof uri === 'string' ? uri.split('/').pop() : null);

const splitList = (value) =>
  typeof value === 'string' && value.length
    ? [...new Set(value.split('|').map((v) => v.trim()).filter(Boolean))]
    : [];

const numberOrNull = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Countries: capitals, populations, area, continent, borders, currencies,
 * languages — merged from the three queries above.
 *
 * Only the core query is allowed to fail the run. Borders, currencies and
 * languages each back one family of questions, so losing them costs variety
 * but still leaves a usable, correct batch.
 */
async function collectCountries() {
  const core = await sparql(COUNTRY_CORE_QUERY);
  if (!core.length) {
    throw new Error('Wikidata returned no sovereign states for the country query');
  }

  const countries = new Map();
  for (const row of core) {
    const code = entityId(row.c?.value);
    const name = row.cLabel?.value;
    if (!code || !name) continue;
    // Wikidata labels fall back to the entity id when no English label exists;
    // "Q1234" is not a country name a player should ever be shown.
    if (/^Q\d+$/.test(name)) continue;

    const areaM2 = numberOrNull(row.areaSquareMetres?.value);
    countries.set(code, {
      kind: 'country',
      name,
      officialName: name,
      code,
      capital: row.capital?.value || null,
      population: numberOrNull(row.population?.value),
      // Normalised quantities are square metres; the templates talk in km².
      area: areaM2 === null ? null : areaM2 / 1_000_000,
      region: row.continent?.value || null,
      subregion: null,
      borders: [],
      currencies: [],
      languages: [],
    });
  }

  // Borders and details are enrichment: a failure here narrows the question mix
  // rather than ending the run, so it is logged and swallowed deliberately.
  await Promise.all([
    (async () => {
      try {
        for (const row of await sparql(COUNTRY_BORDER_QUERY)) {
          const country = countries.get(entityId(row.c?.value));
          if (!country) continue;
          country.borders = splitList(row.borders?.value)
            .map(entityId)
            .filter((code) => code && countries.has(code));
        }
      } catch (err) {
        console.warn(`[geographyProvider] border data unavailable: ${err.message}`);
      }
    })(),
    (async () => {
      try {
        for (const row of await sparql(COUNTRY_DETAIL_QUERY)) {
          const country = countries.get(entityId(row.c?.value));
          if (!country) continue;
          country.currencies = splitList(row.currencies?.value)
            .filter((n) => !/^Q\d+$/.test(n))
            .map((name) => ({ code: name, name }));
          country.languages = splitList(row.languages?.value).filter((n) => !/^Q\d+$/.test(n));
        }
      } catch (err) {
        console.warn(`[geographyProvider] currency and language data unavailable: ${err.message}`);
      }
    })(),
  ]);

  // A country with no continent cannot supply same-region distractors, which is
  // what keeps a capital-city question from offering four random continents.
  const usable = [...countries.values()].filter((c) => c.name && c.region);
  if (!usable.length) {
    throw new Error(
      `Wikidata returned ${countries.size} countries but none carried a continent`,
    );
  }
  return usable;
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

export const DATASETS = [
  {
    id: 'wikidata-countries',
    sourceName: 'Wikidata',
    url: 'https://query.wikidata.org/',
    title: 'Country reference data (capitals, populations, areas, borders, currencies, languages)',
    load: collectCountries,
    // Countries carry eight of the eleven question shapes. Without them a
    // batch collapses into "which mountain is highest" and "which river is
    // longest", which is a worse outcome than no batch at all — a bad batch is
    // cached for weeks and is what players actually see.
    required: true,
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

  // Deliberately NOT settleAll here. Swallowing a per-dataset failure makes a
  // partially-loaded run indistinguishable from a healthy one: the pipeline
  // reports "accepted 120 questions" and nobody learns that two thirds of the
  // variety never arrived. Failures are collected and reported instead.
  const results = await Promise.all(
    DATASETS.map(async (dataset) => {
      try {
        const records = await dataset.load();
        if (!records.length) throw new Error('returned no rows');
        return { dataset, records };
      } catch (err) {
        console.warn(`[geographyProvider] ${dataset.id} failed: ${err.message}`);
        return { dataset, error: err.message };
      }
    }),
  );

  const loaded = results.filter((r) => r.records);
  const failed = results.filter((r) => r.error);

  const missingRequired = failed.filter((r) => r.dataset.required);
  if (missingRequired.length) {
    throw new Error(
      `geography source data incomplete — ${missingRequired
        .map((r) => `${r.dataset.id} (${r.error})`)
        .join('; ')}. Refusing to build a batch from the remaining datasets, which ` +
        'would produce only superlative questions.',
    );
  }
  if (!loaded.length) throw new Error('no geography dataset could be loaded');
  if (failed.length) {
    console.warn(
      `[geographyProvider] continuing without: ${failed.map((r) => r.dataset.id).join(', ')}`,
    );
  }

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
    checksum: sha256(`geographyProvider|${dataset.id}|${records.length}|${now.toISOString().slice(0, 10)}`),
  }));
}

export default { collect, name: 'geographyProvider' };
