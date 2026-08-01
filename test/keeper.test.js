/**
 * The Keeper — first tick (elifant#1/#2/#3).
 *
 * Everything here runs on synthetic embeddings (controlled cosine geometry,
 * no model — the noticing never touches one). The invariants under test are
 * the ones that make the Keeper safe to let loose inside a hardened kernel:
 *
 *   - sources are never modified: no content, tier, or causal-history change,
 *     only the neighbours_at bookkeeping column;
 *   - shelves are NEW rows, explicitly tier-2-synthesized with a named
 *     producer — nothing is silently merged or promoted (K-CARBON-4);
 *   - re-running is a no-op (idempotent by construction);
 *   - progress is per-row and durable (the queue IS the watermark);
 *   - thoughts land in the exact shape the bowl's ticker polls;
 *   - only the keyholder's own words (tier-1) are ever shelved.
 *
 * Run with: node --test test/keeper.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');
const keeper = require('../src/keeper.js');

const DIM = 384;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-')); }

function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}
function axisVec(axis, weight = 1.0) {
  const v = new Array(DIM).fill(0);
  v[axis] = weight;
  return v;
}
// A vector near axis `axis`, tilted toward axis `tilt` by `eps`. Cosine
// distance from the pure axis vector is ~eps^2/2 — well under every floor.
function nearVec(axis, tilt, eps = 0.15) {
  const v = axisVec(axis, 1.0);
  v[tilt] = eps;
  return normalize(v);
}

async function freshBrain() {
  const dir = tmpDir();
  await brain.init(dir);
  return dir;
}

// Three garden-ish memories clustered on axis 0 (pairwise distance ~0.01-0.02,
// far under the 0.33 shelf floor) + one loner on axis 50 (distance ~1.0).
async function seedCluster() {
  await brain.setMemory('garden-tomatoes.md', 'the garden tomatoes are ripening early this year', 'test', 'instance', nearVec(0, 1));
  await brain.setMemory('garden-compost.md', 'turned the garden compost, needs two more weeks', 'test', 'instance', nearVec(0, 2));
  await brain.setMemory('garden-fence.md', 'the garden fence post by the gate is rotting', 'test', 'instance', nearVec(0, 3));
  await brain.setMemory('loner-tax.md', 'the accountant moved the filing deadline', 'test', 'instance', normalize(axisVec(50)));
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('components: union-find groups strict edges deterministically', () => {
  const comps = keeper.components([
    { a: 'b.md', b: 'c.md' }, { a: 'a.md', b: 'b.md' }, { a: 'x.md', b: 'y.md' },
  ]);
  assert.deepEqual(comps, [['a.md', 'b.md', 'c.md'], ['x.md', 'y.md']]);
});

test('commonThread: shared meaningful tokens, stopwords out, honest empty', () => {
  const thread = keeper.commonThread([
    'the garden tomatoes are ripening', 'turned the garden compost pile', 'garden fence post is rotting',
  ]);
  assert.ok(thread.includes('garden'), `expected garden in ${thread}`);
  assert.ok(!thread.includes('the'), 'stopwords never become a thread');
  assert.deepEqual(keeper.commonThread(['alpha one', 'beta two', 'gamma three']), [],
    'no shared tokens -> empty thread, not an invented subject');
});

test('commonThread: corpus-wide boilerplate never names a shelf', () => {
  // The first real corpus taught this one: every browser capture shares the
  // template's own words ("captured automatically…"), which therefore have
  // perfect within-cluster frequency — and perfect frequency everywhere else,
  // which is exactly why they cannot be a subject.
  const wrap = (s) => `captured automatically from chat. ${s}`;
  const cluster = [wrap('the garden tomatoes ripen'), wrap('garden compost pile turned'), wrap('garden fence rotting')];
  const outside = [wrap('dentist appointment moved'), wrap('passport renewal due'), wrap('quarterly report draft')];
  const thread = keeper.commonThread(cluster, outside);
  assert.ok(thread.includes('garden'), `garden must win, got ${thread}`);
  assert.ok(!thread.includes('captured') && !thread.includes('automatically') && !thread.includes('chat'),
    `template words must lose to the distinctive subject, got ${thread}`);
});

test('renderShelf/parseMembers round-trip', () => {
  const content = keeper.renderShelf(
    [{ filename: 'a.md', day: '2026-07-01' }, { filename: 'b.md', day: '2026-07-02' }, { filename: 'c.md', day: '2026-07-03' }],
    ['garden']
  );
  assert.deepEqual(keeper.parseMembers(content), ['a.md', 'b.md', 'c.md']);
  assert.match(content, /3 memories/);
  assert.match(content, /common thread: garden/);
});

test('meanVector: normalized mean; dimension disagreement yields null', () => {
  const m = keeper.meanVector([[1, 0], [0, 1]]);
  assert.ok(Math.abs(m[0] - Math.SQRT1_2) < 1e-9);
  assert.equal(keeper.meanVector([[1, 0], [0, 1, 0]]), null);
});

test('matchClusters: a grown cluster keeps its shelf; strangers do not claim it', () => {
  const { clusterMatched } = keeper.matchClusters(
    [['a.md', 'b.md', 'c.md', 'd.md'], ['x.md', 'y.md', 'z.md']],
    [{ filename: 'shelf/a.md', members: ['a.md', 'b.md', 'c.md'] }]
  );
  assert.equal(clusterMatched.get(0), 'shelf/a.md');
  assert.equal(clusterMatched.get(1), undefined);
});

// ── the tick ────────────────────────────────────────────────────────────────

test('first tick: edges land, a shelf is born tier-2 with receipts, the ticker feed lights', async () => {
  await freshBrain();
  await seedCluster();

  const before = await brain.keeperStatus();
  assert.equal(before.queue, 4, 'all four memories start in the neighbour queue');

  const receipt = await brain.keeperTick();
  assert.equal(receipt.processed, 4);
  assert.equal(receipt.shelvesWritten, 1, 'one cluster of three -> one shelf');
  assert.equal(receipt.snapshotTaken, true, 'first pass ever snapshots first (integrity before cleverness)');

  // The shelf row: derived, marked, receipted — never the tier-1 default.
  const shelfRow = (await brain._internal.query(
    "SELECT filename, content, trust_tier, synthesized_via, archived FROM memories WHERE synthesized_via IS NOT NULL"
  )).rows;
  assert.equal(shelfRow.length, 1);
  assert.equal(shelfRow[0].trust_tier, 'tier-2-synthesized');
  assert.equal(shelfRow[0].synthesized_via, keeper.SHELVING_VIA);
  const members = keeper.parseMembers(shelfRow[0].content);
  assert.deepEqual(members.sort(), ['garden-compost.md', 'garden-fence.md', 'garden-tomatoes.md']);
  assert.ok(!members.includes('loner-tax.md'), 'the loner is not swept onto the shelf');

  // Edges: the cluster is mutually linked; the loner has none under the floor.
  const edges = (await brain._internal.query('SELECT a_filename, b_filename, distance FROM memory_edges')).rows;
  assert.ok(edges.length >= 3, `cluster of 3 needs >= 3 edges, got ${edges.length}`);
  assert.ok(edges.every((e) => !e.a_filename.includes('loner') && !e.b_filename.includes('loner')));
  assert.ok(edges.every((e) => e.a_filename < e.b_filename), 'edges are canonical (a < b)');

  // The thought: exactly the shape bubbles.js thoughtsFeed() reads
  // (source:'thought', data.thought a non-empty string), with the receipt.
  const thoughts = await brain.getCaptures({ source: 'thought' });
  assert.equal(thoughts.length, 1, 'one shelf -> one thought (corpus of 4 is under the first-light minimum)');
  const t = thoughts[0];
  assert.equal(t.type, 'shelf');
  assert.ok(typeof t.data.thought === 'string' && t.data.thought.length > 0);
  assert.match(t.data.thought, /3 of your memories/);
  assert.match(t.data.thought, /garden/, 'the deterministic common thread names the shelf');
  assert.equal(t.data.lens, 'connect');
  assert.deepEqual([...t.data.considered].sort(), ['garden-compost.md', 'garden-fence.md', 'garden-tomatoes.md']);

  const after = await brain.keeperStatus();
  assert.equal(after.queue, 0, 'queue drained');
  assert.equal(after.shelves, 1);
  assert.ok(after.lastTick && after.lastTick.processed === 4, 'liveness receipt recorded');
  await brain.close();
});

test('sources are never touched: content, tier, and causal history unchanged', async () => {
  await freshBrain();
  await seedCluster();
  const pick = () => brain._internal.query(
    "SELECT filename, content_hash, version_vector, trust_tier, content FROM memories WHERE synthesized_via IS NULL ORDER BY filename");
  const before = (await pick()).rows;
  await brain.keeperTick();
  const after = (await pick()).rows;
  assert.deepEqual(after, before, 'the pass may add edges + bookkeeping, never rewrite a source row');
  await brain.close();
});

test('idempotent: a second tick writes nothing and says nothing', async () => {
  await freshBrain();
  await seedCluster();
  await brain.keeperTick();
  const shelfBefore = (await brain._internal.query('SELECT content, version_vector FROM memories WHERE synthesized_via IS NOT NULL')).rows[0];

  const again = await brain.keeperTick();
  assert.equal(again.processed, 0);
  assert.equal(again.shelvesWritten, 0);
  assert.equal(again.thoughts, 0, 'honest silence — nothing changed, nothing said');
  assert.equal(again.snapshotTaken, false, 'small pass with a guard snapshot on record — no re-snapshot');

  const shelfAfter = (await brain._internal.query('SELECT content, version_vector FROM memories WHERE synthesized_via IS NOT NULL')).rows[0];
  assert.deepEqual(shelfAfter, shelfBefore, 'identical membership -> byte-identical shelf, no causal bump');
  assert.equal((await brain.getCaptures({ source: 'thought' })).length, 1);
  await brain.close();
});

test('growth: a new member joins the same shelf and is announced once, by name', async () => {
  await freshBrain();
  await seedCluster();
  await brain.keeperTick();

  await brain.setMemory('garden-seeds.md', 'ordered garden seeds for the spring beds', 'test', 'instance', nearVec(0, 4));
  const receipt = await brain.keeperTick();
  assert.equal(receipt.processed, 1, 'only the newcomer is processed — O(new), not O(history)');
  assert.equal(receipt.shelvesWritten, 1);

  const shelves = (await brain._internal.query('SELECT filename, content FROM memories WHERE synthesized_via IS NOT NULL AND archived = false')).rows;
  assert.equal(shelves.length, 1, 'the shelf grew — no second shelf');
  assert.equal(keeper.parseMembers(shelves[0].content).length, 4);

  const thoughts = await brain.getCaptures({ source: 'thought' });
  assert.equal(thoughts.length, 2);
  const grow = thoughts[0]; // newest first
  assert.match(grow.data.thought, /grew/);
  assert.deepEqual(grow.data.considered, ['garden-seeds.md'], 'the announcement names only who joined');
  await brain.close();
});

test('a content edit re-queues the row through the embed-then-neighbours pipeline', async () => {
  await freshBrain();
  await seedCluster();
  await brain.keeperTick();

  // Edit without a vector: stale embedding AND stale neighbours drop together.
  await brain.setMemory('garden-fence.md', 'completely different topic now: the piano recital');
  let status = await brain.keeperStatus();
  assert.equal(status.queue, 0, 'no embedding yet -> not in the NEIGHBOUR queue (embed comes first)');
  assert.equal((await brain.getMemoriesNeedingEmbedding(10)).length, 1);

  // Backfill embeds it far from the garden — now the Keeper meets it again.
  await brain.setMemoryEmbedding('garden-fence.md', normalize(axisVec(80)));
  status = await brain.keeperStatus();
  assert.equal(status.queue, 1);

  const receipt = await brain.keeperTick();
  assert.equal(receipt.processed, 1);
  // With the edited row gone the cluster is down to two — below the shelf
  // minimum — so the shelf is archived, not kept as a pair (pairs are
  // near-dup territory, elifant#6).
  assert.equal(receipt.shelvesArchived, 1);
  const live = (await brain._internal.query('SELECT content FROM memories WHERE synthesized_via IS NOT NULL AND archived = false')).rows;
  assert.equal(live.length, 0, 'no live shelf survives a two-member remnant');
  await brain.close();
});

test('dissolve: a shelf whose cluster shrinks below three is archived, never deleted', async () => {
  await freshBrain();
  await seedCluster();
  await brain.keeperTick();
  const thoughtsBefore = (await brain.getCaptures({ source: 'thought' })).length;

  await brain.deleteMemory('garden-fence.md');
  const receipt = await brain.keeperTick();
  assert.equal(receipt.shelvesArchived, 1);

  const shelf = (await brain._internal.query('SELECT archived, deleted_at, content FROM memories WHERE synthesized_via IS NOT NULL')).rows[0];
  assert.equal(shelf.archived, true, 'archived — reversible');
  assert.equal(shelf.deleted_at, null, 'never deleted');
  assert.ok(keeper.parseMembers(shelf.content).length === 3, 'the receipt still names everything it once held');
  assert.equal((await brain.getCaptures({ source: 'thought' })).length, thoughtsBefore,
    'a shrink is visible on the shelf, not narrated — describe, never dramatize');
  await brain.close();
});

test('first light: a loner in a big-enough library is noticed once, with the nearest miss as receipt', async () => {
  await freshBrain();
  // Eight-memory corpus: two clusters of three + two moderates. Process them first.
  for (let i = 0; i < 3; i++) await brain.setMemory(`ga-${i}.md`, `garden note ${i} about the garden beds`, 'test', 'instance', nearVec(0, i + 1));
  for (let i = 0; i < 3; i++) await brain.setMemory(`work-${i}.md`, `work note ${i} about the quarterly report`, 'test', 'instance', nearVec(10, 11 + i));
  await brain.setMemory('misc-a.md', 'the dentist moved the appointment', 'test', 'instance', normalize(axisVec(60)));
  await brain.setMemory('misc-b.md', 'remember to renew the passport', 'test', 'instance', normalize(axisVec(70)));
  await brain.keeperTick();
  const base = (await brain.getCaptures({ source: 'thought', type: 'first-light' })).length;

  await brain.setMemory('brand-new-territory.md', 'started learning the cello', 'test', 'instance', normalize(axisVec(100)));
  const receipt = await brain.keeperTick();
  assert.equal(receipt.firstLights, 1);

  const fl = (await brain.getCaptures({ source: 'thought', type: 'first-light' }));
  assert.equal(fl.length, base + 1);
  assert.equal(fl[0].data.lens, 'notice');
  assert.deepEqual(fl[0].data.considered, ['brand-new-territory.md']);
  assert.equal(fl[0].data.released.length, 1, 'the nearest miss is the receipt');
  assert.ok(fl[0].data.released[0].distance >= keeper.FLOORS.EDGE_KEEP_FLOOR);

  // Once: re-ticking does not re-notice (the queue is the once-guard).
  const again = await brain.keeperTick();
  assert.equal(again.firstLights, 0);
  await brain.close();
});

test('below the corpus minimum, everything would be new territory — so nothing is said', async () => {
  await freshBrain();
  await seedCluster(); // corpus of 4 < FIRST_LIGHT_MIN_CORPUS
  const receipt = await brain.keeperTick();
  assert.equal(receipt.firstLights, 0, 'a tiny library stays quiet about novelty');
  await brain.close();
});

test('tier discipline: observed-external rows are never shelved, never linked', async () => {
  await freshBrain();
  await seedCluster();
  // A foreign observation sitting right in the middle of the garden cluster.
  await brain.setMemory('foreign-garden.md', 'their garden claim', 'test', 'instance', nearVec(0, 5));
  await brain._internal.query("UPDATE memories SET trust_tier = 'tier-3-observed-external' WHERE filename = 'foreign-garden.md'");

  await brain.keeperTick();
  const edges = (await brain._internal.query('SELECT a_filename, b_filename FROM memory_edges')).rows;
  assert.ok(edges.every((e) => e.a_filename !== 'foreign-garden.md' && e.b_filename !== 'foreign-garden.md'),
    'tier-3 never enters the graph');
  const shelf = (await brain._internal.query('SELECT content FROM memories WHERE synthesized_via IS NOT NULL')).rows[0];
  assert.ok(!keeper.parseMembers(shelf.content).includes('foreign-garden.md'),
    'someone else\'s claim never blends into a synthesized row');
  const status = await brain.keeperStatus();
  assert.equal(status.queue, 0, 'the tier-3 row does not clog the queue either');
  await brain.close();
});

test('shelves are not re-shelved (no shelves-of-shelves)', async () => {
  await freshBrain();
  await seedCluster();
  await brain.keeperTick();
  const status = await brain.keeperStatus();
  assert.equal(status.queue, 0, 'the shelf row itself never enters the neighbour queue');
  const receipt = await brain.keeperTick();
  assert.equal(receipt.shelvesWritten, 0);
  assert.equal((await brain._internal.query('SELECT count(*)::int AS n FROM memories WHERE synthesized_via IS NOT NULL')).rows[0].n, 1);
  await brain.close();
});

// ── elifant#12: snapshot-before-bulk guard ordering ─────────────────────────
//
// The original guard checked the 24h throttle BEFORE the bulk-size check, so a
// bulk pass within a day of ANY snapshot ran with no safety net regardless of
// size; the edge prune ran before the guard entirely; and an empty queue
// skipped the guard even though the same tick still writes. The tests below
// exercise the real throttle-vs-bulk interaction (the old 'snapshot throttled'
// assertion rode a tick with processed:0, where _maybeSnapshot was never even
// called) — each was verified to FAIL against the pre-fix keeper.js.

test('#12: a bulk pass snapshots even when a snapshot is on recent record — size beats throttle', async () => {
  await freshBrain();
  // Pass 1: tiny — takes the first-ever guard snapshot, putting a snapshot
  // minutes old on record.
  await brain.setMemory('seed-0.md', 'first light seed note', 'test', 'instance', normalize(axisVec(120)));
  const r1 = await brain.keeperTick({ mind: false });
  assert.equal(r1.snapshotTaken, true, 'first pass ever snapshots');

  // Pass 2: genuinely bulk — 14 queued rows plan 14*8+3 = 115 writes, over the
  // 100-row kernel-ethic #11 threshold — moments after that snapshot. The old
  // guard read the throttle first and skipped.
  for (let i = 0; i < 14; i++) {
    await brain.setMemory(`bulk-${i}.md`, `bulk backlog note ${i}`, 'test', 'instance', normalize(axisVec(130 + i)));
  }
  const r2 = await brain.keeperTick({ mind: false });
  assert.equal(r2.processed, 14);
  assert.equal(r2.snapshotTaken, true, 'a bulk pass MUST snapshot first — no throttle waives kernel-ethic #11');
  const snaps = await brain.listSnapshots({ trigger: 'keeper' });
  assert.equal(snaps.length, 2, 'both guard snapshots are on the ledger');
  await brain.close();
});

test('#12: an unbounded edge prune is guarded even when the neighbour queue is empty', async () => {
  await freshBrain();
  // A drained brain with a guard snapshot on record.
  await brain.setMemory('p-0.md', 'prune guard seed note', 'test', 'instance', normalize(axisVec(100)));
  await brain.keeperTick({ mind: false });

  // 120 edges (> BULK_SNAPSHOT_ROWS) whose endpoints are about to die.
  // Inserted directly — the DELETE volume is what matters, not graph realism.
  const files = [];
  for (let i = 0; i < 16; i++) files.push(`dead-${i}.md`);
  for (const f of files) await brain.setMemory(f, `edge endpoint ${f}`, 'test', 'instance', normalize(axisVec(200)));
  const now = new Date().toISOString();
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      await brain._internal.query(
        'INSERT INTO memory_edges (a_filename, b_filename, distance, computed_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [files[i], files[j], 0.05, now]
      );
    }
  }
  for (const f of files) await brain.deleteMemory(f);

  const r = await brain.keeperTick({ mind: false });
  assert.equal(r.processed, 0, 'nothing queued — the old guard would never have run at all');
  assert.equal(r.prunedEdges, 120, 'the prune itself still happens');
  assert.equal(r.snapshotTaken, true, '>100 planned deletes is a bulk pass — the guard covers the prune');
  await brain.close();
});

test('#12: a small pass with a snapshot on record skips — decided by a guard that actually ran', async () => {
  await freshBrain();
  await seedCluster();
  await brain.keeperTick({ mind: false }); // first-ever guard snapshot
  await brain.setMemory('garden-late.md', 'one more garden note about the beds', 'test', 'instance', nearVec(0, 6));
  const r = await brain.keeperTick({ mind: false });
  assert.equal(r.processed, 1, 'a REAL pass (processed > 0), not the processed:0 default the old test rode');
  assert.equal(r.snapshotTaken, false, '1 queued row plans 11 writes — small pass, snapshot on record, skip');
  assert.equal((await brain.listSnapshots({ trigger: 'keeper' })).length, 1);
  await brain.close();
});

test('#12 acceptance: the guard snapshot is a real way back — rollback restores the pre-pass store', async () => {
  await freshBrain();
  for (let i = 0; i < 14; i++) {
    await brain.setMemory(`roll-${i}.md`, `garden variety note ${i} about the garden`, 'test', 'instance', nearVec(0, i + 1));
  }
  const r = await brain.keeperTick({ mind: false });
  assert.equal(r.snapshotTaken, true, 'bulk pass — guard snapshot taken before any write');
  assert.equal(r.processed, 14);
  assert.ok(r.shelvesWritten >= 1, 'the pass really wrote (edges + a shelf + watermarks)');

  // Roll back to the guard snapshot: the store must return to its pre-pass shape.
  const snap = (await brain.listSnapshots({ trigger: 'keeper' }))[0];
  await brain.rollback(snap.snapshot_id, 'replace', { confirm: true });
  const st = await brain.keeperStatus();
  assert.equal(st.queue, 14, 'watermarks rolled back — the whole queue is owed again');
  assert.equal(st.edges, 0, 'edge writes rolled back');
  assert.equal(st.shelves, 0, 'shelf writes rolled back');

  // And the pass simply runs again — nothing lost, nothing doubled.
  const again = await brain.keeperTick({ mind: false });
  assert.equal(again.processed, 14);
  assert.equal((await brain.keeperStatus()).queue, 0);
  assert.equal((await brain._internal.query(
    "SELECT count(*)::int AS n FROM memories WHERE synthesized_via IS NOT NULL AND archived = false")).rows[0].n, 1,
    'one shelf again — the redo converges to the same library');
  await brain.close();
});

test('durability: a kill between rows loses no work and redoes none already done', async () => {
  await freshBrain();
  await seedCluster();
  // Simulate the partial pass: batch of 2 processes the two oldest rows only.
  const partial = await brain.keeperTick({ batch: 2 });
  assert.equal(partial.processed, 2);
  const q1 = await brain.keeperStatus();
  assert.equal(q1.queue, 2, 'per-row progress is durable — half the queue is done');

  // "Restart": the next tick picks up exactly the remainder.
  const rest = await brain.keeperTick();
  assert.equal(rest.processed, 2, 'no redo, no skip');
  assert.equal((await brain.keeperStatus()).queue, 0);
  await brain.close();
});
