/**
 * Tests for v0.18.0 canonical relevance floors: RELEVANCE_FLOORS, isRelevant,
 * filterRelevant. These are pure functions over a hit's `distance` field — no
 * DB needed. They are the single source of "close enough" the shells used to
 * each re-answer (and drift on).
 *
 * Run with: node --test test/relevance-floors.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const brain = require('../src/index.js');

test('RELEVANCE_FLOORS exposes the two measured tiers, frozen', () => {
  assert.equal(brain.RELEVANCE_FLOORS.strict, 0.33);
  assert.equal(brain.RELEVANCE_FLOORS.loose, 0.40);
  assert.ok(Object.isFrozen(brain.RELEVANCE_FLOORS));
  // strict is tighter than loose (precision over recall)
  assert.ok(brain.RELEVANCE_FLOORS.strict < brain.RELEVANCE_FLOORS.loose);
});

test('isRelevant: strict tier (default) — below floor is relevant, at/above is not', () => {
  assert.equal(brain.isRelevant({ distance: 0.20 }), true);
  assert.equal(brain.isRelevant({ distance: 0.32 }), true);
  assert.equal(brain.isRelevant({ distance: 0.33 }), false); // floor is exclusive
  assert.equal(brain.isRelevant({ distance: 0.45 }), false);
});

test('isRelevant: loose tier admits the exploration band strict rejects', () => {
  // 0.37 is noise to ambient auto-inject but a fair link for user-driven explore
  assert.equal(brain.isRelevant({ distance: 0.37 }, 'strict'), false);
  assert.equal(brain.isRelevant({ distance: 0.37 }, 'loose'), true);
  assert.equal(brain.isRelevant({ distance: 0.40 }, 'loose'), false); // still exclusive
});

test('isRelevant: a hit with no numeric distance is always relevant', () => {
  // exact-id fetches were never ranked, so they have nothing to floor against
  assert.equal(brain.isRelevant({}), true);
  assert.equal(brain.isRelevant({ distance: null }), true);
  assert.equal(brain.isRelevant({ distance: 'x' }), true);
  assert.equal(brain.isRelevant(null), true);
  assert.equal(brain.isRelevant(undefined), true);
});

test('isRelevant: an unknown tier is a programming error, not a silent pass', () => {
  assert.throws(() => brain.isRelevant({ distance: 0.1 }, 'medium'), /unknown relevance tier/);
});

test('filterRelevant: keeps relevant hits, preserves order, defaults strict', () => {
  const hits = [
    { filename: 'a', distance: 0.10 },
    { filename: 'b', distance: 0.38 },  // noise at strict, ok at loose
    { filename: 'c', distance: 0.30 },
    { filename: 'd', distance: 0.60 },
  ];
  assert.deepEqual(brain.filterRelevant(hits).map((h) => h.filename), ['a', 'c']);
  assert.deepEqual(brain.filterRelevant(hits, 'loose').map((h) => h.filename), ['a', 'b', 'c']);
  assert.deepEqual(brain.filterRelevant([]), []);
  assert.deepEqual(brain.filterRelevant(null), []);
  assert.deepEqual(brain.filterRelevant(undefined), []);
});
