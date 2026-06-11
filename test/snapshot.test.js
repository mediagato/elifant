/**
 * H2 — SNAPSHOT / ROLLBACK / LIST_SNAPSHOTS / HEALTH (kernel 0.16.0).
 *
 * Snapshots are full-fidelity filesystem dumpDataDir copies (NOT exportBrain, which
 * omits captures/embeddings/flags). Covers the build-blocking findings from the
 * second-opinion review: in-memory loadDataDir (options-first), crash-safe replace
 * swap, transaction-exclusive resurrect-and-flag forward-merge, Nose-gated embedding
 * carry, prune-watermark captures, spec-shaped returns, never-throw health.
 *
 * Run with: node --test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-snap-')); }
function vec() { return Array.from({ length: 384 }, (_, i) => (i === 0 ? 0.1 : 0.0)); }

test('snapshot: creates a tarball + index line; receipt counts match live', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('a.md', 'aaa', 'test', 'instance');
    await brain.setMemory('b.md', 'bbb', 'test', 'instance');
    await brain.setState('k', 'v');
    const r = await brain.snapshot('first', { trigger: 'keyholder-explicit' });
    assert.match(r.snapshot_id, /^snap_/);
    assert.equal(r.trigger, 'keyholder-explicit');
    assert.equal(r.table_counts.memories, 2);
    assert.equal(r.table_counts.state, 1);
    assert.ok(r.bytes > 0 && r.sha256.startsWith('sha256:'));
    assert.ok(fs.existsSync(path.join(dir, 'snapshots', `${r.snapshot_id}.tar.gz`)));
    const idx = fs.readFileSync(path.join(dir, 'snapshots', 'index.jsonl'), 'utf8').trim().split('\n');
    assert.equal(idx.length, 1);
    assert.equal(JSON.parse(idx[0]).snapshot_id, r.snapshot_id);
  } finally { await brain.close(); }
});

test('listSnapshots: newest-first, trigger filter, missing index → []', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    assert.deepEqual(await brain.listSnapshots(), []);
    const s1 = await brain.snapshot('one', { trigger: 'keyholder-explicit' });
    const s2 = await brain.snapshot('two', { trigger: 'schedule' });
    const all = await brain.listSnapshots();
    assert.equal(all.length, 2);
    assert.equal(all[0].snapshot_id, s2.snapshot_id, 'newest first');
    const sched = await brain.listSnapshots({ trigger: 'schedule' });
    assert.equal(sched.length, 1);
    assert.equal(sched[0].snapshot_id, s2.snapshot_id);
    // metadata shape only (no payload/sha leak)
    assert.ok(!('sha256' in all[0]) && !('storage_uri' in all[0]));
    assert.ok('table_counts' in all[0] && 'bytes' in all[0]);
  } finally { await brain.close(); }
});

test('replace: full restore (snapshot wins entirely); embeddings + captures survive; confirm required', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('keep.md', 'original', 'test', 'instance', vec());
    await brain.setState('mode', 'on');
    await brain.addCapture({ source: 'watcher', type: 'evt', data: { n: 1 }, ts: '2025-01-01T00:00:00Z' });
    const snap = await brain.snapshot('pre-change');

    // diverge: delete keep.md, add a NEW memory that replace must drop
    await brain.deleteMemory('keep.md');
    await brain.setMemory('added-after.md', 'should vanish on replace', 'test', 'instance');

    await assert.rejects(() => brain.rollback(snap.snapshot_id, 'replace'), /requires options\.confirm/);

    const res = await brain.rollback(snap.snapshot_id, 'replace', { confirm: true });
    assert.equal(res.mode, 'replace');
    assert.ok(res.safety_snapshot_id, 'replace takes a safety snapshot first');

    assert.ok(await brain.getMemory('keep.md'), 'restored');
    assert.equal((await brain.getMemory('keep.md')).content, 'original');
    assert.equal(await brain.getMemory('added-after.md'), null, 'post-snapshot memory dropped by full replace');
    assert.equal((await brain.getState('mode')).value, 'on');
    const caps = await brain.getCaptures({ source: 'watcher' });
    assert.equal(caps.length, 1, 'captures restored');
    // embedding preserved → not in the re-embed backfill queue
    const needing = await brain.getMemoriesNeedingEmbedding(50);
    assert.ok(!needing.find(m => m.filename === 'keep.md'), 'restored memory keeps its embedding');

    // snapshots/ is a sibling of brain/, so the index survives the swap: original + safety
    const list = await brain.listSnapshots();
    assert.equal(list.length, 2);
    assert.ok(list.find(s => s.trigger === 'pre-action'), 'safety snapshot is pre-action (retention-exempt)');
  } finally { await brain.close(); }
});

test('fork: sibling bowl with a DIFFERENT identity; live untouched', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('m.md', 'forkme', 'test', 'instance');
    const parentId = (await brain.exportBrain()).manifest.substrate_identity;
    const snap = await brain.snapshot('pre-fork');
    const res = await brain.rollback(snap.snapshot_id, 'fork');
    assert.equal(res.mode, 'fork');
    assert.ok(res.fork_bowl_id && res.fork_bowl_id !== parentId, 'fork is a new being (fresh identity)');
    assert.ok(fs.existsSync(path.join(res.fork_path, 'brain', 'PG_VERSION')), 'fork materialized on disk');
    // live untouched
    assert.equal((await brain.getMemory('m.md')).content, 'forkme');
    assert.equal((await brain.exportBrain()).manifest.substrate_identity, parentId, 'forking bowl identity preserved');
  } finally { await brain.close(); }
});

test('forward-merge: resurrect-and-flag absent rows; newer-wins keeps live edits; audit capture; safety snapshot', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('lost.md', 'precious', 'test', 'instance', vec());
    await brain.setMemory('keep.md', 'v1', 'test', 'instance');
    await brain.setState('s', 'v1');
    const snap = await brain.snapshot('pre-loss');

    await brain.deleteMemory('lost.md');           // accidental delete to recover
    await brain.setMemory('keep.md', 'v2-edited');  // edited after snapshot → live should win
    await brain.setState('s', 'v2');
    await brain.setMemory('new.md', 'made after snapshot', 'test', 'instance'); // not in snapshot

    const res = await brain.rollback(snap.snapshot_id, 'forward-merge');
    assert.equal(res.mode, 'forward-merge');
    assert.ok(res.safety_snapshot_id, 'mandatory pre-merge safety snapshot');
    assert.equal(res.resurrected_counts.memories, 1);

    const lost = await brain.getMemory('lost.md');
    assert.ok(lost, 'absent-in-live row resurrected');
    assert.equal(lost.restored_from, snap.snapshot_id, 'resurrection is FLAGGED');
    assert.ok(!(await brain.getMemoriesNeedingEmbedding(50)).find(m => m.filename === 'lost.md'), 'resurrected memory kept its Scent (Nose matched)');

    assert.equal((await brain.getMemory('keep.md')).content, 'v2-edited', 'newer live edit wins');
    assert.equal((await brain.getState('s')).value, 'v2', 'newer live state wins');
    assert.ok(await brain.getMemory('new.md'), 'post-snapshot row untouched');
    assert.equal((await brain.getMemory('new.md')).restored_from ?? null, null, 'live row not flagged');

    const audit = await brain.getCaptures({ source: 'snapshot-restore' });
    assert.equal(audit.length, 1);
    assert.ok(audit[0].data.resurrected.memories.includes('lost.md'), 'audit lists what came back');
  } finally { await brain.close(); }
});

test('forward-merge: captures set-union dedup; prune watermark blocks deliberately-pruned captures', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.addCapture({ source: 'noise', type: 'e', data: { x: 1 }, ts: '2020-01-01T00:00:00Z' });
    await brain.addCapture({ source: 'sig', type: 'e', data: { y: 2 }, ts: '2025-06-01T00:00:00Z' });
    const snap = await brain.snapshot('pre-prune');

    // prune the old noise by TIME (sets the watermark), keep the signal
    const deleted = await brain.deleteCaptures({ until: '2020-12-31T00:00:00Z' });
    assert.equal(deleted, 1);

    const res = await brain.rollback(snap.snapshot_id, 'forward-merge');
    // the deliberately-pruned 'noise' must NOT come back; 'sig' was never deleted (dedup → no dup)
    assert.equal((await brain.getCaptures({ source: 'noise' })).length, 0, 'time-pruned capture not resurrected');
    assert.equal((await brain.getCaptures({ source: 'sig' })).length, 1, 'set-union did not duplicate the surviving capture');
    assert.equal(res.resurrected_counts.captures, 0);
  } finally { await brain.close(); }
});

test('forward-merge: Nose drift → resurrected memory embedding is NULL (lands in re-embed queue)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('e.md', 'embedded', 'test', 'instance', vec());
    const snap = await brain.snapshot('pre-nose-swap');
    await brain.deleteMemory('e.md');
    await brain.setEmbedMeta({ version: '2' }); // live Nose now differs from the snapshot's
    await brain.rollback(snap.snapshot_id, 'forward-merge');
    assert.ok(await brain.getMemory('e.md'), 'resurrected');
    const needing = await brain.getMemoriesNeedingEmbedding(50);
    assert.ok(needing.find(m => m.filename === 'e.md'), 'stale Scent dropped; queued for re-embed under the live Nose');
  } finally { await brain.close(); }
});

test('rollback: missing tarball → throws, live untouched', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('safe.md', 'here', 'test', 'instance');
    const snap = await brain.snapshot('s');
    fs.unlinkSync(path.join(dir, 'snapshots', `${snap.snapshot_id}.tar.gz`));
    await assert.rejects(() => brain.rollback(snap.snapshot_id, 'forward-merge'));
    assert.equal((await brain.getMemory('safe.md')).content, 'here', 'live intact after a failed rollback');
  } finally { await brain.close(); }
});

test('listSnapshots: a corrupt mid-file index line is skipped, valid receipts still listed', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const s1 = await brain.snapshot('one');
    const s2 = await brain.snapshot('two');
    const idxPath = path.join(dir, 'snapshots', 'index.jsonl');
    const lines = fs.readFileSync(idxPath, 'utf8').trim().split('\n');
    fs.writeFileSync(idxPath, [lines[0], '{ this is not json', lines[1]].join('\n') + '\n');
    const all = await brain.listSnapshots();
    assert.equal(all.length, 2, 'both valid receipts survive a garbage line between them');
    assert.deepEqual(all.map(s => s.snapshot_id).sort(), [s1.snapshot_id, s2.snapshot_id].sort());
    assert.ok(all.every(s => s.reason === 'one' || s.reason === 'two'), 'reasons came from the index parser, not the glob fallback (which would say "recovered")');
  } finally { await brain.close(); }
});

test('crash-safety: an interrupted replace swap is COMPLETED on next init (never bootstraps empty)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('survivor.md', 'must-not-vanish', 'test', 'instance');
  await brain.close();

  // Simulate a crash AFTER rename#1 (brain→brain.old) and the new dir staged, BEFORE
  // rename#2: brain/ missing, brain.new valid, journal present.
  const brainDir = path.join(dir, 'brain');
  fs.cpSync(brainDir, brainDir + '.new', { recursive: true });
  fs.renameSync(brainDir, brainDir + '.old');
  fs.writeFileSync(path.join(dir, '.rollback-journal.json'), JSON.stringify({ phase: 'swapping', snapshot_id: 'snap_x', at: 't' }));
  assert.ok(!fs.existsSync(brainDir), 'precondition: brain/ is missing mid-swap');

  await brain.init(dir); // recovery must complete the swap, not bootstrap a fresh empty brain
  try {
    const m = await brain.getMemory('survivor.md');
    assert.ok(m && m.content === 'must-not-vanish', 'data recovered, not silently wiped');
    assert.ok(!fs.existsSync(brainDir + '.old') && !fs.existsSync(brainDir + '.new'), 'swap dirs cleaned');
    assert.ok(!fs.existsSync(path.join(dir, '.rollback-journal.json')), 'journal cleared');
  } finally { await brain.close(); }
});

test('crash-safety: interrupted swap with NO recoverable dir REFUSES to bootstrap empty', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('x.md', 'x', 'test', 'instance');
  await brain.close();
  const brainDir = path.join(dir, 'brain');
  fs.rmSync(brainDir, { recursive: true, force: true }); // nothing valid anywhere
  fs.writeFileSync(path.join(dir, '.rollback-journal.json'), JSON.stringify({ phase: 'swapping', snapshot_id: 'snap_x' }));
  await assert.rejects(() => brain.init(dir), /interrupted rollback detected/);
});

test('health: overview is self-describing, never throws, guards a zero baseline', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const fresh = await brain.health(); // brand-new brain, zero captures
    assert.equal(fresh.question, 'overview');
    assert.equal(fresh.baseline_window, 'trailing 7 days');
    assert.ok(Array.isArray(fresh.observations) && fresh.observations.length > 0);
    assert.ok(fresh.observations.every(o => 'dimension' in o && 'significance' in o));

    await brain.addCapture({ source: 'w', type: 'e', data: { a: 1 } });
    const cv = await brain.health('capture-volume');
    assert.ok(cv.observations.find(o => /capture volume/.test(o.dimension)));

    // unknown facet → explicit not-available observation, never silent omit
    const us = await brain.health('unknown-sources');
    assert.ok(us.observations.find(o => o.current === 'not available'));

    // unrecognized question → acknowledged (echoed back) + degrades to overview
    const bogus = await brain.health('is-bob-ok');
    assert.equal(bogus.question, 'is-bob-ok');
    assert.ok(bogus.observations.length > 0);
  } finally { await brain.close(); }
});

// ── security+code-pass must-fix regression tests ──────────────────────────────

test('crash-safety: journal LOST (missing/torn) + brain/ gone but brain.old valid → recovers, never empty-bootstraps', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  await brain.setMemory('survivor.md', 'must-not-vanish', 'test', 'instance');
  await brain.close();
  const brainDir = path.join(dir, 'brain');
  // rename#1 done (brain→brain.old) then a crash whose journal NEVER persisted (power
  // loss / AV quarantine / dotfile-skipping copy): brain/ missing, brain.old valid, NO journal.
  fs.renameSync(brainDir, brainDir + '.old');
  assert.ok(!fs.existsSync(path.join(dir, '.rollback-journal.json')), 'precondition: no journal');
  await brain.init(dir); // must recover from brain.old, NOT bootstrap a fresh empty brain
  try {
    const m = await brain.getMemory('survivor.md');
    assert.ok(m && m.content === 'must-not-vanish', 'recovered from brain.old, not silently wiped');
    assert.ok(!fs.existsSync(brainDir + '.old'), 'brain.old consumed (not left to be deleted next boot)');
  } finally { await brain.close(); }
});

test('rollback: succeeds after the dataDir MOVES (stale absolute storage_uri ignored)', async () => {
  const dir1 = tmpDir();
  await brain.init(dir1);
  await brain.setMemory('m.md', 'v1', 'test', 'instance');
  const snap = await brain.snapshot('pre-move');
  assert.ok(path.isAbsolute(snap.storage_uri), 'receipt records an absolute storage_uri');
  await brain.close();
  const dir2 = dir1 + '-moved'; // new laptop / renamed folder → the absolute uri now dangles
  fs.renameSync(dir1, dir2);
  await brain.init(dir2);
  try {
    await brain.deleteMemory('m.md');
    const res = await brain.rollback(snap.snapshot_id, 'forward-merge'); // resolves the LOCAL tarball
    assert.equal(res.resurrected_counts.memories, 1, 'restore worked post-move');
    assert.ok(await brain.getMemory('m.md'));
  } finally { await brain.close(); }
});

test('forward-merge: a SCOPED prune (until+source) does NOT block an unrelated source from resurrecting', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.addCapture({ source: 'noise', type: 'e', data: { x: 1 }, ts: '2020-01-01T00:00:00Z' });
    await brain.addCapture({ source: 'important', type: 'e', data: { y: 2 }, ts: '2020-01-01T00:00:00Z' });
    const snap = await brain.snapshot('pre-prune');
    await brain.deleteCaptures({ until: '2020-06-01T00:00:00Z', source: 'noise' }); // scoped — must NOT advance the watermark
    await brain.deleteCaptures({ source: 'important' });                            // separately lose the important stream
    await brain.rollback(snap.snapshot_id, 'forward-merge');
    assert.equal((await brain.getCaptures({ source: 'important' })).length, 1, 'unrelated lost capture resurrected (watermark not wrongly advanced)');
  } finally { await brain.close(); }
});

// ── 0.16.1 hardening regression tests ─────────────────────────────────────────

test('fork: gets a FRESH signing keypair — cannot sign as the parent', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('m.md', 'x', 'test', 'instance');
    const parentPub = (await brain.exportBrain()).manifest.signature.keyholder_public_key;
    const snap = await brain.snapshot('pre-fork');
    const res = await brain.rollback(snap.snapshot_id, 'fork');
    const { PGlite } = require('@electric-sql/pglite');
    const { vector } = require('@electric-sql/pglite/vector');
    const fk = new PGlite(path.join(res.fork_path, 'brain'), { extensions: { vector } });
    const r = await fk.query("SELECT value FROM brain_meta WHERE key='signing_keypair_v1'");
    await fk.close();
    const forkPub = JSON.parse(r.rows[0].value).public_b64;
    assert.ok(forkPub && forkPub !== parentPub, 'fork signing key differs from the parent');
  } finally { await brain.close(); }
});

test('forward-merge: snapshot-WINS conflict UPDATES the live row (not a resurrection)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('m.md', 'OLD', 'test', 'instance');
    const sOld = await brain.snapshot('old');
    await new Promise(r => setTimeout(r, 1100)); // force a later second (updated_at is sec-precision)
    await brain.setMemory('m.md', 'NEW', 'test', 'instance');
    const sNew = await brain.snapshot('new');
    await brain.rollback(sOld.snapshot_id, 'replace', { confirm: true }); // live regresses to m='OLD'
    const res = await brain.rollback(sNew.snapshot_id, 'forward-merge');   // snapshot 'NEW' is strictly newer
    assert.equal((await brain.getMemory('m.md')).content, 'NEW', 'newer snapshot row won the conflict');
    assert.equal(res.imported.memories, 1);
    assert.equal((await brain.getMemory('m.md')).restored_from ?? null, null, 'conflict-update, not flagged as a resurrection');
  } finally { await brain.close(); }
});

test('rollback: a CORRUPTED tarball fails the sha256 integrity check, live untouched', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.setMemory('safe.md', 'here', 'test', 'instance');
    const snap = await brain.snapshot('s');
    const p = path.join(dir, 'snapshots', `${snap.snapshot_id}.tar.gz`);
    const b = fs.readFileSync(p); b[Math.floor(b.length / 2)] ^= 0xff; fs.writeFileSync(p, b);
    await assert.rejects(() => brain.rollback(snap.snapshot_id, 'forward-merge'), /integrity check/);
    assert.equal((await brain.getMemory('safe.md')).content, 'here', 'live intact after the integrity abort');
  } finally { await brain.close(); }
});

test('snapshot retention: same-bucket old snapshots are thinned to one (recent kept)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.snapshot('seed'); // creates snapshots/ + index
    const snapDir = path.join(dir, 'snapshots');
    const ts = new Date(Date.now() - 10 * 86400000).toISOString(); // 10d ago → same daily bucket
    for (const id of ['snap_olda', 'snap_oldb']) {
      fs.writeFileSync(path.join(snapDir, `${id}.tar.gz`), 'x'); // dummy tarball
      fs.appendFileSync(path.join(snapDir, 'index.jsonl'), JSON.stringify({ snapshot_id: id, reason: 'old', trigger: 'schedule', exported_at: ts, table_counts: {}, bytes: 1 }) + '\n');
    }
    await brain.snapshot('trigger-retention'); // fires _applyRetention
    const ids = (await brain.listSnapshots()).map(s => s.snapshot_id);
    const keptOld = ids.filter(i => i === 'snap_olda' || i === 'snap_oldb');
    assert.equal(keptOld.length, 1, 'two old snapshots in the same bucket thinned to one');
    assert.ok(ids.some(i => /^snap_2/.test(i)), 'recent (real) snapshots kept');
    // the reaped tarball is gone and does not resurrect via the glob fallback
    const onDisk = fs.readdirSync(snapDir).filter(f => f.endsWith('.tar.gz')).map(f => f.replace('.tar.gz', ''));
    assert.equal(onDisk.filter(i => i === 'snap_olda' || i === 'snap_oldb').length, 1, 'reaped tarball unlinked');
  } finally { await brain.close(); }
});
