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

// ── elifant#6/#7: pairs — near-dup merge proposals + contradiction asks ─────
//
// components() finds strict-floor pairs that never grow past two members —
// exactly what MIN_SHELF excludes from shelving. Each surviving pair becomes
// a needs-decision capture (the Bell's producer), classified by lexical
// polarity: symmetric (both or neither side negates) -> near-dup, asymmetric
// -> contradiction. Never a silent merge, never an auto-resolved
// contradiction — the keyholder decides, sources untouched either way.

test('pairKey: order-independent, stable identity for a pair', () => {
  assert.equal(keeper.pairKey('a.md', 'b.md'), keeper.pairKey('b.md', 'a.md'));
  assert.equal(keeper.pairKey('a.md', 'b.md'), 'pair:a.md|b.md');
});

test('hasNegation / classifyPair: symmetric is near-dup, asymmetric is contradiction', () => {
  assert.equal(keeper.hasNegation('the meeting is at 3pm'), false);
  assert.equal(keeper.hasNegation("the meeting isn't at 3pm anymore"), true);
  assert.equal(keeper.hasNegation('the meeting is not at 3pm'), true);

  assert.equal(keeper.classifyPair('rent is 1850 starting next month', 'starting next month rent is 1850'), 'near-dup');
  assert.equal(keeper.classifyPair('the meeting is at 3pm', "the meeting isn't at 3pm, it moved to 4pm"), 'contradiction');
  // KNOWN MISS, documented: both sides negate -> reads as symmetric/near-dup,
  // not contradiction. Conservative direction (still reaches the keyholder).
  assert.equal(keeper.classifyPair("I don't drink coffee", "I don't drink coffee anymore, I switched to tea"), 'near-dup');
});

test('pairPrompt: describes both sides with receipts, never scolds', () => {
  const p = keeper.pairPrompt('contradiction', 'a.md', 'X is true', 'b.md', 'X is false');
  assert.match(p, /a\.md/);
  assert.match(p, /b\.md/);
  assert.match(p, /X is true/);
  assert.match(p, /X is false/);
  assert.ok(!/wrong|mistake|shouldn't/i.test(p), 'never tells the keyholder they were wrong');
});

test('elifant#6: a near-dup pair proposes a merge via the Bell — never shelved, sources untouched', async () => {
  await freshBrain();
  await brain.setMemory('pay-a.md', 'rent goes up to 1850 starting next month', 'test', 'instance', nearVec(200, 1));
  await brain.setMemory('pay-b.md', 'starting next month rent is 1850', 'test', 'instance', nearVec(200, 2));

  const receipt = await brain.keeperTick({ mind: false });
  assert.equal(receipt.shelvesWritten, 0, 'two members never reach the shelf minimum');
  assert.equal(receipt.nearDups, 1);
  assert.equal(receipt.contradictions, 0);

  const nd = await brain.getCaptures({ type: 'needs-decision' });
  assert.equal(nd.length, 1);
  assert.equal(nd[0].source, 'keeper');
  assert.equal(nd[0].data.kind, 'near-dup');
  assert.deepEqual([nd[0].data.a.filename, nd[0].data.b.filename].sort(), ['pay-a.md', 'pay-b.md']);
  assert.match(nd[0].data.prompt, /pay-a\.md/);
  assert.match(nd[0].data.prompt, /pay-b\.md/);

  // both originals recoverable — elifant#6's acceptance criterion, satisfied
  // by construction (K-CARBON-4: the pair pass only ever reads and asks).
  const rows = (await brain._internal.query(
    "SELECT filename, synthesized_via, content FROM memories WHERE filename IN ('pay-a.md','pay-b.md') ORDER BY filename"
  )).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.synthesized_via === null), 'never silently merged');
  assert.equal(rows[0].content, 'rent goes up to 1850 starting next month');
  assert.equal(rows[1].content, 'starting next month rent is 1850');
  await brain.close();
});

test('elifant#7: a contradiction pair rings the Bell with both sources cited', async () => {
  await freshBrain();
  await brain.setMemory('concert-a.md', 'the concert starts at 8pm', 'test', 'instance', nearVec(210, 1));
  await brain.setMemory('concert-b.md', 'the concert does not start at 8pm, it moved to 9pm', 'test', 'instance', nearVec(210, 2));

  const receipt = await brain.keeperTick({ mind: false });
  assert.equal(receipt.contradictions, 1);
  assert.equal(receipt.nearDups, 0);

  const nd = await brain.getCaptures({ type: 'needs-decision' });
  assert.equal(nd.length, 1);
  assert.equal(nd[0].data.kind, 'contradiction');
  assert.deepEqual([nd[0].data.a.filename, nd[0].data.b.filename].sort(), ['concert-a.md', 'concert-b.md']);
  assert.match(nd[0].data.prompt, /concert-a\.md/);
  assert.match(nd[0].data.prompt, /concert-b\.md/);
  await brain.close();
});

test('elifant#17: a crisis-lexicon pair never surfaces — not even as a question', async () => {
  await freshBrain();
  await brain.setMemory('dark-a.md', 'been thinking about suicide again lately', 'test', 'instance', nearVec(220, 1));
  await brain.setMemory('dark-b.md', 'still thinking about suicide, same as before', 'test', 'instance', nearVec(220, 2));

  const receipt = await brain.keeperTick({ mind: false });
  assert.equal(receipt.contradictions, 0);
  assert.equal(receipt.nearDups, 0);
  assert.equal((await brain.getCaptures({ type: 'needs-decision' })).length, 0,
    'the shelving override applies to pairs exactly as it does to shelves');
  await brain.close();
});

test('idempotent: an unchanged pair is asked about once, not every tick', async () => {
  await freshBrain();
  await brain.setMemory('dup-a.md', 'the wifi password is on the fridge', 'test', 'instance', nearVec(230, 1));
  await brain.setMemory('dup-b.md', 'the fridge has the wifi password on it', 'test', 'instance', nearVec(230, 2));

  const r1 = await brain.keeperTick({ mind: false });
  assert.equal(r1.nearDups, 1);
  const r2 = await brain.keeperTick({ mind: false });
  assert.equal(r2.nearDups, 0, 'unchanged pair, unchanged verdict — honest silence');
  assert.equal((await brain.getCaptures({ type: 'needs-decision' })).length, 1);
  await brain.close();
});

test('a content edit re-asks: whatever changed in between is itself worth a new question', async () => {
  await freshBrain();
  await brain.setMemory('edit-a.md', 'the wifi password is on the fridge', 'test', 'instance', nearVec(240, 1));
  await brain.setMemory('edit-b.md', 'the fridge has the wifi password on it', 'test', 'instance', nearVec(240, 2));
  const r1 = await brain.keeperTick({ mind: false });
  assert.equal(r1.nearDups, 1);

  // Content changes, vector re-supplied to stay in the same tight pair —
  // now it's a genuine disagreement, not a rephrasing.
  await brain.setMemory('edit-b.md', 'the fridge password is wrong, it was changed last week', 'test', 'instance', nearVec(240, 2));
  const r2 = await brain.keeperTick({ mind: false });
  assert.equal(r2.contradictions, 1, 'the changed content re-triggers a fresh ask, reclassified');

  const nd = await brain.getCaptures({ type: 'needs-decision' });
  assert.equal(nd.length, 2, 'both the original ask and the re-ask are on the ledger');
  assert.equal(nd[0].data.kind, 'contradiction', 'newest first');
  await brain.close();
});

test('a pair that grows into a shelf drops out of the pair ledger (no lingering duplicate ask)', async () => {
  await freshBrain();
  await brain.setMemory('grow-a.md', 'the garden needs weeding this weekend', 'test', 'instance', nearVec(250, 1));
  await brain.setMemory('grow-b.md', 'weeding the garden this weekend', 'test', 'instance', nearVec(250, 2));
  const r1 = await brain.keeperTick({ mind: false });
  assert.equal(r1.nearDups, 1, 'two members -> a pair, not a shelf');

  await brain.setMemory('grow-c.md', 'garden weeding weekend plan', 'test', 'instance', nearVec(250, 3));
  const r2 = await brain.keeperTick({ mind: false });
  assert.equal(r2.shelvesWritten, 1, 'three members -> now a real shelf');
  assert.equal(r2.nearDups, 0, 'the trio is a shelf now, not re-asked as a pair');
  assert.equal((await brain.getCaptures({ type: 'needs-decision' })).length, 1,
    'the original pair ask stands; no new one is added once it graduates to a shelf');
  await brain.close();
});

// ── 0.26.0: shelf-cohesion gate (transitive single-linkage collapse) ────────
//
// components() is single-linkage: one edge under SHELF_BIND_FLOOR fuses two
// groups with no check on whether the RESULT is coherent, so a chain of
// individually-tight edges drags dozens of unrelated memories onto one shelf.
// The gate: a component larger than SHELF_COHESION_MIN_SIZE must also clear
// SHELF_COHESION_CEILING on its whole-set mean pairwise distance, or it is
// broken into sub-groups that each clear SHELF_DECOMPOSE_CEILING on their own.

// Equal weight on axes [start .. start+W], normalized. Two of these W axes
// apart share (W+1-k) of W+1 axes, so cosine distance is exactly k/(W+1): a
// sliding window makes a genuine single-linkage chain (adjacent pairs bind,
// the endpoints are a full 1.0 apart).
function windowVec(start, W) {
  const v = new Array(DIM).fill(0);
  for (let k = 0; k <= W; k++) v[start + k] = 1;
  return normalize(v);
}

test('cohesion: an oversized incoherent chain is decomposed, never bound as one mega-shelf', async () => {
  await freshBrain();
  // 20 memories, each a 15-axis window one step along from the last: adjacent
  // distance 0.067 (binds), c00<->c19 a full 1.0 apart. Single-linkage alone
  // would put all 20 on one shelf.
  for (let i = 0; i < 20; i++) {
    await brain.setMemory(`chain-${String(i).padStart(2, '0')}.md`, `chain note number ${i} in a long thread`, 'test', 'instance', windowVec(i, 14));
  }
  const receipt = await brain.keeperTick({ mind: false });

  assert.ok(receipt.componentsDecomposed >= 1, 'the 20-member incoherent component is decomposed, not shelved whole');
  assert.equal(receipt.oversizedComponentsFlagged, 0, 'well under MAX_COHESION_COMPONENT_SIZE — evaluated, not skipped');

  const shelfRows = (await brain._internal.query(
    'SELECT filename, content, embedding::text AS vec FROM memories WHERE synthesized_via = $1 AND archived = false', [keeper.SHELVING_VIA]
  )).rows;
  assert.ok(shelfRows.length >= 2, `decomposition yields several coherent shelves, got ${shelfRows.length}`);
  for (const s of shelfRows) {
    const members = keeper.parseMembers(s.content);
    assert.ok(members.length < 20, `no single shelf carries the whole chain — ${s.filename} has ${members.length}`);
    // Per-shelf artifact check: every written shelf is itself coherent, not
    // just "smaller than the mega". Rebuild each member's vector and measure.
    const memberVecs = (await brain._internal.query(
      'SELECT filename, embedding::text AS vec FROM memories WHERE filename = ANY($1::text[])', [members]
    )).rows;
    const vm = new Map(memberVecs.map((r) => [r.filename, keeper.parseVec(r.vec)]));
    const mean = keeper.meanPairwiseCohesion(members, vm);
    assert.ok(mean <= keeper.FLOORS.SHELF_COHESION_CEILING,
      `${s.filename}: whole-shelf mean pairwise ${mean.toFixed(4)} must clear the accept ceiling ${keeper.FLOORS.SHELF_COHESION_CEILING}`);
  }
  assert.equal(receipt.undecomposableGroups, 0, 'every sub-group produced clears the ceiling — nothing dropped');
  await brain.close();
});

test('cohesion: a near-dup pair single-linkage buried inside an incoherent component is pulled back out to the Bell', async () => {
  await freshBrain();
  // A 13-member chain, plus a near-dup pair (dupA/dupB ~0.15 apart) hanging off
  // chain node c06: dupA binds to c06 (~0.27, an edge), dupB binds only to dupA
  // (~0.38 to c06, no direct edge). Single-linkage swallows the pair into the
  // 15-member component; the pair's own 2-node structure is gone from
  // components() and it can never be asked about — unless decomposition
  // recovers it.
  for (let i = 0; i < 13; i++) {
    await brain.setMemory(`c-${String(i).padStart(2, '0')}.md`, `thread note ${i}`, 'test', 'instance', windowVec(i, 14));
  }
  const c6 = windowVec(6, 9);
  const dupA = normalize(c6.map((x, idx) => (idx === 200 ? 0.936 : x)));
  const dupB = normalize(dupA.map((x, idx) => (idx === 201 ? 0.62 : x)));
  await brain.setMemory('standup-a.md', 'the standup moved to 9am on tuesdays', 'test', 'instance', dupA);
  await brain.setMemory('standup-b.md', 'on tuesdays the standup is now at 9am', 'test', 'instance', dupB);

  await brain.keeperTick({ mind: false });

  const nd = (await brain.getCaptures({ source: 'keeper', type: 'needs-decision' }));
  const key = keeper.pairKey('standup-a.md', 'standup-b.md');
  const entry = nd.find((c) => c.data && c.data.key === key);
  assert.ok(entry, `the buried pair reaches the Bell as its own ask; needs-decision keys seen: ${nd.map((c) => c.data && c.data.key).join(', ')}`);
  assert.equal(entry.data.kind, 'near-dup', 'symmetric phrasing -> near-dup, not contradiction');

  // And it is NOT also sitting inside a shelf.
  const shelfRows = (await brain._internal.query(
    'SELECT content FROM memories WHERE synthesized_via = $1 AND archived = false', [keeper.SHELVING_VIA]
  )).rows;
  for (const s of shelfRows) {
    const m = keeper.parseMembers(s.content);
    assert.ok(!(m.includes('standup-a.md') && m.includes('standup-b.md')),
      'the recovered pair is asked about, never shelved');
  }
  await brain.close();
});

test('cohesion: exceedsCohesionCap is a pure predicate, and cohesiveSubclusters is deterministic', () => {
  assert.equal(keeper.exceedsCohesionCap(13, 12), true);
  assert.equal(keeper.exceedsCohesionCap(12, 12), false);
  assert.equal(keeper.exceedsCohesionCap(600), true, 'default cap is MAX_COHESION_COMPONENT_SIZE (500)');
  assert.equal(keeper.exceedsCohesionCap(400), false);

  // A 20-node incoherent chain: decompose it twice from the same vectors, the
  // grouping must be byte-identical (every other clustering primitive in this
  // file is deliberately deterministic — this one too).
  const names = [];
  const vm = new Map();
  for (let i = 0; i < 20; i++) { const n = `n${String(i).padStart(2, '0')}.md`; names.push(n); vm.set(n, windowVec(i, 14)); }
  const shuffled = [...names].reverse();
  const a = keeper.cohesiveSubclusters(names, vm, keeper.FLOORS.SHELF_DECOMPOSE_CEILING);
  const b = keeper.cohesiveSubclusters(shuffled, vm, keeper.FLOORS.SHELF_DECOMPOSE_CEILING);
  assert.deepEqual(a, b, 'grouping is independent of input order and stable across runs');
  for (const g of a) {
    assert.ok(keeper.meanPairwiseCohesion(g, vm) <= keeper.FLOORS.SHELF_DECOMPOSE_CEILING,
      `every emitted group clears the decompose ceiling on its OWN whole mean: ${JSON.stringify(g)}`);
  }
});

test('cohesion: a large but genuinely coherent cluster is left as one shelf, not over-decomposed', async () => {
  await freshBrain();
  // 15 members, all mutually ~0.02 apart (one tight subject). Size 15 is over
  // SHELF_COHESION_MIN_SIZE (12) so the ceiling IS consulted — and it passes.
  // The gate must not punish a real cluster for being big.
  for (let i = 0; i < 15; i++) {
    await brain.setMemory(`coh-${String(i).padStart(2, '0')}.md`, `one subject, memory ${i}`, 'test', 'instance', nearVec(0, i + 1));
  }
  const receipt = await brain.keeperTick({ mind: false });
  assert.equal(receipt.componentsDecomposed, 0, 'a coherent 15-member cluster is not decomposed');
  assert.equal(receipt.shelvesWritten, 1, 'it binds as exactly one shelf');
  const shelfRows = (await brain._internal.query(
    'SELECT content FROM memories WHERE synthesized_via = $1 AND archived = false', [keeper.SHELVING_VIA]
  )).rows;
  assert.equal(shelfRows.length, 1);
  assert.equal(keeper.parseMembers(shelfRows[0].content).length, 15, 'all 15 on the one shelf');
  await brain.close();
});
