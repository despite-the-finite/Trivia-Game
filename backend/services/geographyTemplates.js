import { shuffle } from '../lib/ids.js';

/**
 * Deterministic geography question templates.
 *
 * Both the correct answer and every distractor are read out of the structured
 * dataset supplied by geographyProvider. Nothing here guesses, and nothing here
 * calls a model — so a geography question is wrong only if the upstream
 * authoritative dataset is wrong.
 */

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

function sampleDistinct(pool, count, rng, exclude = new Set()) {
  const candidates = pool.filter((v) => !exclude.has(v));
  if (candidates.length < count) return null;
  return shuffle(candidates, rng).slice(0, count);
}

/**
 * Difficulty is a function of how prominent the subject is. A capital-city
 * question about a top-40 country is easy; the same question about a country
 * ranked 120th by population is hard.
 */
function difficultyByRank(rank, total) {
  const percentile = rank / Math.max(total, 1);
  if (percentile <= 0.25) return 'easy';
  if (percentile <= 0.6) return 'medium';
  return 'hard';
}

function bumpDifficulty(level) {
  return level === 'easy' ? 'medium' : 'hard';
}

const formatNumber = (n) => new Intl.NumberFormat('en-US').format(Math.round(n));

/**
 * @param {Array} records Flattened records from every geography dataset.
 * @param {Function} rng
 * @param {number} limit
 */
export function buildGeographyQuestions(records, rng = Math.random, limit = 120) {
  const countries = records.filter((r) => r.kind === 'country');
  const mountains = records.filter((r) => r.kind === 'mountain');
  const rivers = records.filter((r) => r.kind === 'river');

  const byCode = new Map(countries.map((c) => [c.code, c]));
  const popRanked = [...countries]
    .filter((c) => Number.isFinite(c.population))
    .sort((a, b) => b.population - a.population);
  const rankOf = new Map(popRanked.map((c, i) => [c.code, i]));
  const prominence = (country) =>
    difficultyByRank(rankOf.get(country.code) ?? popRanked.length, popRanked.length);

  const builders = [];

  // --- Capitals -----------------------------------------------------------
  const withCapital = countries.filter((c) => c.capital);
  const allCapitals = withCapital.map((c) => c.capital);

  for (const country of withCapital) {
    builders.push(() => {
      const distractors = sampleDistinct(
        withCapital.filter((c) => c.region === country.region).map((c) => c.capital),
        3,
        rng,
        new Set([country.capital]),
      ) ?? sampleDistinct(allCapitals, 3, rng, new Set([country.capital]));
      if (!distractors) return null;
      return {
        topic: `capital:${country.code}`,
        difficulty: prominence(country),
        question: `What is the capital city of ${country.name}?`,
        correctAnswer: country.capital,
        distractors,
        explanation: `${country.capital} is the capital of ${country.name}.`,
      };
    });

    builders.push(() => {
      const distractors = sampleDistinct(
        withCapital.filter((c) => c.region === country.region).map((c) => c.name),
        3,
        rng,
        new Set([country.name]),
      );
      if (!distractors) return null;
      return {
        topic: `capital-of:${country.code}`,
        difficulty: bumpDifficulty(prominence(country)),
        question: `${country.capital} is the capital of which country?`,
        correctAnswer: country.name,
        distractors,
        explanation: `${country.capital} is the capital of ${country.name}.`,
      };
    });
  }

  // --- Region / continent -------------------------------------------------
  for (const country of countries.filter((c) => c.region)) {
    builders.push(() => {
      const regions = [...new Set(countries.map((c) => c.region))].filter(Boolean);
      const distractors = sampleDistinct(regions, 3, rng, new Set([country.region]));
      if (!distractors) return null;
      return {
        topic: `region:${country.code}`,
        difficulty: prominence(country),
        question: `In which region of the world is ${country.name} located?`,
        correctAnswer: country.region,
        distractors,
        explanation: `${country.name} is in ${country.region}${country.subregion ? ` (${country.subregion})` : ''}.`,
      };
    });
  }

  // --- Population comparisons --------------------------------------------
  // Only build these where the gap is large enough that the ordering is not a
  // coin flip for a well-informed player.
  for (let i = 0; i < popRanked.length - 12; i += 4) {
    builders.push(() => {
      const target = popRanked[i];
      const others = popRanked.slice(i + 6, i + 40);
      const distractors = sampleDistinct(others.map((c) => c.name), 3, rng, new Set([target.name]));
      if (!distractors) return null;
      const smallest = others.find((c) => distractors.includes(c.name));
      if (!smallest || target.population < smallest.population * 1.3) return null;
      return {
        topic: `population:${target.code}`,
        difficulty: i < 12 ? 'easy' : i < 45 ? 'medium' : 'hard',
        question: 'Which of these countries has the largest population?',
        correctAnswer: target.name,
        distractors,
        explanation: `${target.name} has roughly ${formatNumber(target.population)} people, more than the others listed.`,
      };
    });
  }

  // --- Land area ----------------------------------------------------------
  const areaRanked = [...countries]
    .filter((c) => Number.isFinite(c.area) && c.area > 0)
    .sort((a, b) => b.area - a.area);
  for (let i = 0; i < areaRanked.length - 12; i += 5) {
    builders.push(() => {
      const target = areaRanked[i];
      const others = areaRanked.slice(i + 6, i + 40);
      const distractors = sampleDistinct(others.map((c) => c.name), 3, rng, new Set([target.name]));
      if (!distractors) return null;
      return {
        topic: `area:${target.code}`,
        difficulty: i < 10 ? 'easy' : i < 40 ? 'medium' : 'hard',
        question: 'Which of these countries covers the largest land area?',
        correctAnswer: target.name,
        distractors,
        explanation: `${target.name} covers about ${formatNumber(target.area)} km², the largest of the four.`,
      };
    });
  }

  // --- Neighbours ---------------------------------------------------------
  for (const country of countries.filter((c) => c.borders?.length)) {
    builders.push(() => {
      const neighbourCodes = new Set(country.borders);
      const neighbours = country.borders.map((code) => byCode.get(code)?.name).filter(Boolean);
      if (!neighbours.length) return null;
      const nonNeighbours = countries
        .filter((c) => c.code !== country.code && !neighbourCodes.has(c.code) && c.region === country.region)
        .map((c) => c.name);
      const distractors = sampleDistinct(nonNeighbours, 3, rng);
      if (!distractors) return null;
      const correct = pick(neighbours, rng);
      return {
        topic: `border:${country.code}:${correct}`,
        difficulty: bumpDifficulty(prominence(country)),
        question: `Which of these countries shares a land border with ${country.name}?`,
        correctAnswer: correct,
        distractors,
        explanation: `${correct} borders ${country.name}. The other options do not share a land border with it.`,
      };
    });
  }

  // --- Currencies ---------------------------------------------------------
  const allCurrencyNames = [
    ...new Set(countries.flatMap((c) => c.currencies.map((cur) => cur.name)).filter(Boolean)),
  ];
  for (const country of countries.filter((c) => c.currencies.length === 1 && c.currencies[0].name)) {
    builders.push(() => {
      const correct = country.currencies[0].name;
      const distractors = sampleDistinct(allCurrencyNames, 3, rng, new Set([correct]));
      if (!distractors) return null;
      return {
        topic: `currency:${country.code}`,
        difficulty: bumpDifficulty(prominence(country)),
        question: `What is the official currency of ${country.name}?`,
        correctAnswer: correct,
        distractors,
        explanation: `${country.name} uses the ${correct}.`,
      };
    });
  }

  // --- Languages ----------------------------------------------------------
  const allLanguages = [...new Set(countries.flatMap((c) => c.languages).filter(Boolean))];
  for (const country of countries.filter((c) => c.languages.length === 1)) {
    builders.push(() => {
      const correct = country.languages[0];
      const distractors = sampleDistinct(allLanguages, 3, rng, new Set([correct]));
      if (!distractors) return null;
      return {
        topic: `language:${country.code}`,
        difficulty: prominence(country),
        question: `Which language is official in ${country.name}?`,
        correctAnswer: correct,
        distractors,
        explanation: `${correct} is the official language of ${country.name}.`,
      };
    });
  }

  // --- Mountains ----------------------------------------------------------
  const sortedPeaks = [...mountains].sort((a, b) => b.elevation - a.elevation);
  for (let i = 0; i < sortedPeaks.length - 8; i += 2) {
    builders.push(() => {
      const target = sortedPeaks[i];
      const others = sortedPeaks.slice(i + 3, i + 30);
      const distractors = sampleDistinct(others.map((m) => m.name), 3, rng, new Set([target.name]));
      if (!distractors) return null;
      return {
        topic: `peak-height:${target.name}`,
        difficulty: i < 6 ? 'medium' : 'hard',
        question: 'Which of these mountains is the highest?',
        correctAnswer: target.name,
        distractors,
        explanation: `${target.name} rises to about ${formatNumber(target.elevation)} m, the highest of the four.`,
      };
    });
  }

  for (const peak of sortedPeaks.filter((m) => m.country)) {
    builders.push(() => {
      const countryNames = [...new Set(sortedPeaks.map((m) => m.country).filter(Boolean))];
      const distractors = sampleDistinct(countryNames, 3, rng, new Set([peak.country]));
      if (!distractors) return null;
      return {
        topic: `peak-country:${peak.name}`,
        difficulty: 'hard',
        question: `In which country would you find ${peak.name}?`,
        correctAnswer: peak.country,
        distractors,
        explanation: `${peak.name} (about ${formatNumber(peak.elevation)} m) is in ${peak.country}.`,
      };
    });
  }

  // --- Rivers -------------------------------------------------------------
  const sortedRivers = [...rivers].sort((a, b) => b.lengthKm - a.lengthKm);
  for (let i = 0; i < sortedRivers.length - 8; i += 2) {
    builders.push(() => {
      const target = sortedRivers[i];
      const others = sortedRivers.slice(i + 3, i + 30);
      const distractors = sampleDistinct(others.map((r) => r.name), 3, rng, new Set([target.name]));
      if (!distractors) return null;
      return {
        topic: `river-length:${target.name}`,
        difficulty: i < 5 ? 'medium' : 'hard',
        question: 'Which of these rivers is the longest?',
        correctAnswer: target.name,
        distractors,
        explanation: `The ${target.name} runs about ${formatNumber(target.lengthKm)} km, the longest of the four.`,
      };
    });
  }

  // Build in random order and stop once we have enough, so successive refreshes
  // surface different slices of the dataset.
  const out = [];
  const seenTopics = new Set();
  for (const build of shuffle(builders, rng)) {
    if (out.length >= limit) break;
    let candidate;
    try {
      candidate = build();
    } catch {
      continue;
    }
    if (!candidate) continue;
    if (seenTopics.has(candidate.topic)) continue;

    const answers = [candidate.correctAnswer, ...candidate.distractors];
    if (new Set(answers.map((a) => String(a).toLowerCase())).size !== answers.length) continue;
    if (answers.some((a) => typeof a !== 'string' || !a.trim())) continue;

    seenTopics.add(candidate.topic);
    out.push(candidate);
  }
  return out;
}
