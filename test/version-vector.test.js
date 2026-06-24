/**
 * Continuity fix (Phase 0) — version-vector algebra + schema migration.
 *
 * Step 1 of the causal-merge continuity fix: the primitive that replaces silent
 * wall-clock last-write-wins. These tests pin the algebra directly (it is subtle
 * and load-bearing) and confirm the migration adds the three new columns.
 *
 * Run with: node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');
const { vvParse, vvStringify, vvBump, vvMerge, vvCompare } = brain._internal;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-vv-test-'));
}

// ── _vvParse — tolerant of legacy/garbage; never throws ────────────────────

test('vvParse: empty/null/garbage all degrade to {}', () => {
  assert.deepEqual(vvParse(''), {});
  assert.deepEqual(vvParse(null), {});
  assert.deepEqual(vvParse(undefined), {});
  assert.deepEqual(vvParse('{}'), {});
  assert.deepEqual(vvParse('not json'), {});
  assert.deepEqual(vvParse('[1,2,3]'), {}); // arrays are not vectors
  assert.deepEqual(vvParse('42'), {});
});

test('vvParse: coerces to {string: positive-int}, dropping garbage entries', () => {
  assert.deepEqual(vvParse('{"A":3,"B":1}'), { A: 3, B: 1 });
  // floats floored, zero/negative dropped, non-numeric dropped, empty-key dropped
  assert.deepEqual(vvParse('{"A":2.9,"B":0,"C":-4,"D":"x","":5}'), { A: 2 });
  // accepts an already-parsed object too
  assert.deepEqual(vvParse({ A: 1 }), { A: 1 });
});

// ── _vvStringify — deterministic (sorted keys), stable across devices ──────

test('vvStringify: sorted keys → byte-identical regardless of insertion order', () => {
  assert.equal(vvStringify({ B: 1, A: 2 }), '{"A":2,"B":1}');
  assert.equal(vvStringify({ A: 2, B: 1 }), '{"A":2,"B":1}');
  assert.equal(vvStringify({}), '{}');
  // round-trips through parse cleanly
  assert.equal(vvStringify(vvParse('{"z":1,"a":1}')), '{"a":1,"z":1}');
});

// ── _vvBump — record a local edit ──────────────────────────────────────────

test('vvBump: increments this device, leaves others untouched', () => {
  assert.deepEqual(vvBump({}, 'A'), { A: 1 });
  assert.deepEqual(vvBump({ A: 1, B: 2 }, 'A'), { A: 2, B: 2 });
  assert.deepEqual(vvBump('{"A":1}', 'B'), { A: 1, B: 1 }); // accepts a string vector
});

test('vvBump: refuses to bump under a missing identity (no unattributable entry)', () => {
  assert.deepEqual(vvBump({ A: 1 }, ''), { A: 1 });
  assert.deepEqual(vvBump({ A: 1 }, null), { A: 1 });
});

// ── _vvMerge — join of two histories (element-wise max) ────────────────────

test('vvMerge: element-wise max', () => {
  assert.deepEqual(vvMerge({ A: 1, B: 3 }, { A: 2, C: 1 }), { A: 2, B: 3, C: 1 });
  assert.deepEqual(vvMerge({}, { A: 5 }), { A: 5 });
});

// ── _vvCompare — the causal arbiter ────────────────────────────────────────

test('vvCompare: equal lineages', () => {
  assert.equal(vvCompare({}, {}), 'equal');
  assert.equal(vvCompare({ A: 2, B: 1 }, { A: 2, B: 1 }), 'equal');
});

test('vvCompare: strict domination either way', () => {
  // a has everything b has, plus more
  assert.equal(vvCompare({ A: 2, B: 1 }, { A: 1, B: 1 }), 'a-dominates');
  assert.equal(vvCompare({ A: 1, B: 1 }, { A: 2, B: 1 }), 'b-dominates');
  // an empty (legacy/backfilled) vector is the earliest lineage → any edit dominates it
  assert.equal(vvCompare({ A: 1 }, {}), 'a-dominates');
  assert.equal(vvCompare({}, { A: 1 }), 'b-dominates');
});

test('vvCompare: concurrent — each side has an edit the other never saw', () => {
  // classic two-device conflict: A bumped on device A, B bumped on device B
  assert.equal(vvCompare({ A: 1 }, { B: 1 }), 'concurrent');
  assert.equal(vvCompare({ A: 2, B: 1 }, { A: 1, B: 2 }), 'concurrent');
});

test('vvCompare: a bump produces a vector that dominates its parent (fast-forward path)', () => {
  const parent = { A: 1, B: 2 };
  const child = vvBump(parent, 'A');
  assert.equal(vvCompare(child, parent), 'a-dominates');
  assert.equal(vvCompare(parent, child), 'b-dominates');
});

test('vvCompare: two independent bumps off the same parent are concurrent (real conflict)', () => {
  const parent = { A: 1 };
  const onB = vvBump(parent, 'B'); // device B edits
  const onC = vvBump(parent, 'C'); // device C edits, never having seen B's
  assert.equal(vvCompare(onB, onC), 'concurrent');
});

// ── Schema migration — the three new columns exist + default correctly ─────

test('migration: memories/state/steering gain version_vector, content_hash, deleted_at', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.setMemory('vv-probe.md', 'hello');
    await brain.setState('vv-key', 'v');

    // Step 1 only ADDS the columns; the write path stamping them is step 2. So a
    // freshly-set row must read back with the column DEFAULTS: version_vector '{}'
    // (earliest lineage), content_hash NULL, deleted_at NULL (live).
    for (const [t, col, val] of [
      ['memories', 'filename', 'vv-probe.md'],
      ['state', 'key', 'vv-key'],
    ]) {
      const r = await brain._internal.query(
        `SELECT version_vector, content_hash, deleted_at FROM ${t} WHERE ${col} = $1`, [val]);
      assert.equal(r.rows.length, 1, `${t} row should exist`);
      assert.equal(r.rows[0].version_vector, '{}', `${t}.version_vector default`);
      assert.equal(r.rows[0].content_hash, null, `${t}.content_hash default`);
      assert.equal(r.rows[0].deleted_at, null, `${t}.deleted_at default`);
    }

    // steering column existence (no public setter wired in this test) — assert the
    // columns are queryable, which proves the ALTER ran.
    const s = await brain._internal.query(
      'SELECT version_vector, content_hash, deleted_at FROM steering LIMIT 0');
    assert.ok(s.fields.some((f) => f.name === 'version_vector'), 'steering.version_vector exists');
    assert.ok(s.fields.some((f) => f.name === 'content_hash'), 'steering.content_hash exists');
    assert.ok(s.fields.some((f) => f.name === 'deleted_at'), 'steering.deleted_at exists');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
