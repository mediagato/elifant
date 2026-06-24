/**
 * Continuity fix (Phase 0) — the causal `merge` conflict policy in importBrain.
 *
 * Two "devices" are simulated as two brain dirs with distinct substrate_identities;
 * one exports, the other imports with conflict:'merge'. Proves: version-vector
 * domination fast-forwards, a dominated import is skipped, deletes propagate as
 * tombstones, concurrent edits surface as conflict copies (never a silent clobber),
 * delete-vs-edit keeps the edit, and re-applying an export converges (no-op).
 *
 * Run with: node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-merge-test-')); }

test('merge: a dominating version fast-forwards; a dominated one is skipped', async () => {
  const a = tmpDir(), b = tmpDir();
  try {
    await brain.init(a);
    await brain.setMemory('m.md', 'v1');
    const exp1 = (await brain.exportBrain()).payload;     // {A:1}
    await brain.setMemory('m.md', 'v2');
    const exp2 = (await brain.exportBrain()).payload;     // {A:2} dominates {A:1}
    await brain.close();

    await brain.init(b);
    await brain.importBrain({ payload: exp1, conflict: 'merge' });
    assert.equal((await brain.getMemory('m.md')).content, 'v1', 'first sync lands v1');

    const r = await brain.importBrain({ payload: exp2, conflict: 'merge', allow_replay: true });
    assert.equal((await brain.getMemory('m.md')).content, 'v2', 'incoming dominates → fast-forward');
    assert.equal(r.conflict_copies, 0, 'domination is never a conflict');

    await brain.importBrain({ payload: exp1, conflict: 'merge', allow_replay: true });
    assert.equal((await brain.getMemory('m.md')).content, 'v2', 'dominated re-import skipped, no regress');
    await brain.close();
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('merge: a delete propagates as a tombstone (dominates a stale present row)', async () => {
  const a = tmpDir(), b = tmpDir();
  try {
    await brain.init(a);
    await brain.setMemory('d.md', 'present');
    const exp1 = (await brain.exportBrain()).payload;
    await brain.deleteMemory('d.md');                     // {A:2} tombstone
    const exp2 = (await brain.exportBrain()).payload;
    await brain.close();

    await brain.init(b);
    await brain.importBrain({ payload: exp1, conflict: 'merge' });
    assert.ok(await brain.getMemory('d.md'), 'present after first sync');
    await brain.importBrain({ payload: exp2, conflict: 'merge', allow_replay: true });
    assert.equal(await brain.getMemory('d.md'), null, 'delete propagated → gone, not resurrected');
    await brain.close();
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('merge: concurrent edits → winner keeps the key, loser preserved as a conflict copy + surfaced', async () => {
  const a = tmpDir(), b = tmpDir();
  try {
    await brain.init(a);
    await brain.setMemory('shared.md', 'alpha from A');    // {A:1}
    const expA = (await brain.exportBrain()).payload;
    await brain.close();

    await brain.init(b);
    await brain.setMemory('shared.md', 'beta from B');      // {B:1} — concurrent, divergent
    const res = await brain.importBrain({ payload: expA, conflict: 'merge' });
    assert.equal(res.conflicts, 1);
    assert.equal(res.conflict_copies, 1, 'loser preserved as a copy');

    const names = (await brain.getAllMemories()).map((m) => m.filename).filter((n) => n.startsWith('shared.md'));
    assert.equal(names.length, 2, 'both versions retained (winner + conflict copy)');
    assert.ok(names.includes('shared.md'), 'winner holds the canonical key');
    assert.ok(names.some((n) => /^shared\.md\.conflict-[0-9a-f]{8}$/.test(n)), 'loser under a deterministic .conflict-<hash> key');

    const caps = await brain.getCaptures({ type: 'conflict' });
    assert.ok(caps.length >= 1, 'conflict surfaced into the event stream, never silent');
    await brain.close();
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('merge: concurrent delete-vs-edit keeps the edit (never lose content to a delete)', async () => {
  const a = tmpDir(), b = tmpDir();
  try {
    await brain.init(a);
    await brain.setMemory('m.md', 'base');
    const base = (await brain.exportBrain()).payload;
    await brain.close();

    await brain.init(b);
    await brain.importBrain({ payload: base, conflict: 'merge' });  // B: m.md=base {A:1}
    await brain.setMemory('m.md', 'B-edit');                        // {A:1,B:1}
    const bEdit = (await brain.exportBrain()).payload;
    await brain.close();

    await brain.init(a);                                           // A still has m.md {A:1}
    await brain.deleteMemory('m.md');                              // {A:2} tombstone
    await brain.importBrain({ payload: bEdit, conflict: 'merge', allow_replay: true });
    const got = await brain.getMemory('m.md');
    assert.ok(got, 'the edit survived a concurrent delete');
    assert.equal(got.content, 'B-edit');
    await brain.close();
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('merge: re-applying the same export converges (second apply is a no-op)', async () => {
  const a = tmpDir(), b = tmpDir();
  try {
    await brain.init(a);
    await brain.setMemory('x.md', 'data');
    const exp = (await brain.exportBrain()).payload;
    await brain.close();

    await brain.init(b);
    const r1 = await brain.importBrain({ payload: exp, conflict: 'merge' });
    assert.equal(r1.imported.memories, 1, 'first apply takes the row');
    const r2 = await brain.importBrain({ payload: exp, conflict: 'merge', allow_replay: true });
    assert.equal(r2.imported.memories, 0, 'identical lineage → skipped');
    assert.equal(r2.conflict_copies, 0, 'no phantom conflict on re-apply');
    await brain.close();
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});
