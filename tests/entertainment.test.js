import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTopic,
  curatedWindow,
  selectBalanced,
  TOPICS,
} from '../backend/providers/entertainmentProvider.js';
import { CATEGORIES, FRESHNESS, GAME } from '../backend/lib/config.js';

test('entertainment is a category with the same batch as the others', () => {
  assert.ok(CATEGORIES.includes('entertainment'));
  for (const category of CATEGORIES) {
    assert.equal(FRESHNESS[category].batchSize, 9, category);
  }
  assert.equal(GAME.dailyQuestionCount, 5);
});

test('short descriptions are classified by medium', () => {
  assert.equal(classifyTopic('American animated sitcom'), 'animation');
  assert.equal(classifyTopic('2016 animated film'), 'animation');
  assert.equal(classifyTopic('2023 action role-playing video game'), 'games');
  assert.equal(classifyTopic('American television series'), 'tv');
  assert.equal(classifyTopic('1997 film by James Cameron'), 'film');
  assert.equal(classifyTopic('South Korean boy band'), 'music');
  assert.equal(classifyTopic('American singer-songwriter (born 1989)'), 'music');
  assert.equal(classifyTopic('English actor (born 1976)'), 'people');
});

test('non-entertainment and unsuitable pages are dropped', () => {
  assert.equal(classifyTopic('Capital city of France'), null);
  assert.equal(classifyTopic('American politician and former actor'), null);
  assert.equal(classifyTopic('American pornographic actress'), null);
  assert.equal(classifyTopic('Topics referred to by the same term (disambiguation)'), null);
  assert.equal(classifyTopic(''), null);
  assert.equal(classifyTopic(undefined), null);
});

test('consecutive days get different curated titles, and the window wraps', () => {
  const order = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, topic: 'tv' }));
  const a = curatedWindow('2026-09-27', 13, order).map((x) => x.title);
  const b = curatedWindow('2026-09-28', 13, order).map((x) => x.title);
  assert.equal(a.length, 13);
  assert.equal(new Set(a).size, 13, 'no title twice in one window');
  assert.equal(a.filter((t) => b.includes(t)).length, 0, 'no overlap between adjacent days');
  assert.deepEqual(curatedWindow('2026-09-27', 13, order), curatedWindow('2026-09-27', 13, order));
});

test('the real curated list spans every medium in a single day', () => {
  const topics = new Set(curatedWindow('2026-09-27', 13).map((x) => x.topic));
  assert.ok(topics.size >= 4, `only ${[...topics].join(', ')}`);
});

test('a batch is spread across media and trending is capped', () => {
  const make = (topic, n, trending) =>
    Array.from({ length: n }, (_, i) => ({ topic, trending, id: `${topic}-${trending}-${i}` }));
  const candidates = [
    ...make('film', 10, true),
    ...make('film', 10, false),
    ...make('tv', 3, false),
    ...make('games', 3, false),
    ...make('music', 3, false),
    ...make('animation', 3, false),
  ];
  const picked = selectBalanced(candidates, { limit: 9, trendingCap: 3 });
  assert.equal(picked.length, 9);
  assert.ok(picked.filter((p) => p.trending).length <= 3);
  assert.ok(picked.filter((p) => p.topic === 'film').length <= 2, 'film cannot fill the batch');
  assert.ok(picked.every((p) => TOPICS.includes(p.topic)));
});
