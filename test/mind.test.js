/**
 * The Mind — the promotion ladder (elifant#5).
 *
 * Acceptance criterion, verbatim from the issue: "a seeded corpus walks the
 * full ladder and back down again, every transition receipted." The walk below
 * does exactly that — pattern -> knowledge -> revision -> retirement on one
 * patternId, asserting the capture sequence at the end.
 *
 * Invariants under test, beyond the walk:
 *   - knowledge is pinned AND tier-2-synthesized (never the keyholder's
 *     tier-1 vouch path — setMemoryPin must stay untouched by machines);
 *   - sources are never modified;
 *   - re-running is a no-op (honest silence);
 *   - evidence LOSS is contradiction: deleting a pattern's memories collapses
 *     it without waiting for the calendar;
 *   - knowledge rows never feed the Keeper or the Mind's own evidence
 *     (no self-amplification, structurally);
 *   - retirement archives, never deletes; fresh evidence revives.
 *
 * Run with: node --test test/mind.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');
const mind = require('../src/mind.js');

const DIM = 384;
const DAY = 86400000;
const HOUR = 3600000;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mind-')); }
function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}
function axisVec(axis, weight = 1.0) {
  const v = new Array(DIM).fill(0);
  v[axis] = weight;
  return v;
}
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

async function backdate(filename, ms) {
  await brain._internal.query(
    'UPDATE memories SET updated_at = $1 WHERE filename = $2',
    [new Date(ms).toISOString(), filename]
  );
}

// Five garden memories on axis 0, backdated across 9 days ending at `t0` —
// old enough at birth to clear the 24h age gate on the first tick (genesis is
// not a special mode: born comes from real evidence timestamps).
async function seedFive(t0) {
  for (let i = 0; i < 5; i++) {
    const fn = `garden-${i}.md`;
    await brain.setMemory(fn, `garden note ${i} about the garden beds and compost`, 'test', 'instance', nearVec(0, i + 1));
    await backdate(fn, t0 - (4 - i) * 2.25 * DAY); // spread over ~9 days, newest at t0
  }
}

function iso(ms) { return new Date(ms).toISOString(); }

// Insert a shelf row directly, in the exact shape keeper.js's renderShelf/
// _setMemoryDerived produce, WITHOUT going through a real keeperTick. Isolates
// mind-side tests (filename collisions, embedding carry-through) to the mind's
// own candidate-reading + promotion logic, independent of keeper's own
// slug/collision behavior.
async function seedShelf(filename, members, thread, ts0) {
  for (let i = 0; i < members.length; i++) {
    await brain.setMemory(members[i], `note about ${thread}`, 'test', 'instance', nearVec(90 + members.length, 91 + i));
    await backdate(members[i], ts0 - (members.length - 1 - i) * DAY);
  }
  const lines = members.map((m) => `- ${m} (${iso(ts0).slice(0, 10)})`).join('\n');
  const content = `# on this shelf: ${members.length} memories\ncommon thread: ${thread}\n\n${lines}\n`;
  const { sha256, vvBump, vvStringify } = brain._internal;
  const vv = vvStringify(vvBump(null, 'seed-test'));
  await brain._internal.query(
    `INSERT INTO memories (filename, content, updated_by, updated_at, layer, trust_tier, synthesized_via, version_vector, content_hash, pinned, archived)
     VALUES ($1, $2, 'keeper', $3, 'instance', 'tier-2-synthesized', 'keeper/shelving-v1', $4, $5, false, false)`,
    [filename, content, iso(ts0), vv, sha256(content)]
  );
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('confidence: fresh plateau, linear decay, genuinely reaches zero (no floor)', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  const full = { n: 5, last: now - 1 * DAY };
  assert.equal(mind.confidence(full, now), 1, 'inside freshDays -> full weight');
  const mid = mind.confidence({ n: 5, last: now - 16.5 * DAY }, now);
  assert.ok(mid > 0.45 && mid < 0.55, `midpoint of the decay window ~0.5, got ${mid}`);
  assert.equal(mind.confidence({ n: 5, last: now - 30 * DAY }, now), 0,
    'at the horizon confidence is ZERO — the 0.3 floor that made retirement unreachable is gone');
  assert.equal(mind.confidence({ n: 0, last: now }, now), 0, 'no evidence, no confidence');
  const half = mind.confidence({ n: 2, last: now }, now);
  assert.ok(Math.abs(half - 0.4) < 1e-9, `evidence factor n/targetN: 2/5 = 0.4, got ${half}`);
});

test('promotable: all three gates required — confidence, n, age', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  const base = { status: 'forming', confidence: 0.9, signal: { n: 5 }, born: now - 2 * DAY };
  assert.equal(mind.promotable(base, now), true);
  assert.equal(mind.promotable({ ...base, confidence: 0.7 }, now), false, 'confidence gate');
  assert.equal(mind.promotable({ ...base, signal: { n: 4 } }, now), false, 'evidence gate');
  assert.equal(mind.promotable({ ...base, born: now - 12 * HOUR }, now), false,
    'age gate — knowledge does not harden in an afternoon, no matter how intense');
  assert.equal(mind.promotable({ ...base, status: 'hardened' }, now), false, 'only forming promotes');
});

test('renderKnowledge/appendHistory: history accumulates, never rewrites', () => {
  const c1 = mind.renderKnowledge('garden, compost', '5 memories about garden over 9 days',
    '2026-07-31', ['2026-07-31 promoted (confidence 1, n=5)']);
  assert.match(c1, /^# Garden, Compost\n/);
  assert.match(c1, /## history\n- 2026-07-31 promoted/);
  assert.match(c1, /_grown by the mind/);
  const c2 = mind.appendHistory(c1, 'garden, compost', '5 memories…', '2026-08-24',
    '2026-08-24 revised (confidence 0.33 — no fresh evidence in 24 days)');
  assert.match(c2, /- 2026-07-31 promoted[\s\S]*- 2026-08-24 revised/, 'appended, in order');
  assert.match(c2, /_grown by the mind/, 'footer survives');
});

test('threadOf: parses the keeper shelf thread line; honest empty otherwise', () => {
  assert.deepEqual(mind.threadOf('# shelf\ncommon thread: garden, compost\n- a.md'), ['garden', 'compost']);
  assert.deepEqual(mind.threadOf('# shelf\n- a.md'), []);
});

// ── the acceptance walk: up the ladder and back down, every rung receipted ──

test('a seeded corpus walks the full ladder and back down again, every transition receipted', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  await brain.setMemory('loner.md', 'the accountant moved the filing deadline', 'test', 'instance', normalize(axisVec(50)));

  // The Keeper builds the shelf; the Mind rides the same tick.
  const r1 = await brain.keeperTick({ mind: { now: iso(T) } });
  assert.ok(r1.mind, 'keeperTick carries the mind receipt');
  assert.equal(r1.mind.upserted, 1, 'one shelf -> one pattern');
  assert.equal(r1.mind.promoted, 1,
    'a genuinely 9-day-old cluster promotes on tick ONE — genesis backfills born from real evidence');

  // The knowledge row: pinned AND tier-2 — never the keyholder vouch path.
  const know = (await brain._internal.query(
    `SELECT filename, content, trust_tier, synthesized_via, pinned, archived FROM memories WHERE synthesized_via = $1`,
    [mind.MIND_VIA]
  )).rows;
  assert.equal(know.length, 1);
  const kfn = know[0].filename;
  assert.ok(kfn.startsWith('mind/knowledge/'), kfn);
  assert.equal(know[0].pinned, true, 'knowledge is pinned');
  assert.equal(know[0].trust_tier, 'tier-2-synthesized', 'pinned WITHOUT the tier-1 re-tag');
  assert.equal(know[0].synthesized_via, mind.MIND_VIA);
  assert.match(know[0].content, /## history\n- \d{4}-\d{2}-\d{2} promoted \(confidence /);
  assert.match(know[0].content, /5 memories about/);

  // Epoch: the mind was born, exactly once.
  const epoch = await brain.getState(mind.EPOCH_KEY);
  assert.ok(epoch, 'epoch written after the first successful pass');

  // Idempotent: a same-day re-tick says nothing and bumps nothing.
  const before = (await brain._internal.query(
    'SELECT content, version_vector FROM memories WHERE filename = $1', [kfn])).rows[0];
  const r2 = await brain.mindTick({ now: iso(T + 60000) });
  assert.equal(r2.promoted + r2.revised + r2.retired + r2.upserted + r2.revived, 0, 'honest silence');
  const after = (await brain._internal.query(
    'SELECT content, version_vector FROM memories WHERE filename = $1', [kfn])).rows[0];
  assert.deepEqual(after, before, 'no causal bump on a no-change tick');

  // Down: revision at ~22 days stale (confidence ~0.3, below 0.4).
  const r3 = await brain.mindTick({ now: iso(T + 22 * DAY) });
  assert.equal(r3.revised, 1, 'a visible revision');
  assert.equal(r3.retired, 0);
  const r3b = await brain.mindTick({ now: iso(T + 22 * DAY + 60000) });
  assert.equal(r3b.revised, 0, 'revision fires once per softening, not every tick');

  // Further down: retirement at ~28 days stale (confidence < 0.2).
  const r4 = await brain.mindTick({ now: iso(T + 28 * DAY) });
  assert.equal(r4.retired, 1, 'a visible retirement');
  const retiredRow = (await brain._internal.query(
    'SELECT archived, deleted_at, content FROM memories WHERE filename = $1', [kfn])).rows[0];
  assert.equal(retiredRow.archived, true, 'archived — reversible');
  assert.equal(retiredRow.deleted_at, null, 'never deleted');
  assert.match(retiredRow.content, /promoted[\s\S]*revised[\s\S]*retired/,
    'the history block is the durable record of every rung');

  // THE acceptance assertion: every transition receipted, in ladder order.
  const events = (await brain.getCaptures({ source: 'mind' }))
    .filter((c) => c.data.patternId && c.data.patternId.includes('garden'))
    .reverse(); // storage is newest-first
  assert.deepEqual(events.map((e) => e.data.stage), ['pattern', 'knowledge', 'revision', 'retirement'],
    'the full ladder, up and back down, in order');
  for (const e of events) {
    assert.ok(typeof e.data.text === 'string' && e.data.text.length > 0, 'every event narrated');
    assert.ok(typeof e.data.confidence === 'number', 'every event carries its confidence');
    assert.ok(e.data.evidenceSummary, 'every event carries its evidence receipt');
    assert.ok(e.data.threadKey, 'every event is threadable');
  }
  assert.equal(events[3].data.retired, true);

  const st = await brain.mindStatus();
  assert.equal(st.retired, 1);
  assert.equal(st.hardened, 0);
  assert.ok(st.lastTick, 'liveness receipt recorded');
  await brain.close();
});

// ── growth across ticks (not just genesis) ──────────────────────────────────

test('a pattern below the gates grows across ticks and promotes when it earns it', async () => {
  await freshBrain();
  const T = Date.now();
  // Three fresh members: n=3 < 5 and age ~0 — forming, not promotable.
  for (let i = 0; i < 3; i++) {
    await brain.setMemory(`work-${i}.md`, `work note ${i} about the quarterly report`, 'test', 'instance', nearVec(10, 11 + i));
  }
  const r1 = await brain.keeperTick({ mind: { now: iso(T) } });
  assert.equal(r1.mind.upserted, 1);
  assert.equal(r1.mind.promoted, 0, 'n=3, minutes old — nowhere near the gates');

  // Two more members arrive; the shelf grows to 5.
  for (let i = 3; i < 5; i++) {
    await brain.setMemory(`work-${i}.md`, `work note ${i} about the quarterly report`, 'test', 'instance', nearVec(10, 11 + i));
  }
  const r2 = await brain.keeperTick({ mind: { now: iso(T + HOUR) } });
  assert.equal(r2.mind.promoted, 0, 'n=5 now but only an hour old — the age gate holds');

  // A day later it has earned all three gates.
  const r3 = await brain.mindTick({ now: iso(T + 25 * HOUR) });
  assert.equal(r3.promoted, 1, 'promoted across ticks, once the age gate passes');
  await brain.close();
});

// ── contradiction is structural, not just calendar ──────────────────────────

test('evidence loss collapses a pattern without waiting for the calendar', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  await brain.keeperTick({ mind: { now: iso(T) } });

  // The keyholder deletes every memory the knowledge stood on.
  for (let i = 0; i < 5; i++) await brain.deleteMemory(`garden-${i}.md`);
  await brain.keeperTick({ mind: false }); // keeper archives the dissolved shelf
  const r = await brain.mindTick({ now: iso(T + HOUR) });
  assert.equal(r.retired, 1,
    'n recomputes from live refs -> 0 -> confidence 0 -> retirement, one hour after promotion');
  const know = (await brain._internal.query(
    `SELECT archived FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows[0];
  assert.equal(know.archived, true);
  await brain.close();
});

// ── revival: the ladder goes both ways ──────────────────────────────────────

test('fresh evidence revives a retired pattern and it can harden again', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  await brain.keeperTick({ mind: { now: iso(T) } });
  await brain.mindTick({ now: iso(T + 28 * DAY) }); // retire via staleness

  // The keyholder returns to the subject: refresh a member so the shelf's
  // last advances past the retirement-era evidence.
  await brain.setMemory('garden-0.md', 'garden note 0 revisited: the garden beds thawed', 'test', 'instance', nearVec(0, 1));
  await backdate('garden-0.md', T + 30 * DAY);
  await brain.keeperTick({ mind: false });
  const r = await brain.mindTick({ now: iso(T + 30 * DAY) });
  assert.equal(r.revived, 1, 'fresh evidence pulls a retired pattern back to forming');
  // Its evidence is strong (n=5, fresh) AND genuinely old (born 39 days ago),
  // so it clears every gate in the SAME pass — revive and re-promote in one
  // tick, the exact mechanic that lets genesis promote on tick one.
  assert.equal(r.promoted, 1, 'evidence returned strong and old — it climbs again immediately');

  const events = (await brain.getCaptures({ source: 'mind', type: 'pattern' }));
  assert.match(events[0].data.text, /forming again/, 'the revival is narrated as re-forming');

  // The knowledge row resurrects (archived=false) under the SAME filename,
  // history intact — no duplicate knowledge.
  const know = (await brain._internal.query(
    `SELECT filename, archived, content FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows;
  assert.equal(know.length, 1, 'same row, resurrected — no duplicate knowledge');
  assert.equal(know[0].archived, false);
  assert.match(know[0].content, /promoted[\s\S]*retired[\s\S]*promoted \(confidence .*\) again/,
    'the history shows the full round trip');

  const r2 = await brain.mindTick({ now: iso(T + 30 * DAY + HOUR) });
  assert.equal(r2.promoted + r2.revived + r2.revised + r2.retired, 0, 'and then holds steady');
  await brain.close();
});

// ── safety invariants ───────────────────────────────────────────────────────

test('sources are never touched by the mind pass', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  await brain.keeperTick({ mind: false });
  const pick = () => brain._internal.query(
    "SELECT filename, content_hash, version_vector, trust_tier, pinned FROM memories WHERE synthesized_via IS NULL ORDER BY filename");
  const before = (await pick()).rows;
  await brain.mindTick({ now: iso(T) });
  const after = (await pick()).rows;
  assert.deepEqual(after, before, 'the mind writes its own rows, never the keyholder\'s');
  await brain.close();
});

test('no self-amplification: knowledge never feeds the keeper or the mind', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  await brain.keeperTick({ mind: { now: iso(T) } });

  // The knowledge row must not enter the neighbour queue...
  assert.equal((await brain.keeperStatus()).queue, 0, 'derived rows never queue');
  // ...and a further full tick derives nothing new from it.
  const r = await brain.keeperTick({ mind: { now: iso(T + HOUR) } });
  assert.equal(r.shelvesWritten, 0);
  assert.equal(r.mind.upserted, 0, 'the mind never counts its own knowledge as evidence');
  const shelves = (await brain._internal.query(
    `SELECT content FROM memories WHERE synthesized_via = 'keeper/shelving-v1'`)).rows;
  for (const s of shelves) {
    assert.ok(!s.content.includes('mind/knowledge/'), 'no shelf ever contains a knowledge row');
  }
  await brain.close();
});

test('keeperTick({mind:false}) skips the pass; bare keeperTick runs it', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  const off = await brain.keeperTick({ mind: false });
  assert.equal(off.mind, null, 'explicit opt-out');
  const on = await brain.keeperTick();
  assert.ok(on.mind && typeof on.mind.promoted === 'number', 'bare call carries the mind receipt');
  await brain.close();
});

test('keeperTick({mind:null}) opts out exactly like {mind:false} — typeof null is "object" and must not reach _mind.tick', async () => {
  // Regression: receipt.mind uses `null` as its own "skipped" sentinel, which
  // makes {mind:null} the natural symmetric opt-out for a host reading that
  // sentinel back. A bare `typeof opts.mind === 'object'` check would route
  // null into _mind.tick() (typeof null === 'object') and crash on `opts.now`
  // — AFTER the keeper phase above had already committed its writes.
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  const r = await brain.keeperTick({ mind: null });
  assert.equal(r.mind, null, 'null opts out exactly like false, no throw');
  assert.ok(r.processed >= 0, 'the keeper phase still ran and committed normally');
  await brain.close();
});

test('keeperStatus().lastTick carries the mind receipt (not just the keeper phase)', async () => {
  // Regression: keeper.js's own tick() persists 'keeper_last_tick' to
  // brain_meta from INSIDE itself, before index.js's keeperTick() wrapper
  // attaches .mind to the returned object — so the persisted record was
  // silently mind-less even though the live return value and the
  // KeeperTickReceipt type both promise .mind. keeperStatus() must read back
  // what keeperTick() actually returned.
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  const live = await brain.keeperTick({ mind: { now: iso(T) } });
  const status = await brain.keeperStatus();
  assert.ok(status.lastTick, 'a tick receipt is on record');
  assert.ok(status.lastTick.mind, 'the RECORDED receipt carries the mind sub-receipt, not just the keeper phase');
  assert.deepEqual(status.lastTick.mind, live.mind, 'matches what keeperTick() actually returned');
  await brain.close();
});

test('an empty brain ticks quietly and still gets its epoch', async () => {
  await freshBrain();
  const r = await brain.mindTick();
  assert.equal(r.upserted + r.promoted + r.revised + r.retired, 0);
  assert.ok(await brain.getState(mind.EPOCH_KEY), 'the mind is born even before there is anything to think about');
  const st = await brain.mindStatus();
  assert.equal(st.day, 1, 'day one');
  await brain.close();
});

test('a fizzled forming pattern is culled quietly once its evidence goes cold', async () => {
  await freshBrain();
  const T = Date.now();
  // A 3-member cluster: forming, never promotable at n=3.
  for (let i = 0; i < 3; i++) {
    await brain.setMemory(`fad-${i}.md`, `note ${i} about a passing fad`, 'test', 'instance', nearVec(20, 21 + i));
  }
  await brain.keeperTick({ mind: { now: iso(T) } });
  assert.equal((await brain.mindStatus()).forming, 1);

  // The keyholder deletes the lot; the shelf dissolves; the pattern fizzles.
  for (let i = 0; i < 3; i++) await brain.deleteMemory(`fad-${i}.md`);
  await brain.keeperTick({ mind: false });
  const r = await brain.mindTick({ now: iso(T + HOUR) });
  assert.equal(r.culled, 1, 'never hardened, evidence gone — culled');
  const st = await brain.mindStatus();
  assert.equal(st.forming + st.hardened + st.retired, 0, 'the ledger does not hoard fizzles');
  assert.equal((await brain.getCaptures({ source: 'mind', type: 'retirement' })).length, 0,
    'nothing the keyholder was never told about gets a retirement notice');
  await brain.close();
});

test('two distinct shelves whose slugs collide never share a knowledge row', async () => {
  // Regression: _promote's clash loop used to treat ANY mind-authored row as
  // free to reuse ("synthesized_via === MIND_VIA" was read as "ours"), so two
  // shelves whose theme happened to slug to the same string collapsed onto
  // one knowledge file — and retiring one pattern archived the OTHER's still-
  // hardened knowledge out from under it. Force the collision directly: two
  // shelf filenames that differ in raw punctuation but slug() to the same
  // 'topic-one' base.
  await freshBrain();
  const T = Date.now();
  await seedShelf('shelf/topic!!!one.md', ['a-0.md', 'a-1.md', 'a-2.md', 'a-3.md', 'a-4.md'], 'topic one', T);
  await seedShelf('shelf/topic???one.md', ['b-0.md', 'b-1.md', 'b-2.md', 'b-3.md', 'b-4.md'], 'topic one', T);

  const r = await brain.mindTick({ now: iso(T) });
  assert.equal(r.promoted, 2, 'both patterns clear every gate on this tick');

  const rows = (await brain._internal.query(
    `SELECT filename FROM memories WHERE synthesized_via = $1 AND archived = false`, [mind.MIND_VIA]
  )).rows;
  assert.equal(rows.length, 2, 'two patterns, two distinct knowledge rows — never one shared row');
  assert.equal(new Set(rows.map((r2) => r2.filename)).size, 2, 'filenames are genuinely distinct');

  // The failure mode's second half: retiring one must never touch the other.
  // A short gap (not 40 days) so pattern A retires from EVIDENCE LOSS (n:5->0,
  // confidence 0 immediately) rather than staleness — which would also decay
  // untouched pattern B and confound the assertion.
  for (const m of ['a-0.md', 'a-1.md', 'a-2.md', 'a-3.md', 'a-4.md']) await brain.deleteMemory(m);
  await brain.mindTick({ now: iso(T + HOUR) });
  const live = (await brain._internal.query(
    `SELECT filename, archived FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA]
  )).rows;
  const stillLive = live.filter((row) => !row.archived);
  assert.equal(stillLive.length, 1, 'pattern B (untouched) stays hardened and live');
  await brain.close();
});

test('revision and retirement carry the knowledge row\'s embedding forward, never null it out', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  await brain.keeperTick({ mind: { now: iso(T) } }); // the shelf mind reads doesn't exist until keeper builds it
  const embedded = (await brain._internal.query(
    `SELECT embedding IS NOT NULL AS has_vec FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA]
  )).rows[0];
  assert.equal(embedded.has_vec, true, 'promotion writes a scent (mean of the shelf members)');

  await brain.mindTick({ now: iso(T + 21 * DAY) }); // stale enough to revise
  const afterRevise = (await brain._internal.query(
    `SELECT embedding IS NOT NULL AS has_vec FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA]
  )).rows[0];
  assert.equal(afterRevise.has_vec, true, 'revision must not silently de-search the row');

  await brain.mindTick({ now: iso(T + 27 * DAY) }); // stale enough to retire
  const afterRetire = (await brain._internal.query(
    `SELECT embedding IS NOT NULL AS has_vec FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA]
  )).rows[0];
  assert.equal(afterRetire.has_vec, true, 'retirement must not silently de-search the row either');
  await brain.close();
});

test('mindTick(null) and keeperTick({mind:null}) both opt out cleanly — no crash at any entry point', async () => {
  await freshBrain();
  const T = Date.now();
  await seedFive(T);
  // The direct standalone entry point — no keeperTick guard sits in front of it.
  const r1 = await brain.mindTick(null);
  assert.ok(r1 && typeof r1.promoted === 'number', 'null normalizes to {} rather than throwing');
  const r2 = await brain.keeperTick({ mind: null });
  assert.equal(r2.mind, null, 'still opts out cleanly through the keeperTick wrapper too');
  await brain.close();
});
