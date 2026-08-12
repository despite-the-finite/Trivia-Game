import { fetchJson, settleAll } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';

/**
 * geographyProvider — structured, authoritative geographic data.
 *
 * Geography is the category where we deliberately do NOT let a model decide
 * what is true. Every fact here comes from a structured dataset fetched over
 * the network (REST Countries, Wikidata), and the question templates derive the
 * answer *and* the distractors from that same data. The LLM's only optional
 * role downstream is rephrasing the question text — never determining the
 * answer.
 */

const REST_COUNTRIES_URL =
  process.env.REST_COUNTRIES_URL ||
  'https://restcountries.com/v3.1/all?fields=name,cca3,capital,population,area,region,subregion,borders,currencies,languages,flags,independent,unMember';

const WIKIDATA_SPARQL = process.env.WIKIDATA_SPARQL_URL || 'https://query.wikidata.org/sparql';

async function sparql(query) {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const body = await fetchJson(url, { accept: 'application/sparql-results+json', timeoutMs: 25000 });
  return body?.results?.bindings ?? [];
}

/** Countries: capitals, populations, area, region, borders, currencies, languages, flags. */
async function collectCountries() {
  const raw = await fetchJson(REST_COUNTRIES_URL, { timeoutMs: 25000 });
  if (!Array.isArray(raw)) throw new Error('REST Countries returned an unexpected payload');

  return raw
    .filter((c) => c?.name?.common && c.unMember && c.independent)
    .map((c) => ({
      kind: 'country',
      name: c.name.common,
      officialName: c.name.official ?? c.name.common,
      code: c.cca3,
      capital: Array.isArray(c.capital) && c.capital.length === 1 ? c.capital[0] : null,
      population: Number.isFinite(c.population) ? c.population : null,
      area: Number.isFinite(c.area) ? c.area : null,
      region: c.region ?? null,
      subregion: c.subregion ?? null,
      borders: Array.isArray(c.borders) ? c.borders : [],
      currencies: c.currencies
        ? Object.entries(c.currencies).map(([code, v]) => ({ code, name: v?.name ?? code }))
        : [],
      languages: c.languages ? Object.values(c.languages) : [],
    }))
    .filter((c) => c.name && c.region);
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
    id: 'rest-countries',
    sourceName: 'REST Countries',
    url: 'https://restcountries.com/',
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
  const loaded = await settleAll(
    DATASETS.map((dataset) => async () => {
      const records = await dataset.load();
      if (!records.length) throw new Error(`${dataset.id} returned no rows`);
      return { dataset, records };
    }),
    { concurrency: 3, label: 'geographyProvider' },
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
    checksum: sha256(`geographyProvider|${dataset.id}|${records.length}|${now.toISOString().slice(0, 10)}`),
  }));
}

export default { collect, name: 'geographyProvider' };
