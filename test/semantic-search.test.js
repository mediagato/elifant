/**
 * Tests for v0.4.0 semantic-search additions: pgvector init, embedding
 * column on memories, setMemoryEmbedding, getMemoriesNeedingEmbedding,
 * and searchMemories ordering + filters.
 *
 * Embeddings are synthetic (not from a real model) -- we only need
 * controlled cosine-distance relationships to verify ordering. Real
 * models live in the consuming app, not the kernel.
 *
 * Run with: node --test test/semantic-search.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

const DIM = 384;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-vec-'));
}

// Build a synthetic embedding: place magnitude `weight` on axis `axis`,
// zeros elsewhere. Used to construct controlled cosine relationships.
function axisVec(axis, weight = 1.0, dim = DIM) {
  const v = new Array(dim).fill(0);
  v[axis] = weight;
  return v;
}

// Normalize so cosine distance from pgvector is well-behaved (the model
// in production also returns normalized embeddings).
function normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

test('init enables pgvector + memories.embedding column exists', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  // If pgvector wasn't loaded, a CREATE EXTENSION vector statement would
  // have thrown during init. Verify the column is there + can accept a vector.
  await brain.setMemory('probe.md', 'probe body', 'test', 'instance', normalize(axisVec(0)));
  await brain.close();
});

test('setMemory stores embedding when supplied', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const vec = normalize(axisVec(5, 1.0));
  await brain.setMemory('with-vec.md', 'content', 'test', 'instance', vec);

  // searchMemories with the same vector should put with-vec.md first.
  const hits = await brain.searchMemories({ queryEmbedding: vec, k: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].filename, 'with-vec.md');
  assert.ok(hits[0].distance < 0.001, `expected tiny distance, got ${hits[0].distance}`);
  await brain.close();
});

test('setMemory without embedding stores NULL embedding (searchable via backfill)', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setMemory('no-vec.md', 'just text');

  // searchMemories excludes NULL-embedding rows
  const hits = await brain.searchMemories({ queryEmbedding: normalize(axisVec(0)), k: 5 });
  assert.equal(hits.length, 0, 'NULL-embedding rows must be excluded from search');

  // ...but it shows up in the backfill queue
  const todo = await brain.getMemoriesNeedingEmbedding(10);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].filename, 'no-vec.md');
  assert.equal(todo[0].content, 'just text');
  await brain.close();
});

test('setMemoryEmbedding fills in a missing embedding + memory becomes searchable', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await brain.setMemory('late-vec.md', 'late content');
  const vec = normalize(axisVec(42));
  await brain.setMemoryEmbedding('late-vec.md', vec);

  const hits = await brain.searchMemories({ queryEmbedding: vec, k: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].filename, 'late-vec.md');

  // And it should be gone from the backfill queue
  const todo = await brain.getMemoriesNeedingEmbedding(10);
  assert.equal(todo.length, 0);
  await brain.close();
});

test('searchMemories returns top-k ordered by cosine distance', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  // Put three memories on three different axes. Query along axis 0 with a
  // small noise component on axis 1 so the ordering is unambiguous.
  await brain.setMemory('close.md', 'on axis 0', 'test', 'instance', normalize(axisVec(0)));
  await brain.setMemory('orthogonal.md', 'on axis 1', 'test', 'instance', normalize(axisVec(1)));
  await brain.setMemory('far.md', 'on axis 2', 'test', 'instance', normalize(axisVec(2)));

  const hits = await brain.searchMemories({
    queryEmbedding: normalize(axisVec(0)),
    k: 3,
  });
  assert.equal(hits.length, 3);
  assert.equal(hits[0].filename, 'close.md', 'closest should rank first');
  // The two orthogonal vectors are tied at distance ~1; just assert close.md beats them.
  assert.ok(hits[0].distance < hits[1].distance);
  assert.ok(hits[0].distance < hits[2].distance);
  await brain.close();
});

test('searchMemories filters by layer', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = normalize(axisVec(0));

  await brain.setMemory('inst.md', 'instance row', 'test', 'instance', vec);
  await brain.setMemory('pat.md', 'pattern row', 'test', 'pattern', vec);

  const instHits = await brain.searchMemories({ queryEmbedding: vec, k: 5, layer: 'instance' });
  assert.equal(instHits.length, 1);
  assert.equal(instHits[0].filename, 'inst.md');

  const patHits = await brain.searchMemories({ queryEmbedding: vec, k: 5, layer: 'pattern' });
  assert.equal(patHits.length, 1);
  assert.equal(patHits[0].filename, 'pat.md');
  await brain.close();
});

test('searchMemories filters by filename prefix', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const vec = normalize(axisVec(0));

  await brain.setMemory('students/sam.md', 'sam', 'test', 'instance', vec);
  await brain.setMemory('students/lin.md', 'lin', 'test', 'instance', vec);
  await brain.setMemory('meetings/tuesday.md', 'tue', 'test', 'instance', vec);

  const hits = await brain.searchMemories({ queryEmbedding: vec, k: 10, prefix: 'students/' });
  assert.equal(hits.length, 2);
  for (const h of hits) {
    assert.ok(h.filename.startsWith('students/'), `unexpected hit outside prefix: ${h.filename}`);
  }
  await brain.close();
});

test('searchMemories rejects non-finite or missing queryEmbedding', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  await assert.rejects(
    brain.searchMemories({ k: 1 }),
    /queryEmbedding is required/
  );
  await assert.rejects(
    brain.searchMemories({ queryEmbedding: [1, NaN, 3], k: 1 }),
    /non-finite/
  );
  await brain.close();
});

// ── v0.7.0 hybrid reranking (additive; engaged only when queryText is given) ──

test('hybrid mode PRESERVES raw cosine distance + adds rerank_score (does not clobber distance)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const v0 = normalize(axisVec(0));
  const v1 = normalize(axisVec(1));
  await brain.setMemory('a.md', 'grateful dead concert tickets', 'test', 'instance', v0);
  await brain.setMemory('b.md', 'orange bikini fashion note', 'test', 'instance', v1);

  const hits = await brain.searchMemories({ queryEmbedding: v0, queryText: 'grateful dead', k: 2 });
  assert.equal(hits.length, 2);
  for (const h of hits) {
    // CRITICAL: distance must remain the RAW cosine distance in [0,2], NOT the
    // fused score (~0–0.05). Three downstream surfaces threshold on its absolute
    // value (extension/bowl 0.9 floors). This is the audit's non-negotiable.
    assert.ok(typeof h.distance === 'number' && h.distance >= 0 && h.distance <= 2,
      `distance must stay raw cosine [0,2], got ${h.distance}`);
    assert.ok('rerank_score' in h, 'hybrid hit must carry a separate rerank_score');
    assert.ok(h.rerank_score < 0.9, 'sanity: fused score stays well under the 0.9 floor');
  }
  // a.md is both cosine-closest AND the lexical match → ranks first.
  assert.equal(hits[0].filename, 'a.md');
  await brain.close();
});

test('hybrid lexical leg does not rank a literal-term match WORSE than cosine alone', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const qv = normalize(axisVec(0));
  // decoy is cosine-closest but lexically irrelevant to the query
  await brain.setMemory('decoy.md', 'a pleasant generic note', 'test', 'instance', normalize(axisVec(0)));
  // target is cosine-FAR but contains the literal query term
  await brain.setMemory('target.md', 'eskimo pies are the best', 'test', 'instance', normalize(axisVec(50)));

  const base = await brain.searchMemories({ queryEmbedding: qv, k: 2 });
  assert.equal(base[0].filename, 'decoy.md', 'cosine alone ranks the decoy first');
  const baseRank = base.findIndex((h) => h.filename === 'target.md');

  const hybrid = await brain.searchMemories({ queryEmbedding: qv, queryText: 'eskimo pies', k: 2 });
  const hybridRank = hybrid.findIndex((h) => h.filename === 'target.md');
  assert.ok(hybridRank <= baseRank, 'lexical match must not rank worse under hybrid reranking');
  await brain.close();
});

test('hybrid recency is pin-aware: a pinned memory is not demoted below an unpinned one', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const v = normalize(axisVec(0));
  await brain.setMemory('pinned.md', 'cobalt blue preference', 'test', 'instance', v);
  await brain.setMemory('plain.md', 'cobalt blue preference', 'test', 'instance', v);
  await brain.setMemoryPin('pinned.md', true);

  // identical cosine + lexical; the recency leg treats pinned as freshest, so it
  // must rank at or above the unpinned twin.
  const hits = await brain.searchMemories({ queryEmbedding: v, queryText: 'cobalt blue', k: 2 });
  const pinnedRank = hits.findIndex((h) => h.filename === 'pinned.md');
  const plainRank = hits.findIndex((h) => h.filename === 'plain.md');
  assert.ok(pinnedRank <= plainRank, 'pinned memory must not be demoted below the unpinned one');
  await brain.close();
});

test('rerank:false forces base mode even when queryText is supplied', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const v = normalize(axisVec(0));
  await brain.setMemory('only.md', 'eskimo pies', 'test', 'instance', v);
  const hits = await brain.searchMemories({ queryEmbedding: v, queryText: 'eskimo pies', k: 1, rerank: false });
  assert.equal(hits.length, 1);
  assert.ok(!('rerank_score' in hits[0]), 'base mode must not add rerank_score');
  await brain.close();
});

test('migrateEmbedDim re-dimensions the Scent column (nulls all, keeps content) + records the new Nose', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('a.md', 'hello world', 'test', 'instance', normalize(axisVec(0))); // 384-dim
  assert.equal((await brain.searchMemories({ queryEmbedding: normalize(axisVec(0)), k: 1 })).length, 1);

  const n = await brain.migrateEmbedDim(768, { model: 'nomic-embed-text', version: '2' });
  assert.equal(n, 1, 'one memory now needs re-embed');

  const meta = await brain.getEmbedMeta();
  assert.equal(meta.dim, 768);
  assert.equal(meta.model, 'nomic-embed-text');
  assert.equal(meta.version, '2');

  // content preserved, embedding nulled -> in the backfill queue, excluded from search
  const todo = await brain.getMemoriesNeedingEmbedding(10);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].content, 'hello world');

  // re-embed at the new dim -> searchable again with a 768-dim query
  const q768 = new Array(768).fill(0); q768[0] = 1;
  await brain.setMemoryEmbedding('a.md', normalize(q768));
  const re = await brain.searchMemories({ queryEmbedding: normalize(q768), k: 1 });
  assert.equal(re.length, 1);
  assert.equal(re[0].filename, 'a.md');
  await brain.close();
});

test('dim-mismatch guard: a wrong-dimension query embedding returns [] (not a 500)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('m.md', 'content', 'test', 'instance', normalize(axisVec(0))); // 384-dim stored
  const wrongDim = new Array(768).fill(0); wrongDim[0] = 1; // 768-dim query (mid model-swap)
  const hits = await brain.searchMemories({ queryEmbedding: wrongDim, k: 5 });
  assert.deepEqual(hits, [], 'wrong-dim query must degrade to empty, not throw');
  // and the hybrid path (queryText) must also be guarded
  const hits2 = await brain.searchMemories({ queryEmbedding: wrongDim, queryText: 'content', k: 5 });
  assert.deepEqual(hits2, [], 'hybrid wrong-dim query must also degrade to empty');
  await brain.close();
});

test('migrateEmbedDim is atomic — a failed re-dimension rolls back to the prior dim (no torn migration)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('a.md', 'hello world', 'test', 'instance', normalize(axisVec(0))); // 384-dim
  const before = await brain.getEmbedMeta();
  assert.equal(before.dim, 384);

  // pgvector caps a vector(N) column at 16000 dims, so this fails at the ADD step —
  // AFTER the DROP — which is exactly the torn-migration window. With the migration
  // wrapped in one transaction, the DROP must roll back. (Pre-fix, the DROP would
  // have stuck: column gone, data lost, while embed_dim still read 384.)
  await assert.rejects(
    () => brain.migrateEmbedDim(100000, { model: 'oversize', version: '9' }),
    'an over-max dim must throw'
  );

  // brain UNCHANGED: meta still 384 and the 384-dim Scent column + its row survived.
  const after = await brain.getEmbedMeta();
  assert.equal(after.dim, 384, 'embed_dim must be unchanged after a rolled-back migration');
  assert.equal(after.model, before.model, 'embed_model must be unchanged');
  assert.equal(after.version, before.version, 'embed_version must be unchanged');
  const hits = await brain.searchMemories({ queryEmbedding: normalize(axisVec(0)), k: 1 });
  assert.equal(hits.length, 1, 'the embedding column + data must survive the rollback');

  await brain.close();
});

test('the Nose identity (embed_model/dim/version) is recorded + readable; setEmbedMeta updates it', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  const meta = await brain.getEmbedMeta();
  assert.equal(meta.model, 'Xenova/all-MiniLM-L6-v2');
  assert.equal(meta.dim, 384);
  assert.equal(meta.version, '1');

  await brain.setEmbedMeta({ model: 'nomic-embed-text', dim: 768, version: '2' });
  const after = await brain.getEmbedMeta();
  assert.equal(after.model, 'nomic-embed-text');
  assert.equal(after.dim, 768);
  assert.equal(after.version, '2');
  await brain.close();
});

// ── elifant#4 regression: a content edit must not keep the stale vector ────
//
// setMemory's no-embedding UPDATE used to leave the embedding column alone,
// so editing a memory's content made the row semantically findable by its
// PREVIOUS meaning and invisible under its current one — forever, because
// the backfill queue only looks for NULL embeddings. The fix nulls the
// vector when (and only when) the content hash changes.

test('editing content without a new embedding drops the stale vector', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const vecOld = normalize(axisVec(3));
  await brain.setMemory('edit-me.md', 'the old meaning', 'test', 'instance', vecOld);

  // Sanity: findable by the old vector before the edit.
  let hits = await brain.searchMemories({ queryEmbedding: vecOld, k: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].filename, 'edit-me.md');

  // Edit the content — the shape every shell uses: save now, embed later.
  await brain.setMemory('edit-me.md', 'a completely new meaning', 'test', 'instance');

  // The old vector must be GONE: not findable by the previous meaning...
  hits = await brain.searchMemories({ queryEmbedding: vecOld, k: 5 });
  assert.equal(hits.length, 0, 'stale vector must not survive a content edit');

  // ...and queued for re-embedding with the NEW content.
  const todo = await brain.getMemoriesNeedingEmbedding(10);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].filename, 'edit-me.md');
  assert.equal(todo[0].content, 'a completely new meaning');
  await brain.close();
});

test('re-saving identical content keeps the vector (no needless re-embed)', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const vec = normalize(axisVec(7));
  await brain.setMemory('same.md', 'unchanged words', 'test', 'instance', vec);

  // Same bytes, no vector supplied — e.g. a shell re-save or a sync echo.
  await brain.setMemory('same.md', 'unchanged words', 'test', 'instance');

  const hits = await brain.searchMemories({ queryEmbedding: vec, k: 5 });
  assert.equal(hits.length, 1, 'an unchanged re-save must not drop the vector');
  assert.equal(hits[0].filename, 'same.md');

  const todo = await brain.getMemoriesNeedingEmbedding(10);
  assert.equal(todo.length, 0, 'an unchanged re-save must not enter the backfill queue');
  await brain.close();
});

test('a tombstone resurrected with identical content keeps its vector', async () => {
  const dir = tmpDir();
  await brain.init(dir);

  const vec = normalize(axisVec(9));
  await brain.setMemory('lazarus.md', 'come back', 'test', 'instance', vec);
  await brain.deleteMemory('lazarus.md');

  // Resurrection with the same bytes: content unchanged, vector still valid.
  await brain.setMemory('lazarus.md', 'come back', 'test', 'instance');

  const hits = await brain.searchMemories({ queryEmbedding: vec, k: 5 });
  assert.equal(hits.length, 1, 'same-content resurrection must keep the vector');
  await brain.close();
});
