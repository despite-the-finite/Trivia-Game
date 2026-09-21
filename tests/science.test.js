import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTopic, selectBalanced, MAX_SPACE_SHARE } from '../backend/providers/scienceProvider.js';
import { difficultyShares, DIFFICULTY_MIX } from '../backend/services/questionService.js';

const item = (title, summary = '') => ({ title, summary });

test('a feed with its own topic keeps it regardless of wording', () => {
  assert.equal(classifyTopic(item('Star cluster found in deep sea coral'), 'biology'), 'biology');
});

test('general-feed items are classified from their text', () => {
  assert.equal(classifyTopic(item('New telescope image reveals a distant galaxy')), 'space');
  assert.equal(classifyTopic(item('Bees learn to recognise human faces')), 'biology');
  assert.equal(classifyTopic(item('Volcano eruption triggers glacier collapse')), 'earth');
  assert.equal(classifyTopic(item('A new catalyst speeds up plastic recycling')), 'chemistry');
  assert.equal(classifyTopic(item('Quantum computer reaches a new record')), 'physics');
  assert.equal(classifyTopic(item('Something entirely unrelated happened')), 'other');
});

test('a prolific space feed cannot dominate the batch', () => {
  const now = Date.now();
  const space = Array.from({ length: 40 }, (_, i) => ({
    topic: 'space', sourceName: i % 2 ? 'NASA' : 'ESA', publishedAt: new Date(now - i * 1000),
  }));
  const others = ['biology', 'earth', 'chemistry', 'physics', 'health', 'tech'].flatMap((topic) =>
    Array.from({ length: 6 }, (_, i) => ({
      topic, sourceName: `${topic}-feed`, publishedAt: new Date(now - 100000 - i * 1000),
    })),
  );

  const picked = selectBalanced([...space, ...others], { limit: 30, sourceCap: 6 });
  const spaceCount = picked.filter((p) => p.topic === 'space').length;

  assert.equal(picked.length, 30);
  assert.ok(spaceCount <= Math.floor(30 * MAX_SPACE_SHARE), `space was ${spaceCount} of 30`);
  const topics = new Set(picked.map((p) => p.topic));
  assert.equal(topics.size, 7, 'every topic is represented');
});

test('space is capped even when it is the only material available', () => {
  const space = Array.from({ length: 20 }, (_, i) => ({
    topic: 'space', sourceName: `s${i}`, publishedAt: new Date(Date.now() - i),
  }));
  const picked = selectBalanced(space, { limit: 30, sourceCap: 6 });
  assert.equal(picked.length, Math.floor(30 * MAX_SPACE_SHARE));
});

test('no single source can exceed its cap', () => {
  const same = Array.from({ length: 20 }, (_, i) => ({
    topic: 'biology', sourceName: 'One Feed', publishedAt: new Date(Date.now() - i),
  }));
  assert.equal(selectBalanced(same, { limit: 30, sourceCap: 4 }).length, 4);
});

test('difficulty shares always sum to the count and lean easy', () => {
  for (let count = 1; count <= 20; count += 1) {
    const [easy, medium, hard] = difficultyShares(count);
    assert.equal(easy + medium + hard, count);
    assert.ok(easy >= medium && medium >= hard, `count ${count}: ${easy}/${medium}/${hard}`);
  }
  assert.deepEqual(difficultyShares(10), [5, 4, 1]);
  assert.ok(DIFFICULTY_MIX.hard < DIFFICULTY_MIX.easy);
});
