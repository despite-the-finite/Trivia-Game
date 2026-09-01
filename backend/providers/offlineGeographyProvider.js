import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * offlineGeographyProvider — the same records geographyProvider produces, built
 * from packaged datasets instead of live HTTP.
 *
 * geographyProvider fetches REST Countries and Wikidata at refresh time. That is
 * right for a deployed server and useless for the offline bank, which has to be
 * built once and then shipped inside the page. This provider emits records in
 * the identical shape so `buildGeographyQuestions` — the same deterministic
 * template code the live pipeline runs — cannot tell the difference.
 *
 * Only time-invariant facts are used. Capitals, borders, areas, elevations and
 * river lengths do not go stale between builds; populations are loaded purely to
 * rank countries by prominence (which drives difficulty) and never appear in a
 * question or an explanation. See scripts/build-bank.js, which drops the
 * population-comparison template for exactly that reason.
 */

const COUNTRIES_SOURCE = {
  datasetId: 'world-countries',
  sourceName: 'world-countries dataset',
  url: 'https://github.com/mledoze/countries',
  title: 'Country reference data (capitals, regions, borders, areas, currencies, languages)',
};

const PHYSICAL_SOURCE = {
  datasetId: 'physical-geography',
  sourceName: 'Physical geography reference data',
  url: 'https://www.usgs.gov/faqs',
  title: 'Mountain elevations and river lengths',
};

/**
 * Two entries whose measurements are within `tolerance` of each other cannot
 * safely anchor a "which is larger" question — published figures for peaks and
 * especially rivers disagree by more than the gap. Keeping the taller/longer of
 * any such pair means every comparison the templates build has real daylight in
 * it.
 */
function dropNearTies(items, valueOf, tolerance) {
  const sorted = [...items].sort((a, b) => valueOf(b) - valueOf(a));
  const kept = [];
  for (const item of sorted) {
    const last = kept[kept.length - 1];
    if (last && valueOf(last) - valueOf(item) < valueOf(last) * tolerance) continue;
    kept.push(item);
  }
  return kept;
}

function loadCountries() {
  const all = require('world-countries');
  const populations = new Map(
    require('../data/populations.json').countries.map((row) => [row.cca3, row.population]),
  );

  return all
    .filter((c) => c?.name?.common && c.unMember && c.independent)
    // The dataset marks Vatican City a UN member (it is an observer state), and
    // a city-state whose capital is itself makes both a nonsense question and a
    // cruel distractor for "Rome is the capital of which country?".
    .filter((c) => c.cca3 !== 'VAT')
    .map((c) => ({
      kind: 'country',
      name: c.name.common,
      officialName: c.name.official ?? c.name.common,
      code: c.cca3,
      capital: Array.isArray(c.capital) && c.capital.length === 1 ? c.capital[0] : null,
      population: populations.get(c.cca3) ?? null,
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

function loadPhysical() {
  const { mountains, rivers } = require('../data/peaks-rivers.json');

  const peaks = dropNearTies(
    mountains.filter((m) => m.name && Number.isFinite(m.elevation) && m.elevation > 4000),
    (m) => m.elevation,
    0.01,
  ).map((m) => ({ kind: 'mountain', name: m.name, elevation: m.elevation, country: m.country ?? null }));

  const flows = dropNearTies(
    rivers.filter((r) => r.name && Number.isFinite(r.lengthKm) && r.lengthKm > 1000),
    (r) => r.lengthKm,
    0.03,
  ).map((r) => ({ kind: 'river', name: r.name, lengthKm: r.lengthKm, continent: r.continent ?? null }));

  return [...peaks, ...flows];
}

/** Mirrors geographyProvider.collect(): one source document per dataset. */
export function collect() {
  const now = new Date();
  const documents = [
    { meta: COUNTRIES_SOURCE, records: loadCountries() },
    { meta: PHYSICAL_SOURCE, records: loadPhysical() },
  ];

  return documents.map(({ meta, records }) => ({
    provider: 'offlineGeographyProvider',
    category: 'geography',
    title: meta.title,
    url: meta.url,
    sourceName: meta.sourceName,
    publishedAt: now,
    facts: { datasetId: meta.datasetId, recordCount: records.length, records },
  }));
}

export default { collect, name: 'offlineGeographyProvider' };
