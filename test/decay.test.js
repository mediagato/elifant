/**
 * Decay — the forgetting curve (elifant#9): "decay toward the archive, never
 * delete." src/decay.js's own header has the full design writeup; these tests
 * cover:
 *
 *   - the candidate predicate itself: old AND weak decays; young, strong,
 *     pinned, or non-keyholder-direct rows never do, each proven by its own
 *     control (a row that clears every OTHER gate but the one under test);
 *   - reversible: setMemoryArchive(fn, false) undoes a decay completely,
 *     archived_reason included, and the row is fully live again;
 *   - visible: every decay is a receipted {source:'decay'} capture;
 *   - bounded: at most `batch` rows decay per tick;
 *   - the snapshot-before-bulk guard (kernel-ethic #11).
 *
 * The Mind-interaction acceptance criteria (decay is not contradiction;
 * genuine retraction still is; reversal recovers evidence) live in
 * test/mind.test.js alongside the rest of the Mind's own suite, since they are
 * fundamentally about mind.js's SOURCE_WHERE, not about decay.js's candidate
 * selection.
 *
 * Run with: node --test test/decay.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

const DAY = 86400000;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'decay-')); }
async function freshBrain() { const dir = tmpDir(); await brain.init(dir); return dir; }
function iso(ms) { return new Date(ms).toISOString(); }

async function backdate(filename, ms) {
  await brain._internal.query('UPDATE memories SET updated_at = $1 WHERE filename = $2', [iso(ms), filename]);
}

// Hand-place a memory_access row with an exact access_count/last_accessed,
// rather than driving real searchMemories() recalls — this is a unit test of
// decay's THRESHOLD arithmetic, and decay.js reuses index.js's own strength
// curve (ctx.strengthOf) rather than re-deriving it, so what matters here is
// getting a known (count, lastAccessed) pair in front of that curve, not
// re-proving the curve's own shape (reinforcement.test.js already does that).
async function setAccess(filename, accessCount, lastAccessedMs) {
  const ts = iso(lastAccessedMs);
  await brain._internal.query(
    `INSERT INTO memory_access (filename, access_count, first_accessed, last_accessed)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT(filename) DO UPDATE SET access_count = $2, last_accessed = $3`,
    [filename, accessCount, ts]
  );
}

test('old + never-recalled decays; young, strong, pinned, and non-keyholder rows each have their own control', async () => {
  await freshBrain();
  const T = Date.now();

  // (a) THE POSITIVE: old (70 days untouched) and never recalled at all.
  await brain.setMemory('old-cold.md', 'a note nobody has looked at in months', 'test');
  await backdate('old-cold.md', T - 70 * DAY);

  // (b) control: old but genuinely recalled recently — strong, protected.
  await brain.setMemory('old-hot.md', 'a note that keeps getting pulled up', 'test');
  await backdate('old-hot.md', T - 70 * DAY);
  await setAccess('old-hot.md', 1, T - 1 * DAY); // ln(2)*2^(-1/30) ~= 0.677, way over the floor

  // (c) control: young (10 days) and never recalled — not old enough yet.
  await brain.setMemory('young-cold.md', 'a fresh note, untouched since', 'test');
  await backdate('young-cold.md', T - 10 * DAY);

  // (d) control: old AND weak, but PINNED — the sanctioned vouch exemption.
  await brain.setMemory('old-pinned.md', 'a note the keyholder vouched for', 'test');
  await backdate('old-pinned.md', T - 70 * DAY);
  await brain.setMemoryPin('old-pinned.md', true);

  // (e) control: old and weak, but NOT keyholder-direct (a synthesized row —
  // decay must never touch a shelf/knowledge row; it isn't in decay's pool at all).
  await brain._internal.query(
    `INSERT INTO memories (filename, content, updated_by, updated_at, layer, trust_tier, synthesized_via, version_vector, content_hash, pinned, archived)
     VALUES ('synth/old.md', 'a derived row', 'keeper', $1, 'instance', 'tier-2-synthesized', 'keeper/shelving-v1', '{}', 'x', false, false)`,
    [iso(T - 70 * DAY)]
  );

  const r = await brain.decayTick({ now: iso(T) });
  assert.equal(r.decayed, 1, `expected exactly one decay, got ${r.decayed}`);

  const rows = (await brain._internal.query(
    'SELECT filename, archived, archived_reason FROM memories ORDER BY filename'
  )).rows;
  const byName = Object.fromEntries(rows.map((row) => [row.filename, row]));

  assert.equal(byName['old-cold.md'].archived, true, 'old + never-recalled decays');
  assert.equal(byName['old-cold.md'].archived_reason, 'decay');

  assert.equal(byName['old-hot.md'].archived, false, 'a genuine recent recall protects it');
  assert.equal(byName['young-cold.md'].archived, false, 'too young — no edit-free window has elapsed yet');
  assert.equal(byName['old-pinned.md'].archived, false, 'pinned is a permanent exemption');
  assert.equal(byName['synth/old.md'].archived, false, 'a synthesized row is never in decay\'s pool');

  await brain.close();
});

test('a row recalled long enough ago crosses back under the floor and decays anyway', async () => {
  // The floor is calendar-scaled, not a permanent shield: one recall protects
  // for a while, not forever. ln(2) * 2^(-100/30) ~= 0.0687 < the 0.1 floor.
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('once-long-ago.md', 'recalled exactly once, ages back', 'test');
  await backdate('once-long-ago.md', T - 70 * DAY);
  await setAccess('once-long-ago.md', 1, T - 100 * DAY);

  const r = await brain.decayTick({ now: iso(T) });
  assert.equal(r.decayed, 1);
  const row = (await brain._internal.query(
    'SELECT archived FROM memories WHERE filename = $1', ['once-long-ago.md']
  )).rows[0];
  assert.equal(row.archived, true, 'strength decays with time even after a genuine recall');
  await brain.close();
});

test('decay is reversible: setMemoryArchive(fn, false) fully undoes it', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('bring-back.md', 'a note that will decay and then return', 'test');
  await backdate('bring-back.md', T - 70 * DAY);
  await brain.decayTick({ now: iso(T) });

  let row = (await brain._internal.query(
    'SELECT archived, archived_reason FROM memories WHERE filename = $1', ['bring-back.md']
  )).rows[0];
  assert.equal(row.archived, true);
  assert.equal(row.archived_reason, 'decay');

  await brain.setMemoryArchive('bring-back.md', false);
  row = (await brain._internal.query(
    'SELECT archived, archived_reason FROM memories WHERE filename = $1', ['bring-back.md']
  )).rows[0];
  assert.equal(row.archived, false, 'un-archived');
  assert.equal(row.archived_reason, null, 'no residue — the reason does not survive un-archiving');

  // ...and it is back in the default listing, exactly as though nothing happened.
  const all = await brain.getAllMemories();
  assert.ok(all.some((m) => m.filename === 'bring-back.md'), 'visible in the default listing again');
  await brain.close();
});

test('decay is visible: every decay is a receipted {source:"decay"} capture', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('narrated.md', 'a note that will decay quietly for the keyholder, loudly for the ledger', 'test');
  await backdate('narrated.md', T - 70 * DAY);

  await brain.decayTick({ now: iso(T) });
  const events = await brain.getCaptures({ source: 'decay' });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.filename, 'narrated.md');
  assert.ok(typeof events[0].data.text === 'string' && events[0].data.text.length > 0);
  assert.ok(events[0].data.strength < 0.1, 'the narrated strength is under the floor, by construction');
  await brain.close();
});

test('bounded writes: at most `batch` rows decay in one tick', async () => {
  await freshBrain();
  const T = Date.now();
  for (let i = 0; i < 8; i++) {
    const fn = `bulk-${i}.md`;
    await brain.setMemory(fn, `bulk note ${i}, long forgotten`, 'test');
    await backdate(fn, T - 70 * DAY);
  }
  const r = await brain.decayTick({ now: iso(T), batch: 3 });
  assert.equal(r.decayed, 3, 'the batch cap holds even though 8 rows qualify');
  assert.equal(r.scanned, 8, 'scanning still saw every old-enough candidate');

  // The remaining 5 decay on a subsequent tick — nothing is lost, just deferred.
  const r2 = await brain.decayTick({ now: iso(T + 3600000), batch: 3 });
  assert.equal(r2.decayed, 3);
  const r3 = await brain.decayTick({ now: iso(T + 7200000), batch: 3 });
  assert.equal(r3.decayed, 2, 'the last 2 finish the sweep');
  await brain.close();
});

test('snapshot-before-bulk guard: the first decay pass ever snapshots regardless of size', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('one-cold.md', 'a single old note', 'test');
  await backdate('one-cold.md', T - 70 * DAY);

  const before = (await brain.listSnapshots()).length;
  const r = await brain.decayTick({ now: iso(T) });
  assert.equal(r.decayed, 1);
  assert.equal(r.snapshotTaken, true, 'first-ever decay pass snapshots, matching the keeper\'s own #11 guard');
  const after = (await brain.listSnapshots()).length;
  assert.equal(after, before + 1);

  // A second small pass, same day, does NOT snapshot again — one is already on record.
  await brain.setMemory('two-cold.md', 'another old note', 'test');
  await backdate('two-cold.md', T - 70 * DAY);
  const r2 = await brain.decayTick({ now: iso(T + 60000) });
  assert.equal(r2.snapshotTaken, false, 'a small pass does not re-snapshot once one is already on record');
  await brain.close();
});

test('an empty/young brain ticks quietly', async () => {
  await freshBrain();
  await brain.setMemory('brand-new.md', 'just written', 'test');
  const r = await brain.decayTick();
  assert.equal(r.decayed, 0);
  assert.equal(r.scanned, 0, 'nothing is even old enough to be a candidate yet');
  await brain.close();
});

test('setMemoryArchive rejects an unknown reason, and pre-existing call sites (no reason) still work', async () => {
  await freshBrain();
  await brain.setMemory('plain.md', 'a plain memory', 'test');
  // The generic, unattributed archive — every call site written before this
  // issue shipped (keeper.js's own shelf-dissolve archive; every test that
  // pre-dates archived_reason) keeps working with no changes required.
  await brain.setMemoryArchive('plain.md', true);
  const row = (await brain._internal.query(
    'SELECT archived, archived_reason FROM memories WHERE filename = $1', ['plain.md']
  )).rows[0];
  assert.equal(row.archived, true);
  assert.equal(row.archived_reason, null, 'unattributed archive: reason is honestly null, not invented');

  await assert.rejects(
    () => brain.setMemoryArchive('plain.md', true, 'because-i-said-so'),
    /unknown archive reason/i
  );
  await brain.close();
});
