/**
 * The recall log — retained recall history so HEALTH can answer (elifant#10).
 *
 * health('recall-shift') used to return 'not available' with the note "recall
 * history not retained in this build": the kernel kept no record of what it had
 * recalled, so the mind could not be asked how its own attention had moved. This
 * suite holds the log to the two promises that make retaining it acceptable:
 *
 *   - health('recall-shift') gives a REAL answer, not a refusal;
 *   - the log is BOUNDED. Not "has a prune function" — bounded: it is shown to
 *     stop growing under sustained write, with a positive control proving the
 *     same harness would otherwise have kept growing.
 *
 * Plus the two properties that keep it honest: it fingerprints the query instead
 * of retaining the words, and it records only what counted as a real recall.
 *
 * Run with: node --test test/recall-log.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

const DIM = 384;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-recall-')); }
function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}
function axisVec(axis, weight = 1.0) {
  const v = new Array(DIM).fill(0);
  v[axis] = weight;
  return v;
}

async function seedOne(filename, body, axis) {
  const vec = normalize(axisVec(axis));
  await brain.setMemory(filename, body, 'test', 'instance', vec);
  return vec;
}

test("health('recall-shift') answers for real once recalls are retained", async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = await seedOne('tides.md', 'spring tides run highest around the new moon', 4);
  await seedOne('ferry.md', 'the ferry leaves at quarter past the hour', 5);

  for (let i = 0; i < 6; i++) {
    await brain.searchMemories({ queryEmbedding: vec, queryText: 'spring tides', k: 2, recall: 'keyholder' });
  }

  const report = await brain.health('recall-shift');
  assert.equal(report.question, 'recall-shift');
  const recallObs = report.observations.filter((o) => /recall/i.test(o.dimension));
  assert.ok(recallObs.length > 0, 'recall-shift must produce at least one observation');
  for (const o of recallObs) {
    assert.notEqual(o.current, 'not available', `still refusing: ${o.dimension} — ${o.note || ''}`);
  }
  assert.ok(
    !report.observations.some((o) => /not retained in this build/.test(o.note || '')),
    'the "not retained in this build" refusal must be gone'
  );
  // The volume observation must reflect the recalls we actually made.
  const vol = recallObs.find((o) => /volume/i.test(o.dimension));
  assert.ok(vol, 'expected a recall-volume observation');
  assert.equal(vol.current, 6);
  await brain.close();
});

test('the recall log is BOUNDED — it stops growing, and the control proves it would have', async () => {
  const prev = process.env.ELIFANT_RECALL_LOG_MAX;
  try {
    // ── positive control: same harness, no tight cap. Rows really are written,
    // and nothing else in the path is quietly discarding them.
    delete process.env.ELIFANT_RECALL_LOG_MAX;
    const ctlDir = tmpDir();
    await brain.init(ctlDir);
    const ctlVec = await seedOne('control.md', 'the control note about harbour dredging', 6);
    for (let i = 0; i < 40; i++) {
      await brain.searchMemories({ queryEmbedding: ctlVec, queryText: `dredging ${i}`, k: 1, recall: 'keyholder' });
    }
    const ctlRows = await brain.getRecallLog({ limit: 10000 });
    assert.equal(ctlRows.length, 40, 'control: an uncapped log grows one row per counted recall');
    await brain.close();

    // ── the bound itself.
    process.env.ELIFANT_RECALL_LOG_MAX = '20';
    const dir = tmpDir();
    await brain.init(dir);
    const vec = await seedOne('bounded.md', 'the note that gets recalled far too often', 7);
    for (let i = 0; i < 120; i++) {
      await brain.searchMemories({ queryEmbedding: vec, queryText: `question ${i}`, k: 1, recall: 'keyholder' });
    }
    const rows = await brain.getRecallLog({ limit: 10000 });
    const ceiling = brain.recallLogCeiling();
    assert.ok(rows.length <= ceiling,
      `log grew past its ceiling: ${rows.length} rows > ${ceiling}`);
    assert.ok(rows.length >= 10,
      `the bound must not be achieved by writing nothing: only ${rows.length} rows`);

    // Bounded from the OLD end, never the new one: the last thing recalled is
    // always still in the log. Every question above was distinct, so two repeats
    // of one marker query are identifiable as the two newest rows.
    for (let i = 0; i < 2; i++) {
      await brain.searchMemories({ queryEmbedding: vec, queryText: 'the very last question', k: 1, recall: 'keyholder' });
    }
    const after = await brain.getRecallLog({ limit: 10000 });
    assert.ok(after.length <= ceiling, `log grew past its ceiling after more writes: ${after.length} > ${ceiling}`);
    assert.equal(after[0].query_fp, after[1].query_fp, 'the two newest rows should be the marker query');
    assert.notEqual(after[0].query_fp, after[2].query_fp, 'older rows should be a different question');
    await brain.close();
  } finally {
    if (prev === undefined) delete process.env.ELIFANT_RECALL_LOG_MAX;
    else process.env.ELIFANT_RECALL_LOG_MAX = prev;
  }
});

test('the log fingerprints the query — it never retains the words', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = await seedOne('secret.md', 'a note about the marmalade recipe', 8);

  await brain.searchMemories({ queryEmbedding: vec, queryText: 'purple elephant marmalade', k: 1, recall: 'keyholder' });
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'marmalade elephant purple', k: 1, recall: 'keyholder' });
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'something else entirely', k: 1, recall: 'keyholder' });

  const rows = await brain.getRecallLog({ limit: 100 });
  assert.equal(rows.length, 3);
  const blob = JSON.stringify(rows).toLowerCase();
  for (const word of ['purple', 'elephant', 'marmalade', 'entirely']) {
    assert.ok(!blob.includes(word), `the raw query word "${word}" leaked into the recall log`);
  }
  // Same question, however it was worded, is the same fingerprint; a different
  // question is a different one. That is the whole point of keeping it.
  // The log reads newest-first, so row 0 is the third search.
  const fps = rows.map((r) => r.query_fp);
  assert.equal(fps[2], fps[1], 'the same query terms must fingerprint identically whatever their order');
  assert.notEqual(fps[0], fps[1], 'a different query must fingerprint differently');
  await brain.close();
});

test('an uncounted origin leaves no trace in the log', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = await seedOne('quiet.md', 'a note nobody is really asking for', 9);

  await brain.searchMemories({ queryEmbedding: vec, queryText: 'quiet', k: 1 });                            // unattributed
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'quiet', k: 1, recall: 'housekeeping' });
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'quiet', k: 1, recall: 'keeper' });
  assert.deepEqual(await brain.getRecallLog({ limit: 100 }), [],
    "a query that is not a recall did not happen, as far as the mind's own history is concerned");

  await brain.searchMemories({ queryEmbedding: vec, queryText: 'quiet', k: 1, recall: 'inject' });
  assert.equal((await brain.getRecallLog({ limit: 100 })).length, 1);
  await brain.close();
});

test('pruneRecallLog needs an explicit bound, and prunes by time or by count', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = await seedOne('prunable.md', 'a note in a log that will be pruned', 10);
  for (let i = 0; i < 8; i++) {
    await brain.searchMemories({ queryEmbedding: vec, queryText: `q${i}`, k: 1, recall: 'keyholder' });
  }
  assert.equal((await brain.getRecallLog({ limit: 100 })).length, 8);

  await assert.rejects(() => brain.pruneRecallLog(), /olderThan.*keep|keep.*olderThan/i);

  const byCount = await brain.pruneRecallLog({ keep: 3 });
  assert.equal(byCount, 5);
  assert.equal((await brain.getRecallLog({ limit: 100 })).length, 3);

  const byTime = await brain.pruneRecallLog({ olderThan: '2099-01-01T00:00:00Z' });
  assert.equal(byTime, 3);
  assert.deepEqual(await brain.getRecallLog({ limit: 100 }), []);
  await brain.close();
});

test('the recall log is device-local — it is not exported and it is not merged in', async () => {
  const dirA = tmpDir();
  await brain.init(dirA);
  const vec = await seedOne('local.md', 'a note recalled on this device only', 12);
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'this device', k: 1, recall: 'keyholder' });
  assert.equal((await brain.getRecallLog({ limit: 10 })).length, 1);
  const { manifest, payload } = await brain.exportBrain();
  assert.ok(!('recall_log' in manifest.table_counts), 'recall_log must not be an exported table');
  await brain.close();

  const dirB = tmpDir();
  await brain.init(dirB);
  await brain.importBrain({ payload });
  assert.ok(await brain.getMemory('local.md'), 'the memory itself should have travelled');
  assert.deepEqual(await brain.getRecallLog({ limit: 10 }), [],
    "another keyholder's attention history must not arrive with their soul");
  await brain.close();
});

test('the log records what surfaced — filenames and distances, per recall', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = await seedOne('hit-a.md', 'the first note about lighthouse keepers', 14);
  await seedOne('hit-b.md', 'the second note about lighthouse keepers', 15);

  await brain.searchMemories({ queryEmbedding: vec, queryText: 'lighthouse keepers', k: 2, recall: 'inject' });
  const rows = await brain.getRecallLog({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, 'inject');
  assert.equal(rows[0].hit_count, 2, 'both rows were returned');
  assert.equal(rows[0].counted_count, 1, 'only the relevant one counted as recalled');
  assert.ok(Array.isArray(rows[0].hits));
  assert.equal(rows[0].hits[0].f, 'hit-a.md');
  assert.equal(typeof rows[0].hits[0].d, 'number');
  assert.ok(typeof rows[0].top_distance === 'number' && rows[0].top_distance < 0.01);
  await brain.close();
});
