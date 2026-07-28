/**
 * Instance armor + feeder armor (capture-flood postmortem, 2026-07-28).
 *
 * Regression suite for the real-world failure where a feeder POSTed the same
 * ~358 KB payload every minute until an unbounded `SELECT ... FROM captures`
 * crossed PGlite's WASM memory ceiling — after which the instance either
 * trapped 'memory access out of bounds' forever (zombie) or silently returned
 * empty results for every query (a brain reporting itself empty while the data
 * sat intact on disk).
 *
 * Covers: consecutive-duplicate suppression, the per-capture size cap, the
 * byte-budgeted reader (order, filters, limit under multi-batch fetch), and
 * end-to-end recovery from injected WASM-death and silent-empty failures.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
}

test('addCapture suppresses CONSECUTIVE byte-identical duplicates only', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const a = await brain.addCapture({ source: 'feeder', type: 'bookmark', data: { set: 'A' } });
  assert.equal(a.deduped, undefined, 'first write must store');

  // same payload, different key order — jsonb normalization must still match
  const dup = await brain.addCapture({ source: 'feeder', type: 'bookmark', data: { set: 'A' } });
  assert.equal(dup.deduped, true, 'consecutive identical payload must be suppressed');
  assert.equal(dup.id, a.id, 'suppressed write returns the existing row');

  const b = await brain.addCapture({ source: 'feeder', type: 'bookmark', data: { set: 'B' } });
  assert.equal(b.deduped, undefined, 'a different payload must store');

  // A -> B -> A: the re-appearing payload is a REAL event, not a duplicate
  const a2 = await brain.addCapture({ source: 'feeder', type: 'bookmark', data: { set: 'A' } });
  assert.equal(a2.deduped, undefined, 'A after B is a new event — only consecutive dups collapse');

  // same payload, different type — independent streams
  const other = await brain.addCapture({ source: 'feeder', type: 'tab', data: { set: 'A' } });
  assert.equal(other.deduped, undefined, 'dedup is scoped to (source, type)');

  const rows = await brain.getCaptures({ source: 'feeder' });
  assert.equal(rows.length, 4, 'A, B, A, and the other-type row — the dup never landed');

  await brain.close();
});

test('addCapture allowDuplicate: true stores the repeat', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.addCapture({ source: 'heartbeat', type: 'ping', data: { ok: true } });
  const again = await brain.addCapture({ source: 'heartbeat', type: 'ping', data: { ok: true }, allowDuplicate: true });
  assert.equal(again.deduped, undefined);

  const rows = await brain.getCaptures({ source: 'heartbeat' });
  assert.equal(rows.length, 2);

  await brain.close();
});

test('addCapture dedups null-data captures too', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const first = await brain.addCapture({ source: 'nulls', type: 'evt' });
  const second = await brain.addCapture({ source: 'nulls', type: 'evt' });
  assert.equal(second.deduped, true, 'two consecutive null-data captures collapse');
  assert.equal(second.id, first.id);

  await brain.close();
});

test('addCapture rejects a payload over the size cap, loudly', async () => {
  const dir = tmpDir();
  process.env.ELIFANT_MAX_CAPTURE_BYTES = '2048';
  try {
    await brain.init(dir);
    await assert.rejects(
      brain.addCapture({ source: 'fat', type: 'dump', data: { blob: 'x'.repeat(4096) } }),
      (e) => e.code === 'ECAPTURETOOLARGE' && /too large/.test(e.message),
      'oversized capture must be rejected with ECAPTURETOOLARGE'
    );
    // an in-cap payload still stores fine
    const ok = await brain.addCapture({ source: 'fat', type: 'dump', data: { blob: 'x'.repeat(64) } });
    assert.ok(ok.id);
  } finally {
    delete process.env.ELIFANT_MAX_CAPTURE_BYTES;
    await brain.close();
  }
});

test('getCaptures under a tiny read budget: multi-batch fetch preserves rows, order, filters, limit', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  // 30 captures ~2 KB each, distinct payloads, strictly increasing ts so the
  // expected order is unambiguous. allowDuplicate not needed (all distinct).
  const N = 30;
  for (let i = 0; i < N; i++) {
    const ts = `2026-07-28T10:${String(i).padStart(2, '0')}:00Z`;
    await brain.addCapture({ source: i % 2 === 0 ? 'even' : 'odd', type: 'evt', ts, data: { i, pad: 'p'.repeat(2000) } });
  }

  process.env.ELIFANT_READ_BUDGET_BYTES = '65536'; // floor: forces ~2KB rows into many batches
  try {
    const all = await brain.getCaptures({});
    assert.equal(all.length, N, 'every row comes back across batches');
    const seq = all.map((r) => r.data.i);
    assert.deepEqual(seq, [...Array(N).keys()].reverse(), 'newest-first order holds across batch boundaries');
    assert.equal(all[0].data.pad.length, 2000, 'payloads survive the batched fetch intact');

    const even = await brain.getCaptures({ source: 'even' });
    assert.equal(even.length, N / 2);
    assert.ok(even.every((r) => r.source === 'even'));

    const limited = await brain.getCaptures({ limit: 7 });
    assert.equal(limited.length, 7, 'limit is honored');
    assert.deepEqual(limited.map((r) => r.data.i), [29, 28, 27, 26, 25, 24, 23], 'limit takes the NEWEST rows');

    const windowed = await brain.getCaptures({ since: '2026-07-28T10:10:00Z', until: '2026-07-28T10:14:00Z' });
    assert.deepEqual(windowed.map((r) => r.data.i), [14, 13, 12, 11, 10], 'since/until window holds');
  } finally {
    delete process.env.ELIFANT_READ_BUDGET_BYTES;
    await brain.close();
  }
});

test('same-second captures come back in deterministic id-DESC order', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const ts = '2026-07-28T12:00:00Z';
  await brain.addCapture({ source: 's', type: 'e', ts, data: { n: 1 } });
  await brain.addCapture({ source: 's', type: 'e', ts, data: { n: 2 } });
  await brain.addCapture({ source: 's', type: 'e', ts, data: { n: 3 } });

  const rows = await brain.getCaptures({ source: 's' });
  assert.deepEqual(rows.map((r) => r.data.n), [3, 2, 1], 'id DESC breaks the ts tie, newest insert first');

  await brain.close();
});

test('_batchByBudget packs by bytes, one oversized row rides alone', () => {
  const batch = brain._internal.armor.batchByBudget;
  const rows = [
    { id: 1, len: 400 }, { id: 2, len: 400 }, { id: 3, len: 400 },
    { id: 4, len: 5000 }, // alone: bigger than the whole budget
    { id: 5, len: 100 }, { id: 6, len: 100 },
  ];
  const batches = batch(rows, 1000);
  assert.deepEqual(batches, [[1, 2], [3], [4], [5, 6]]);
  // degenerate inputs
  assert.deepEqual(batch([], 1000), []);
  assert.deepEqual(batch([{ id: 9, len: 999999 }], 10), [[9]], 'a single row always fetches, however fat');
});

test('_isWasmDeath classifies the real-world error strings', () => {
  const is = brain._internal.armor.isWasmDeath;
  assert.equal(is(new Error('memory access out of bounds')), true);
  assert.equal(is(new Error('RuntimeError: table index is out of bounds')), true);
  assert.equal(is(new Error('Aborted(native code called abort())')), true);
  assert.equal(is(new Error('null function or function signature mismatch')), true);
  assert.equal(is(new Error('duplicate key value violates unique constraint')), false);
  assert.equal(is(new Error('connection refused')), false);
  assert.equal(is(null), false);
});

test('RECOVERY: a WASM-death on one query reopens the instance and the retry serves real data', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setState('canary_key', 'canary_value', 'test');

  // next guarded call observes a WASM trap at the raw layer
  brain._internal.armor.simulateFailure('wasm-death', 1);
  const got = await brain.getState('canary_key');
  assert.ok(got, 'the guarded retry after reopen must serve the read');
  assert.equal(got.value, 'canary_value', 'data survives the reopen');

  // instance stays healthy afterwards
  const again = await brain.getState('canary_key');
  assert.equal(again.value, 'canary_value');

  await brain.close();
});

test('RECOVERY: silent-empty results trip the canary, reopen, and the retry serves real data', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setState('present_key', 'present_value', 'test');

  // 2 failures: the read returns [] AND the SELECT 1 canary returns [] —
  // exactly the reproduced broken-instance signature. The guard must reopen
  // and retry rather than report false emptiness.
  brain._internal.armor.simulateFailure('silent-empty', 2);
  const got = await brain.getState('present_key');
  assert.ok(got, 'a present key must never read as absent because the instance is broken');
  assert.equal(got.value, 'present_value');

  await brain.close();
});

test('a GENUINELY empty result stays empty (canary passes, no reopen, no rows invented)', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const missing = await brain.getState('never_written');
  assert.equal(missing, null, 'true emptiness is still reported as empty');
  const none = await brain.getCaptures({ source: 'no-such-source' });
  assert.deepEqual(none, [], 'empty capture filters still return []');

  await brain.close();
});
