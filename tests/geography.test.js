import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeographyQuestions } from '../backend/services/geographyTemplates.js';
import { seededRandom, shuffle, normalizeFriendCode, friendCode } from '../backend/lib/ids.js';

/**
 * A stand-in for what geographyProvider returns from
 * Wikidata. The point of these tests is that answers come from the data, not
 * from a model — so every assertion checks the data, not phrasing.
 */
const records = [
  ...[
    ['France', 'FRA', 'Paris', 68_000_000, 551_695, 'Europe', ['DEU', 'ESP'], 'Euro', ['French']],
    ['Germany', 'DEU', 'Berlin', 84_000_000, 357_022, 'Europe', ['FRA', 'POL'], 'Euro', ['German']],
    ['Spain', 'ESP', 'Madrid', 47_000_000, 505_992, 'Europe', ['FRA', 'PRT'], 'Euro', ['Spanish']],
    ['Portugal', 'PRT', 'Lisbon', 10_000_000, 92_090, 'Europe', ['ESP'], 'Euro', ['Portuguese']],
    ['Poland', 'POL', 'Warsaw', 38_000_000, 312_679, 'Europe', ['DEU'], 'Zloty', ['Polish']],
    ['Japan', 'JPN', 'Tokyo', 125_000_000, 377_930, 'Asia', [], 'Japanese yen', ['Japanese']],
    ['Kenya', 'KEN', 'Nairobi', 54_000_000, 580_367, 'Africa', [], 'Kenyan shilling', ['Swahili']],
    ['Brazil', 'BRA', 'Brasília', 214_000_000, 8_515_767, 'Americas', [], 'Brazilian real', ['Portuguese']],
    ['Chile', 'CHL', 'Santiago', 19_000_000, 756_102, 'Americas', [], 'Chilean peso', ['Spanish']],
    ['Peru', 'PER', 'Lima', 33_000_000, 1_285_216, 'Americas', [], 'Peruvian sol', ['Spanish']],
    ['Nepal', 'NPL', 'Kathmandu', 30_000_000, 147_181, 'Asia', [], 'Nepalese rupee', ['Nepali']],
    ['Egypt', 'EGY', 'Cairo', 104_000_000, 1_002_450, 'Africa', [], 'Egyptian pound', ['Arabic']],
  ].map(([name, code, capital, population, area, region, borders, currency, languages]) => ({
    kind: 'country',
    name,
    code,
    capital,
    population,
    area,
    region,
    subregion: region,
    borders,
    currencies: [{ code: currency.slice(0, 3).toUpperCase(), name: currency }],
    languages,
  })),
  { kind: 'mountain', name: 'Mount Everest', elevation: 8849, country: 'Nepal' },
  { kind: 'mountain', name: 'K2', elevation: 8611, country: 'Pakistan' },
  { kind: 'mountain', name: 'Kangchenjunga', elevation: 8586, country: 'Nepal' },
  { kind: 'mountain', name: 'Lhotse', elevation: 8516, country: 'Nepal' },
  { kind: 'mountain', name: 'Makalu', elevation: 8485, country: 'Nepal' },
  { kind: 'mountain', name: 'Cho Oyu', elevation: 8188, country: 'Nepal' },
  { kind: 'mountain', name: 'Dhaulagiri', elevation: 8167, country: 'Nepal' },
  { kind: 'mountain', name: 'Manaslu', elevation: 8163, country: 'Nepal' },
  { kind: 'mountain', name: 'Annapurna', elevation: 8091, country: 'Nepal' },
  { kind: 'mountain', name: 'Denali', elevation: 6190, country: 'United States' },
  { kind: 'mountain', name: 'Aconcagua', elevation: 6961, country: 'Argentina' },
  { kind: 'mountain', name: 'Kilimanjaro', elevation: 5895, country: 'Tanzania' },
  { kind: 'river', name: 'Nile', lengthKm: 6650, continent: 'Africa' },
  { kind: 'river', name: 'Amazon', lengthKm: 6400, continent: 'South America' },
  { kind: 'river', name: 'Yangtze', lengthKm: 6300, continent: 'Asia' },
  { kind: 'river', name: 'Mississippi', lengthKm: 3766, continent: 'North America' },
  { kind: 'river', name: 'Yenisei', lengthKm: 3487, continent: 'Asia' },
  { kind: 'river', name: 'Danube', lengthKm: 2850, continent: 'Europe' },
  { kind: 'river', name: 'Rhine', lengthKm: 1230, continent: 'Europe' },
  { kind: 'river', name: 'Loire', lengthKm: 1006, continent: 'Europe' },
  { kind: 'river', name: 'Elbe', lengthKm: 1094, continent: 'Europe' },
  { kind: 'river', name: 'Vistula', lengthKm: 1047, continent: 'Europe' },
];

const byName = new Map(records.filter((r) => r.kind === 'country').map((c) => [c.name, c]));

test('templates produce well-formed four-option questions', () => {
  const questions = buildGeographyQuestions(records, seededRandom('test'), 60);
  assert.ok(questions.length > 10, `expected a healthy batch, got ${questions.length}`);

  for (const q of questions) {
    const options = [q.correctAnswer, ...q.distractors];
    assert.equal(options.length, 4, `${q.question} should have four options`);
    assert.equal(new Set(options).size, 4, `${q.question} has duplicate options`);
    assert.ok(q.question.endsWith('?'));
    assert.ok(['easy', 'medium', 'hard'].includes(q.difficulty));
    assert.ok(q.explanation.length > 10);
    assert.ok(
      !options.some((o) => typeof o !== 'string' || !o.trim()),
      'no empty options',
    );
  }
});

test('capital-city answers come from the dataset, not from phrasing', () => {
  const questions = buildGeographyQuestions(records, seededRandom('capitals'), 200);
  const capitalQuestions = questions.filter((q) => q.topic.startsWith('capital:'));
  assert.ok(capitalQuestions.length > 0);

  for (const q of capitalQuestions) {
    const country = [...byName.values()].find((c) => q.question.includes(c.name));
    assert.ok(country, `could not identify the country in: ${q.question}`);
    assert.equal(q.correctAnswer, country.capital);
    // Distractors must be other real capitals, never the right one.
    for (const distractor of q.distractors) {
      assert.notEqual(distractor, country.capital);
    }
  }
});

test('border questions never offer a real neighbour as a distractor', () => {
  const questions = buildGeographyQuestions(records, seededRandom('borders'), 200);
  const borderQuestions = questions.filter((q) => q.topic.startsWith('border:'));

  for (const q of borderQuestions) {
    const [, code] = q.topic.split(':');
    const country = [...byName.values()].find((c) => c.code === code);
    const neighbourNames = new Set(
      country.borders.map((c) => [...byName.values()].find((x) => x.code === c)?.name),
    );
    assert.ok(neighbourNames.has(q.correctAnswer), `${q.correctAnswer} should border ${country.name}`);
    for (const distractor of q.distractors) {
      assert.ok(
        !neighbourNames.has(distractor),
        `${distractor} also borders ${country.name} — the question would have two right answers`,
      );
    }
  }
});

test('superlative questions have exactly one true superlative', () => {
  const questions = buildGeographyQuestions(records, seededRandom('super'), 200);
  const peakQuestions = questions.filter((q) => q.topic.startsWith('peak-height:'));
  const heights = new Map(
    records.filter((r) => r.kind === 'mountain').map((m) => [m.name, m.elevation]),
  );

  assert.ok(peakQuestions.length > 0);
  for (const q of peakQuestions) {
    const correctHeight = heights.get(q.correctAnswer);
    for (const distractor of q.distractors) {
      assert.ok(
        heights.get(distractor) < correctHeight,
        `${distractor} is not shorter than ${q.correctAnswer}`,
      );
    }
  }
});

test('population comparisons only ship when the gap is decisive', () => {
  const questions = buildGeographyQuestions(records, seededRandom('pop'), 200);
  const popQuestions = questions.filter((q) => q.topic.startsWith('population:'));

  for (const q of popQuestions) {
    const correct = byName.get(q.correctAnswer);
    for (const distractor of q.distractors) {
      assert.ok(
        correct.population > byName.get(distractor).population,
        `${distractor} is not smaller than ${q.correctAnswer}`,
      );
    }
  }
});

test('the same seed always produces the same set', () => {
  const a = buildGeographyQuestions(records, seededRandom('stable'), 30);
  const b = buildGeographyQuestions(records, seededRandom('stable'), 30);
  assert.deepEqual(
    a.map((q) => q.topic),
    b.map((q) => q.topic),
    'a seeded build must be reproducible — this is what makes the daily challenge identical for everyone',
  );
});

test('different seeds surface different slices of the dataset', () => {
  const a = buildGeographyQuestions(records, seededRandom('seed-a'), 20).map((q) => q.topic);
  const b = buildGeographyQuestions(records, seededRandom('seed-b'), 20).map((q) => q.topic);
  assert.notDeepEqual(a, b);
});

test('a seeded shuffle is a permutation and is reproducible', () => {
  const input = [0, 1, 2, 3, 4, 5, 6, 7];
  const a = shuffle(input, seededRandom('perm'));
  const b = shuffle(input, seededRandom('perm'));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), input);
});

test('friend codes round-trip through normalisation', () => {
  const code = friendCode('Karsh');
  assert.match(code, /^[A-Z0-9]+-[A-Z0-9]{4}$/);
  assert.equal(normalizeFriendCode(code), code);
  assert.equal(normalizeFriendCode(code.toLowerCase().replace('-', ' ')), code);
  assert.equal(normalizeFriendCode('nope'), null);
});

// ---------------------------------------------------------------------------
// Batch variety
//
// A deployment shipped a bank made entirely of "which mountain is highest" and
// "which river is longest", because the countries dataset failed to load and
// nothing noticed. These cover both halves of that: the fetch that failed, and
// the batch shape that let the survivors take everything.
// ---------------------------------------------------------------------------

const familyCounts = (questions) => {
  const counts = new Map();
  for (const q of questions) {
    const family = q.topic.split(':')[0];
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return counts;
};

function fakeCountries(n = 120) {
  const regions = ['Europe', 'Asia', 'Africa', 'Americas', 'Oceania'];
  return Array.from({ length: n }, (_, i) => ({
    kind: 'country',
    name: `Country ${i}`,
    code: `C${String(i).padStart(3, '0')}`,
    capital: `Capital ${i}`,
    population: (n * 2 - i) * 1_000_000,
    area: (n * 2 - i) * 10_000,
    region: regions[i % regions.length],
    subregion: null,
    borders: [`C${String((i + 1) % n).padStart(3, '0')}`],
    currencies: [{ code: `X${i}`, name: `Currency ${i}` }],
    languages: [`Language ${i}`],
  }));
}

const fakePeaks = (n = 120) =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'mountain', name: `Peak ${i}`, elevation: 8800 - i * 20, country: `Country ${i % 12}`,
  }));

const fakeRivers = (n = 100) =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'river', name: `River ${i}`, lengthKm: 6500 - i * 30, continent: 'Asia',
  }));

test('no single question type can dominate a batch', () => {
  const records = [...fakeCountries(), ...fakePeaks(), ...fakeRivers()];
  const built = buildGeographyQuestions(records, seededRandom('variety'), 120);

  assert.ok(built.length >= 100, `expected a full batch, got ${built.length}`);

  const counts = familyCounts(built);
  const largest = Math.max(...counts.values());
  assert.ok(
    largest / built.length <= 0.21,
    `one family took ${Math.round((largest / built.length) * 100)}% of the batch: ` +
      [...counts].map(([f, n]) => `${f}=${n}`).join(' '),
  );
  assert.ok(counts.size >= 5, `expected at least 5 kinds of question, got ${counts.size}`);
});

test('losing a dataset shrinks the batch rather than making it repetitive', () => {
  // Exactly the state that produced the bad bank: peaks and rivers only.
  const built = buildGeographyQuestions([...fakePeaks(), ...fakeRivers()], seededRandom('partial'), 120);
  const counts = familyCounts(built);
  const largest = Math.max(...counts.values());

  assert.ok(
    largest / 120 <= 0.21,
    'even with only superlative data available, no family may fill the batch',
  );
  assert.ok(
    built.length < 120,
    'a short batch is the correct outcome here — padding it means repeating one question shape',
  );
});

test('every question family stays reachable', () => {
  const records = [...fakeCountries(), ...fakePeaks(), ...fakeRivers()];
  // A large limit so the ceiling is not what is being measured.
  const built = buildGeographyQuestions(records, seededRandom('families'), 600);
  const families = new Set([...familyCounts(built).keys()]);

  for (const expected of [
    'capital', 'capital-of', 'region', 'area', 'border',
    'currency', 'language', 'peak-height', 'peak-country', 'river-length',
  ]) {
    assert.ok(families.has(expected), `no ${expected} questions were produced at all`);
  }
});
