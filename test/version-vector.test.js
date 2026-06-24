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

    // Test the column DEFAULTS purely by RAW inserts that bypass the stamping setter
    // (setMemory/setState now stamp version_vector — step 2). A row that pre-dates
    // the feature (or any non-setter writer) must read back: version_vector '{}'
    // (earliest lineage), content_hash NULL, deleted_at NULL (live).
    await brain._internal.query(
      "INSERT INTO memories (filename, content, updated_at) VALUES ('raw.md', 'x', '2026-01-01T00:00:00Z')");
    await brain._internal.query(
      "INSERT INTO state (key, value, updated_at) VALUES ('raw', 'x', '2026-01-01T00:00:00Z')");
    for (const [t, col, val] of [
      ['memories', 'filename', 'raw.md'],
      ['state', 'key', 'raw'],
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

// ── Step 2: local write path stamps version_vector + content_hash ──────────

async function deviceId() {
  const r = await brain._internal.query("SELECT value FROM brain_meta WHERE key = 'substrate_identity'");
  return r.rows[0].value;
}

test('setMemory stamps version_vector keyed by this bowl + content_hash', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    const sha256 = brain._internal.sha256;

    await brain.setMemory('note.md', 'first');
    const me = await deviceId(); // substrate_identity is created lazily on first write
    let r = await brain._internal.query('SELECT version_vector, content_hash FROM memories WHERE filename=$1', ['note.md']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 1 }), 'first write → counter 1');
    assert.equal(r.rows[0].content_hash, sha256('first'), 'content_hash set');

    // a genuine edit advances this device's counter
    await brain.setMemory('note.md', 'second');
    r = await brain._internal.query('SELECT version_vector, content_hash FROM memories WHERE filename=$1', ['note.md']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 2 }), 'edit → counter 2');
    assert.equal(r.rows[0].content_hash, sha256('second'));

    // re-saving IDENTICAL content must NOT advance (no phantom causal history)
    await brain.setMemory('note.md', 'second');
    r = await brain._internal.query('SELECT version_vector FROM memories WHERE filename=$1', ['note.md']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 2 }), 'identical re-save → no advance');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setMemory stamps on the embedding path too', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    const emb = Array.from({ length: 384 }, () => 0.01);
    await brain.setMemory('emb.md', 'body', 'brain', 'instance', emb);
    const me = await deviceId();
    const r = await brain._internal.query('SELECT version_vector, content_hash FROM memories WHERE filename=$1', ['emb.md']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 1 }));
    assert.equal(r.rows[0].content_hash, brain._internal.sha256('body'));
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setState stamps version_vector + content_hash, idempotent on identical value', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.setState('k', 'v1');
    const me = await deviceId();
    let r = await brain._internal.query('SELECT version_vector, content_hash FROM state WHERE key=$1', ['k']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 1 }));
    assert.equal(r.rows[0].content_hash, brain._internal.sha256('v1'));

    await brain.setState('k', 'v1'); // identical → no advance
    r = await brain._internal.query('SELECT version_vector FROM state WHERE key=$1', ['k']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 1 }));

    await brain.setState('k', 'v2'); // changed → advance
    r = await brain._internal.query('SELECT version_vector FROM state WHERE key=$1', ['k']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 2 }));
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
