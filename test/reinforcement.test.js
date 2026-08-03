/**
 * Reinforcement — access counters + the strength leg in the fusion (elifant#8).
 *
 * Before this, searchMemories was a pure read: retrieving a memory had no effect
 * on its future retrievability, so a note that kept proving useful was no easier
 * to find on the hundredth recall than on the first. Putting a feedback loop on
 * the read path is the kind of thing that quietly poisons a ranker, so the
 * invariants under test are the ones that make it safe:
 *
 *   - a REAL recall counts, and ONLY a real recall. An unattributed query (the
 *     default) and an explicitly-internal one leave no trace, so the kernel can
 *     never reinforce its own housekeeping;
 *   - only hits that cleared the loose relevance floor are reinforced — top-k is
 *     not the same as relevant, and counting off-topic filler would teach the
 *     fusion noise;
 *   - the leg is WEIGHTED, NOT DOMINANT: it decides between equally-good matches
 *     and cannot lift a poor match over a good one (proved by geometry, not by
 *     assertion in a comment);
 *   - a pin is never made worse by it;
 *   - the counters are device-local — a YOINK does not carry your attention to
 *     someone else's bowl.
 *
 * Synthetic embeddings throughout (controlled cosine geometry, no model).
 *
 * Run with: node --test test/reinforcement.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

const DIM = 384;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-reinforce-')); }

function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}
function axisVec(axis, weight = 1.0) {
  const v = new Array(DIM).fill(0);
  v[axis] = weight;
  return v;
}
// A unit vector near axis 0, tilted toward `tilt` by eps. Cosine distance from
// the pure axis-0 query is ~eps^2/2 — so a bigger eps is a worse semantic match.
function tilted(tilt, eps) {
  const v = axisVec(0, 1.0);
  v[tilt] = eps;
  return normalize(v);
}

// Every leg of the fusion except the one under test must be a genuine TIE, or
// the test proves nothing about that leg. updated_at is second-precision, so two
// writes can straddle a second boundary and silently hand the recency leg a
// decision — flatten it explicitly.
async function flattenRecency(stamp = '2026-01-01T00:00:00Z') {
  await brain._internal.query('UPDATE memories SET updated_at = $1', [stamp]);
}

// Reinforce exactly one memory, N times, without touching any other row: the
// prefix filter narrows the result set to that one file, so it is the only hit
// the recall path can count.
async function recallOnly(filename, vec, text, times) {
  for (let i = 0; i < times; i++) {
    const hits = await brain.searchMemories({
      queryEmbedding: vec, queryText: text, k: 1, prefix: filename, recall: 'keyholder',
    });
    assert.equal(hits.length, 1, `recallOnly: expected ${filename} to be returned`);
  }
}

test('a memory recalled repeatedly outranks an equally-similar one that never has', async () => {
  // Run it BOTH ways round. With cosine, lexical and recency all tied, the
  // pre-reinforcement order is whatever the storage engine's scan happens to
  // yield — so asserting a single direction could pass by luck. Reinforcing each
  // side in turn and demanding it wins both times can only pass if the strength
  // leg is what decided.
  for (const winner of ['a-note.md', 'b-note.md']) {
    const dir = tmpDir();
    await brain.init(dir);
    const vec = normalize(axisVec(3));
    const body = 'the sourdough starter lives in the door of the fridge';
    // Identical vector => identical cosine distance. Identical text => identical
    // BM25. Same stamp => identical recency.
    await brain.setMemory('a-note.md', body, 'test', 'instance', vec);
    await brain.setMemory('b-note.md', body, 'test', 'instance', vec);
    await flattenRecency();

    await recallOnly(winner, vec, 'sourdough starter', 12);

    const hits = await brain.searchMemories({ queryEmbedding: vec, queryText: 'sourdough starter', k: 2 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].filename, winner,
      `expected the reinforced memory (${winner}) to surface first, got ${hits.map((h) => h.filename).join(', ')}`);
    await brain.close();
  }
});

test('weighted, not dominant — strength cannot lift a poor match over a good one', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  // One shared body, so BM25 ties across the whole pool and cosine + strength are
  // the only legs with anything to say.
  const body = 'notes about the harbour ferry timetable and the winter schedule';
  const q = normalize(axisVec(0));

  await brain.setMemory('best.md', body, 'test', 'instance', tilted(1, 0.05));   // cosine rank 0
  for (let i = 0; i < 8; i++) {
    await brain.setMemory(`fill-${i}.md`, body, 'test', 'instance', tilted(i + 2, 0.10 + i * 0.05));
  }
  // Two twins at the SAME (worst) cosine distance, so any gap between them at the
  // end is the strength leg and nothing else.
  await brain.setMemory('twin-a.md', body, 'test', 'instance', tilted(20, 0.60));
  await brain.setMemory('twin-b.md', body, 'test', 'instance', tilted(21, 0.60));
  await flattenRecency();

  // Which twin the storage engine happens to return first for a perfect tie is
  // arbitrary, so reinforce whichever one LOSES the un-reinforced baseline. Then
  // the control can only pass by the strength leg actually moving it — never by
  // the tie falling the convenient way.
  const before = (await brain.searchMemories({ queryEmbedding: q, queryText: 'harbour ferry timetable', k: 11 }))
    .map((h) => h.filename);
  const loser = before.indexOf('twin-a.md') < before.indexOf('twin-b.md') ? 'twin-b.md' : 'twin-a.md';
  const winner = loser === 'twin-a.md' ? 'twin-b.md' : 'twin-a.md';
  await recallOnly(loser, q, 'harbour ferry timetable', 50);

  const order = (await brain.searchMemories({ queryEmbedding: q, queryText: 'harbour ferry timetable', k: 11 }))
    .map((h) => h.filename);

  // (a) the bound: 50 recalls do not buy the way past a genuinely better match.
  assert.equal(order[0], 'best.md', `strength leg went dominant: order was ${order.join(' > ')}`);

  // (b) the positive control, in the SAME harness: reinforcement is live, and it
  // is the only reason the reinforced twin now precedes its geometric identical.
  const iLoser = order.indexOf(loser);
  const iWinner = order.indexOf(winner);
  assert.ok(iLoser >= 0 && iWinner >= 0, `both twins should be in the top-11: ${order.join(' > ')}`);
  assert.ok(iLoser < iWinner,
    `reinforcement is not reaching the fusion: ${loser} was recalled 50x and still sits behind ${winner} — ${order.join(' > ')}`);
  await brain.close();
});

test('a pin is never made worse by the strength leg', async () => {
  // A pin is the keyholder vouching by hand. The recency leg has always treated
  // pinned rows as freshest so it can only ever HELP them; the strength leg must
  // do the same, or a memory nobody pinned but everybody searched for would
  // out-score one the keyholder pinned and simply never searched for.
  //
  // The geometry matters here. With a pinned row against ONE loud row, the pin
  // survives on the recency leg alone (recencyWeight 0.5 > strengthWeight 0.25),
  // so the test would pass even with the protection removed and prove nothing. A
  // CROWD of recalled rows is what actually pushes an unreinforced pin to the
  // bottom of the strength ranking, which is where the protection earns its
  // keep. Verified by mutation: strip the pinned branch out of the strength leg
  // and this test fails.
  const dir = tmpDir();
  await brain.init(dir);
  const vec = normalize(axisVec(7));
  const body = 'the spare key is taped under the third step';

  // A dozen rivals, identical geometry, all recalled — so the crowd occupies the
  // whole top of the strength ranking.
  for (let i = 0; i < 12; i++) {
    await brain.setMemory(`rival-${i}.md`, body, 'test', 'instance', vec);
  }
  const bulk = await brain.searchMemories({ queryEmbedding: vec, queryText: 'spare key', k: 12, recall: 'keyholder' });
  assert.equal(bulk.length, 12, 'the whole crowd should have been recalled at once');

  // The pin arrives afterwards and is never recalled at all.
  await brain.setMemory('pinned.md', body, 'test', 'instance', vec);
  await brain.setMemoryPin('pinned.md', true);
  await flattenRecency();

  const hits = await brain.searchMemories({ queryEmbedding: vec, queryText: 'spare key', k: 13 });
  assert.equal(hits[0].filename, 'pinned.md',
    `a never-recalled pin was pushed below the recalled crowd: ${hits.map((h) => h.filename).join(', ')}`);
  await brain.close();
});

test('only a named real-recall origin counts — the default and internal origins leave no trace', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = normalize(axisVec(11));
  await brain.setMemory('note.md', 'kettle descaling instructions', 'test', 'instance', vec);

  // Default: unattributed. The kernel cannot tell a keyholder's question from a
  // shell's bookkeeping sweep, so it fails closed and counts nothing.
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'kettle', k: 1 });
  assert.deepEqual(await brain.getRecallCounts(), [], 'an unattributed search must not reinforce');

  // Explicitly internal: named honestly, still never counted.
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'kettle', k: 1, recall: 'housekeeping' });
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'kettle', k: 1, recall: 'keeper' });
  assert.deepEqual(await brain.getRecallCounts(), [], 'an internal query must not reinforce');

  // A real recall does count.
  await brain.searchMemories({ queryEmbedding: vec, queryText: 'kettle', k: 1, recall: 'keyholder' });
  const counts = await brain.getRecallCounts();
  assert.equal(counts.length, 1);
  assert.equal(counts[0].filename, 'note.md');
  assert.equal(counts[0].access_count, 1);

  // A typo'd origin is a programming error, not a silently-uncounted recall.
  await assert.rejects(
    brain.searchMemories({ queryEmbedding: vec, queryText: 'kettle', k: 1, recall: 'user' }),
    /unknown recall origin/i
  );
  await brain.close();
});

test('only hits that clear the loose relevance floor are reinforced', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const q = normalize(axisVec(0));
  await brain.setMemory('near.md', 'the boiler pressure gauge reads low', 'test', 'instance', tilted(1, 0.05));
  await brain.setMemory('far.md', 'unrelated filler about tram tickets', 'test', 'instance', normalize(axisVec(200)));

  const hits = await brain.searchMemories({ queryEmbedding: q, queryText: 'boiler pressure', k: 2, recall: 'keyholder' });
  assert.equal(hits.length, 2, 'both rows should be RETURNED — top-k is not a relevance judgement');
  assert.ok(hits.find((h) => h.filename === 'far.md').distance >= brain.RELEVANCE_FLOORS.loose);

  const counts = await brain.getRecallCounts();
  assert.deepEqual(counts.map((c) => c.filename), ['near.md'],
    'a returned-but-irrelevant row must not be reinforced');
  await brain.close();
});

test('access counters are device-local — a YOINK does not carry them', async () => {
  const dirA = tmpDir();
  await brain.init(dirA);
  const vec = normalize(axisVec(5));
  await brain.setMemory('travelled.md', 'the ferry leaves at quarter past', 'test', 'instance', vec);
  await recallOnly('travelled.md', vec, 'ferry', 4);
  assert.equal((await brain.getRecallCounts())[0].access_count, 4);
  const { manifest, payload } = await brain.exportBrain();
  assert.ok(!('memory_access' in manifest.table_counts), 'memory_access must not be an exported table');
  await brain.close();

  const dirB = tmpDir();
  await brain.init(dirB);
  await brain.importBrain({ payload });
  assert.ok(await brain.getMemory('travelled.md'), 'the memory itself should have travelled');
  assert.deepEqual(await brain.getRecallCounts(), [],
    'a SUMMONed soul must arrive un-reinforced — their attention is not yours');
  await brain.close();
});

test('a forward-merge rollback leaves live access counters intact', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = normalize(axisVec(9));
  await brain.setMemory('kept.md', 'the recycling goes out on thursday', 'test', 'instance', vec);
  const snap = await brain.snapshot('before reinforcement');
  await recallOnly('kept.md', vec, 'recycling thursday', 6);

  await brain.rollback(snap.snapshot_id, 'forward-merge');
  const counts = await brain.getRecallCounts();
  assert.equal(counts.length, 1);
  assert.equal(counts[0].access_count, 6, 'a forward-merge must not roll local reinforcement backward');
  await brain.close();
});

test('pruneTombstones reaps the access rows of hard-deleted memories', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = normalize(axisVec(13));
  await brain.setMemory('doomed.md', 'the old wifi password', 'test', 'instance', vec);
  await recallOnly('doomed.md', vec, 'wifi password', 3);
  assert.equal((await brain.getRecallCounts()).length, 1);

  await brain.deleteMemory('doomed.md');
  // Soft delete alone keeps the history: the row can still be resurrected.
  assert.equal((await brain.getRecallCounts()).length, 1);

  await brain.pruneTombstones({ olderThan: '2099-01-01T00:00:00Z' });
  assert.deepEqual(await brain.getRecallCounts(), [],
    'a hard-deleted memory must not leave an orphan counter behind');
  await brain.close();
});
