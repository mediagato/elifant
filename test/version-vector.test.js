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

// ── Step 3: soft-delete tombstones ─────────────────────────────────────────

test('deleteMemory soft-deletes (tombstone + VV bump); reads filter it out', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.setMemory('gone.md', 'body');          // {me:1}
    const me = await deviceId();
    await brain.deleteMemory('gone.md');

    // user-facing reads no longer see it
    assert.equal(await brain.getMemory('gone.md'), null, 'getMemory hides tombstone');
    const all = await brain.getAllMemories();
    assert.ok(!all.some((m) => m.filename === 'gone.md'), 'getAllMemories hides tombstone');

    // but the row physically persists as a tombstone: deleted_at set, VV advanced
    const r = await brain._internal.query('SELECT deleted_at, version_vector FROM memories WHERE filename=$1', ['gone.md']);
    assert.equal(r.rows.length, 1, 'row retained as tombstone');
    assert.ok(r.rows[0].deleted_at, 'deleted_at set');
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 2 }), 'delete advances VV (causal event)');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteMemory is idempotent (missing key / existing tombstone do not re-bump)', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.deleteMemory('never-existed.md'); // no throw, no row
    let r = await brain._internal.query('SELECT 1 FROM memories WHERE filename=$1', ['never-existed.md']);
    assert.equal(r.rows.length, 0);

    await brain.setMemory('x.md', 'b');
    const me = await deviceId();
    await brain.deleteMemory('x.md');             // {me:2}, deleted
    await brain.deleteMemory('x.md');             // second delete: no-op, no re-bump
    r = await brain._internal.query('SELECT version_vector FROM memories WHERE filename=$1', ['x.md']);
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 2 }), 'no double-bump on re-delete');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-writing a deleted memory resurrects it (clears deleted_at, advances VV)', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.setMemory('r.md', 'orig');         // {me:1}
    const me = await deviceId();
    await brain.deleteMemory('r.md');              // {me:2}, tombstone
    await brain.setMemory('r.md', 'orig');         // resurrect with IDENTICAL content

    const got = await brain.getMemory('r.md');
    assert.ok(got, 'resurrected memory is visible again');
    assert.equal(got.content, 'orig');
    const r = await brain._internal.query('SELECT deleted_at, version_vector FROM memories WHERE filename=$1', ['r.md']);
    assert.equal(r.rows[0].deleted_at, null, 'deleted_at cleared on resurrect');
    // resurrect is a NEW event even though content matches the deleted body → VV must advance
    assert.equal(r.rows[0].version_vector, JSON.stringify({ [me]: 3 }), 'resurrect advances VV past the tombstone');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteState soft-deletes; getState/getAllState hide it', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.setState('sk', 'sv');
    await brain.deleteState('sk');
    assert.equal(await brain.getState('sk'), null, 'getState hides tombstone');
    const all = await brain.getAllState();
    assert.ok(!all.some((s) => s.key === 'sk'), 'getAllState hides tombstone');
    const r = await brain._internal.query('SELECT deleted_at FROM state WHERE key=$1', ['sk']);
    assert.ok(r.rows[0].deleted_at, 'state tombstone persists');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneTombstones reaps old tombstones, retains recent ones, advances watermark', async () => {
  const dir = tmpDir();
  try {
    await brain.init(dir);
    await brain.setMemory('old.md', 'a');
    await brain.deleteMemory('old.md');
    // back-date the tombstone so it is clearly older than the cutoff
    await brain._internal.query("UPDATE memories SET deleted_at = '2020-01-01T00:00:00Z' WHERE filename='old.md'");
    await brain.setMemory('recent.md', 'b');
    await brain.deleteMemory('recent.md'); // tombstoned now (~today)

    const reaped = await brain.pruneTombstones({ olderThan: '2021-01-01T00:00:00Z' });
    assert.equal(reaped, 1, 'only the back-dated tombstone is reaped');

    let r = await brain._internal.query('SELECT 1 FROM memories WHERE filename=$1', ['old.md']);
    assert.equal(r.rows.length, 0, 'old tombstone hard-deleted');
    r = await brain._internal.query('SELECT deleted_at FROM memories WHERE filename=$1', ['recent.md']);
    assert.equal(r.rows.length, 1, 'recent tombstone retained');

    const wm = await brain._internal.query("SELECT value FROM brain_meta WHERE key='tombstone_prune_watermark'");
    assert.equal(wm.rows[0].value, '2021-01-01T00:00:00Z', 'watermark advanced');

    await assert.rejects(() => brain.pruneTombstones({}), /olderThan/, 'requires an explicit cutoff');
  } finally {
    await brain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
