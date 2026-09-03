/**
 * SHELF_BIND_FLOOR vs SHELF_EDGE_FLOOR/NEAR_DUP_FLOOR — the split (2026-08-11).
 *
 * Until this split, shelf-binding shared its one number (0.12) with same-fact
 * duplicate detection. Measured against the real int8 nomic embedder that
 * number binds ZERO genuinely-related-distinct memory pairs — a shelf could
 * only ever form from near-duplicates, so the Keeper's connect lens was
 * structurally dead on real content. SHELF_BIND_FLOOR (0.28) is the shelf-
 * binding threshold now; SHELF_EDGE_FLOOR/NEAR_DUP_FLOOR (0.12) stays pinned
 * to same-fact territory and must not follow it.
 *
 * Exact-geometry vectors (the plan's own formula), no embedder: for a unit
 * vector on axis A tilted toward axis B by angle theta,
 *   v = cos(theta)*e_A + sin(theta)*e_B
 * gives cosine distance from e_A of EXACTLY 1-cos(theta) (already unit norm,
 * since cos^2+sin^2=1). Two such vectors sharing axis A but tilted toward
 * DIFFERENT orthogonal axes B/C are each exactly 1-cos(theta) from e_A, and
 * 1-cos(theta)^2 from each other — a "star" through the shared hub, which is
 * enough for union-find to bind them into one component via the hub without
 * needing the two satellites to be mutually close.
 *
 * Run with: node --test test/shelf-bind-floor.test.js
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

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-floor-')); }
async function freshBrain() {
  const dir = tmpDir();
  await brain.init(dir);
  return dir;
}
function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}
function axisVec(axis, weight = 1.0) {
  const v = new Array(DIM).fill(0);
  v[axis] = weight;
  return v;
}
// v = cos(theta)*e_hubAxis + sin(theta)*e_tiltAxis. distance(v, e_hubAxis) == 1-cosTheta, exact.
function starVec(hubAxis, tiltAxis, cosTheta) {
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const v = axisVec(hubAxis, cosTheta);
  v[tiltAxis] = sinTheta;
  return v;   // already unit norm by construction (cos^2+sin^2=1)
}

test('a trio at ~0.25 apart shelves under SHELF_BIND_FLOOR (0.28) — SHELF_EDGE_FLOOR (0.12) alone would have missed it', async () => {
  await freshBrain();
  const hub = axisVec(0, 1);                    // the shared hub vector itself
  const cosTheta = 0.75;                          // 1 - cosTheta = 0.25
  const satelliteB = starVec(0, 1, cosTheta);     // distance from hub: exactly 0.25
  const satelliteC = starVec(0, 2, cosTheta);     // distance from hub: exactly 0.25

  await brain.setMemory('related-a.md', 'the mrmags CI pipeline runs on the self-hosted GitLab', 'test', 'instance', hub);
  await brain.setMemory('related-b.md', 'GitLab CI publishes the tagged release to the CDN', 'test', 'instance', satelliteB);
  await brain.setMemory('related-c.md', 'the release pipeline gates on the substrate audit script', 'test', 'instance', satelliteC);

  const receipt = await brain.keeperTick();
  assert.equal(receipt.shelvesWritten, 1,
    'a genuinely-related-distinct trio at ~0.25 must shelve — this is exactly the case SHELF_EDGE_FLOOR (0.12) could never reach');

  const shelfRow = (await brain._internal.query(
    "SELECT filename, content FROM memories WHERE synthesized_via = $1", [keeper.SHELVING_VIA]
  )).rows;
  assert.equal(shelfRow.length, 1);
  const members = keeper.parseMembers(shelfRow[0].content);
  assert.deepEqual(members.sort(), ['related-a.md', 'related-b.md', 'related-c.md']);
  await brain.close();
});

test('a trio at ~0.45 apart never shelves (positive control: the harness distinguishes shelve from no-shelve)', async () => {
  await freshBrain();
  const hub = axisVec(10, 1);
  const cosTheta = 0.55;                          // 1 - cosTheta = 0.45
  const satelliteB = starVec(10, 11, cosTheta);
  const satelliteC = starVec(10, 12, cosTheta);

  await brain.setMemory('far-a.md', 'the espresso machine needs descaling', 'test', 'instance', hub);
  await brain.setMemory('far-b.md', 'the neighbour’s fence blew over in the storm', 'test', 'instance', satelliteB);
  await brain.setMemory('far-c.md', 'renewed the passport at the county office', 'test', 'instance', satelliteC);

  const receipt = await brain.keeperTick();
  assert.equal(receipt.shelvesWritten, 0, 'pairwise ~0.45 is past EDGE_KEEP_FLOOR (0.40) itself — no edge is even stored, let alone a shelf');

  const shelfRows = (await brain._internal.query(
    "SELECT filename FROM memories WHERE synthesized_via = $1", [keeper.SHELVING_VIA]
  )).rows;
  assert.equal(shelfRows.length, 0);
  await brain.close();
});

test('a pair at ~0.05 still reinforces via the capture-time near-dup guard — NEAR_DUP_FLOOR (0.12) pin survived the split', async () => {
  await freshBrain();
  const cosTheta = 0.95;                          // 1 - cosTheta = 0.05, well under 0.12

  // Mirrors the real production write shape: setMemory WITHOUT an embedding,
  // then setMemoryEmbedding separately (setMemory's own synchronous-embedding
  // branch deliberately never reaches the guard — see index.js's comment on
  // that branch; only setMemoryEmbedding does, which is what every real save
  // goes through via the fire-and-forget embed-after-save path).
  await brain.setMemory('rent-original.md', 'the rent goes up to 1850 starting next month', 'test', 'instance');
  await brain.setMemoryEmbedding('rent-original.md', axisVec(20, 1));

  await brain.setMemory('rent-paraphrase.md', 'starting next month the rent is 1850', 'test', 'instance');
  await brain.setMemoryEmbedding('rent-paraphrase.md', starVec(20, 21, cosTheta));

  const counts = await brain.getRecallCounts();
  const original = counts.find((c) => c.filename === 'rent-original.md');
  assert.ok(original, `expected rent-original.md to be reinforced; recall counts: ${JSON.stringify(counts)}`);
  assert.ok(original.access_count >= 1, 'the near-dup guard must bump access on the existing row');

  // The guard reinforces, it never blocks the write: the paraphrase's own
  // embedding must still have landed.
  const row = (await brain._internal.query(
    'SELECT embedding IS NOT NULL AS has_vec FROM memories WHERE filename = $1', ['rent-paraphrase.md']
  )).rows[0];
  assert.equal(row.has_vec, true, 'a detected near-dup is still stored with its own embedding, never dropped');
  await brain.close();
});
