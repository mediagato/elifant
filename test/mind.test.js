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

test('#20 promotable: promoteHighN is the age gate\'s only escape hatch, and it is off by default', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  // (c) the default must be a no-op for every existing consumer.
  assert.equal(mind.DEFAULTS.promoteHighN, Infinity,
    'off by default — no consumer\'s behavior changes unless it opts in explicitly');
  const young = { status: 'forming', confidence: 0.9, signal: { n: 40 }, born: now - 1 * HOUR };
  assert.equal(mind.promotable(young, now), false,
    'n=40 an hour old still waits: Infinity means no n can ever clear the hatch');

  // (a) opted in, and the evidence reaches it -> age is bought out.
  assert.equal(mind.promotable(young, now, { ...mind.DEFAULTS, promoteHighN: 12 }), true,
    'n >= promoteHighN promotes regardless of age');
  // (b) opted in, evidence short of it -> the 24h gate applies exactly as today.
  const shallow = { ...young, signal: { n: 11 } };
  assert.equal(mind.promotable(shallow, now, { ...mind.DEFAULTS, promoteHighN: 12 }), false,
    'n < promoteHighN still waits out promoteAgeH');
  assert.equal(mind.promotable({ ...shallow, born: now - 2 * DAY }, now, { ...mind.DEFAULTS, promoteHighN: 12 }), true,
    '...and clears it the normal way once it is genuinely old');

  // The hatch is scoped to AGE. It never buys out confidence or recurrence.
  const hi = { ...mind.DEFAULTS, promoteHighN: 12 };
  assert.equal(mind.promotable({ ...young, confidence: 0.7 }, now, hi), false, 'confidence gate still hard');
  assert.equal(mind.promotable({ ...young, signal: { n: 4 } }, now, hi), false,
    'promoteN still hard — n=4 clears neither gate');
  assert.equal(mind.promotable({ ...young, status: 'hardened' }, now, hi), false, 'only forming promotes');
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

test('#18 themeSignature: order-independent, and an unnamed subject is NOT an identity', () => {
  assert.equal(mind.themeSignature('garden, compost'), mind.themeSignature('compost, Garden'),
    'the same two tokens in either order sign the same');
  assert.notEqual(mind.themeSignature('garden, compost'), mind.themeSignature('garden'));
  // The Keeper's honest degradation must never become a shared identity: every
  // threadless shelf would otherwise be "the same subject" as every other one.
  assert.equal(mind.themeSignature('similar things'), '');
  assert.equal(mind.themeSignature(''), '');
  assert.equal(mind.themeSignature(null), '');
});

test('#18 adoptionClaims: evidence outranks subject, ambiguity is refused, claims are one-to-one', () => {
  const shelfC = (id, members, sig) => ({ id, kind: 'shelf-recurrence', members, threadSig: sig });
  const shelfO = (id, liveRefs, sig) => ({ id, kind: 'shelf-recurrence', liveRefs, threadSig: sig });

  // Evidence: keeper matchClusters' own threshold — half the smaller side.
  assert.deepEqual([...mind.adoptionClaims(
    [shelfC('c1', ['a.md', 'b.md', 'c.md'], '')], [shelfO('p1', ['a.md', 'b.md'], '')]
  )], [['c1', 'p1']], '2 of 2 surviving refs are in the reforming cluster');
  assert.deepEqual([...mind.adoptionClaims(
    [shelfC('c1', ['a.md', 'x.md', 'y.md', 'z.md'], '')], [shelfO('p1', ['a.md', 'b.md', 'c.md', 'd.md'], '')]
  )], [], '1 of 4 is not continuity, it is a coincidence');

  // Subject is the fallback, and it loses to evidence when both are on offer.
  assert.deepEqual([...mind.adoptionClaims(
    [shelfC('c1', ['n1.md', 'n2.md', 'n3.md'], 'garden')],
    [shelfO('pTheme', [], 'garden'), shelfO('pEvidence', ['n1.md', 'n2.md'], 'compost')]
  )], [['c1', 'pEvidence']], 'shared memories beat a shared word');

  // Ambiguity is refused outright rather than guessed — either side.
  assert.deepEqual([...mind.adoptionClaims(
    [shelfC('c1', ['n1.md'], 'garden')], [shelfO('p1', [], 'garden'), shelfO('p2', [], 'garden')]
  )], [], 'two orphans on one subject: unanswerable, so unanswered');
  assert.deepEqual([...mind.adoptionClaims(
    [shelfC('c1', ['n1.md'], 'garden'), shelfC('c2', ['n2.md'], 'garden')], [shelfO('p1', [], 'garden')]
  )], [], 'two reforming clusters on one subject: same refusal');
  // Two threadless shelves are unambiguously alone on the empty signature —
  // and still must not match, because '' is not a subject.
  assert.deepEqual([...mind.adoptionClaims(
    [shelfC('c1', ['n1.md'], '')], [shelfO('p1', [], '')]
  )], [], 'an empty signature matches nothing, however alone it is');

  // Kinds never cross: a confirmed vouch and a statistical shelf are different
  // evidence with different weighting rules.
  assert.deepEqual([...mind.adoptionClaims(
    [{ id: 'c1', kind: 'confirmed-dup', members: ['a.md', 'b.md'], threadSig: 'rent' }],
    [shelfO('p1', ['a.md', 'b.md'], 'rent')]
  )], [], 'a confirmed pair never adopts a shelf pattern');

  // One-to-one: the best-supported claim takes the pattern, the loser gets none.
  const twoWay = mind.adoptionClaims(
    [shelfC('cWeak', ['a.md', 'q.md'], ''), shelfC('cStrong', ['a.md', 'b.md', 'c.md'], '')],
    [shelfO('p1', ['a.md', 'b.md', 'c.md'], '')]
  );
  assert.deepEqual([...twoWay], [['cStrong', 'p1']], 'overlap decides, and only one candidate can win');
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

test('#20: a rolling-window host can promote on evidence depth alone — but only by opting in', async () => {
  // askari/mind (Allen) keeps a ~24h rolling window, so a pattern's `born`
  // — derived from the member rows' own updated_at — can never age past the
  // window however much evidence stacks up. Without an escape hatch a
  // 40-observation pattern sits in `forming` forever.
  await freshBrain();
  const T = Date.now();
  for (let i = 0; i < 6; i++) {
    await brain.setMemory(`window-${i}.md`, `route note ${i} about the north tunnel checkpoint`,
      'test', 'instance', nearVec(160, 161 + i));
  }
  // (c) DEFAULT: promoteHighN is Infinity, so this is exactly today's kernel —
  // minutes-old evidence waits out the 24h gate no matter how deep it is.
  const r1 = await brain.keeperTick({ mind: { now: iso(T) } });
  assert.equal(r1.mind.upserted, 1, 'one shelf, one pattern');
  assert.equal(r1.mind.promoted, 0, 'default promoteHighN Infinity — the age gate is unconditional');

  // (b) opted in, but the evidence does not reach the hatch: unchanged.
  const r2 = await brain.mindTick({ now: iso(T + 60000), promoteHighN: 12 });
  assert.equal(r2.promoted, 0, 'n=6 < promoteHighN 12 — still waits out promoteAgeH exactly as today');

  // (a) opted in and the evidence reaches it: promotes at ~0h old.
  const r3 = await brain.mindTick({ now: iso(T + 120000), promoteHighN: 6 });
  assert.equal(r3.promoted, 1, 'n=6 >= promoteHighN — depth of evidence buys out the calendar');
  const know = (await brain._internal.query(
    `SELECT content, pinned, trust_tier FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows;
  assert.equal(know.length, 1, 'a real knowledge row, on the normal promotion path');
  assert.equal(know[0].pinned, true);
  assert.equal(know[0].trust_tier, 'tier-2-synthesized', 'still never the keyholder vouch path');
  await brain.close();
});

test('#20: promoteHighN never reaches the Guard — deep evidence about a third party still promotes nothing', async () => {
  // The hatch is scoped to ONE gate. Everything the kernel refuses to infer it
  // still refuses at any n (elifant#16/#17: the floor reads no config at all).
  await freshBrain();
  const T = Date.now();
  const gripes = [
    'Dave was late to standup again and the whole morning slipped',
    'Dave shipped the broken build again, he never runs the tests',
    'so tired of covering for Dave, he is impossible to plan around',
    'Dave talked over me for the entire retro meeting',
    'another Dave morning, he left the build red and went home',
    'Dave skipped the handoff again and nobody could ship',
  ];
  for (let i = 0; i < gripes.length; i++) {
    await brain.setMemory(`hn-gripe-${i}.md`, gripes[i], 'test', 'instance', nearVec(30, 31 + i));
  }
  await brain.keeperTick({ mind: false });
  const r = await brain.mindTick({ now: iso(T), promoteHighN: 1 });
  assert.equal(r.promoted, 0, 'no promoteHighN value reaches the third-party floor');
  assert.ok(r.guarded >= 1, 'the guard is what held it');
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

// ── elifant#18: identity survives archive-and-reform ────────────────────────

// The Keeper's own dissolve primitive — a shelf whose cluster fell below
// MIN_SHELF is archived, reversible, never deleted (keeper.js's end-of-tick
// sweep). Driving it directly keeps these tests about the MIND's identity
// resolution rather than about which edge-graph accident dissolved the shelf.
async function dissolveShelf(filename) { await brain.setMemoryArchive(filename, true); }

// Rewrite a live shelf's membership in place (what the Keeper does when a
// cluster grows or shrinks without dissolving — the shelf keeps its filename).
async function setShelfMembers(filename, members, thread, ts0) {
  const lines = members.map((m) => `- ${m} (${iso(ts0).slice(0, 10)})`).join('\n');
  await brain._internal.query('UPDATE memories SET content = $1 WHERE filename = $2', [
    `# on this shelf: ${members.length} memories\ncommon thread: ${thread}\n\n${lines}\n`, filename,
  ]);
}

test('#18 acceptance: a shelf that is ARCHIVED and later reforms revives as the SAME pattern, one continuous history', async () => {
  // The gap this closes: a shelf that merely shrinks keeps its filename
  // (matchClusters), so revival always worked. A shelf that fully DISSOLVES is
  // archived, and the reformation lands on a new filename — shelfSlug's clash
  // loop refuses an archived-but-not-deleted name — which used to be a new,
  // disconnected pattern with its own second knowledge row.
  await freshBrain();
  const T = Date.now();
  const beds = ['bed-0.md', 'bed-1.md', 'bed-2.md', 'bed-3.md', 'bed-4.md'];
  await seedShelf('shelf/beds.md', beds, 'garden', T);
  const r1 = await brain.mindTick({ now: iso(T) });
  assert.equal(r1.upserted, 1);
  assert.equal(r1.promoted, 1, 'nine days of evidence, n=5 — it hardens on tick one');

  // The cluster dissolves. The memories themselves are untouched: this is the
  // edge graph changing its mind, not the keyholder deleting anything.
  await dissolveShelf('shelf/beds.md');
  const r2 = await brain.mindTick({ now: iso(T + 28 * DAY) });
  assert.equal(r2.retired, 1, 'no shelf, no fresh evidence — it goes quiet and retires');

  // A month on, the same memories re-cluster. The Keeper cannot reuse the
  // archived name, so this arrives as a brand-new producer row.
  await seedShelf('shelf/beds-2.md', beds, 'garden', T + 30 * DAY);
  const r3 = await brain.mindTick({ now: iso(T + 30 * DAY) });
  assert.equal(r3.upserted, 0, 'ADOPTED, not duplicated — no second pattern is born');
  assert.equal(r3.revived, 1, 'the retired pattern is the one that comes back');
  assert.equal(r3.promoted, 1, 'and it climbs again');

  // THE acceptance assertion: one pattern, one knowledge row, one history.
  const know = (await brain._internal.query(
    `SELECT filename, archived, content FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows;
  assert.equal(know.length, 1, 'ONE knowledge row — the reformation is not a duplicate');
  assert.equal(know[0].archived, false, 'the original row is un-archived, not replaced');
  assert.match(know[0].content, /promoted[\s\S]*retired[\s\S]*promoted \(confidence .*\) again/,
    'one continuous history: promoted, retired, promoted again');

  const st = await brain.mindStatus();
  assert.equal(st.patterns, 1, 'one ledger row, not two');
  assert.equal(st.hardened, 1);
  assert.equal(st.retired, 0);

  // ...and the whole round trip threads as one pattern for any host reading
  // the capture stream, which is the part a duplicate row cannot fake.
  const events = (await brain.getCaptures({ source: 'mind' })).reverse();
  assert.deepEqual(events.map((e) => e.data.stage),
    ['pattern', 'knowledge', 'retirement', 'pattern', 'knowledge']);
  assert.equal(new Set(events.map((e) => e.data.patternId)).size, 1,
    'ONE patternId across the archive boundary');
  assert.equal(new Set(events.map((e) => e.data.threadKey)).size, 1,
    'and one threadKey — a host threading by it never sees the seam');
  assert.match(events[3].data.text, /forming again/);

  // The ledger row itself records which producer rows have carried it — the
  // durable, auditable receipt that this pattern lived on two shelves.
  const row = JSON.parse((await brain.getState(mind.STATE_PREFIX + 'shelf:shelf/beds.md')).value);
  assert.deepEqual(row.aliases, ['shelf:shelf/beds-2.md']);
  assert.equal(row.id, 'shelf:shelf/beds.md', 'the id never moves — that is what makes it an identity');
  await brain.close();
});

test('#18: a subject that reforms on entirely NEW memories revives the same pattern too — the theme fallback', async () => {
  // The case evidence cannot answer: not one memory the pattern stood on
  // survives, so overlap is structurally zero. The subject signature is the
  // only thing left, and it is used ONLY here.
  await freshBrain();
  const T = Date.now();
  await seedShelf('shelf/kiln.md', ['k-0.md', 'k-1.md', 'k-2.md', 'k-3.md', 'k-4.md'], 'pottery', T);
  assert.equal((await brain.mindTick({ now: iso(T) })).promoted, 1);

  await dissolveShelf('shelf/kiln.md');
  for (let i = 0; i < 5; i++) await brain.deleteMemory(`k-${i}.md`);
  const r2 = await brain.mindTick({ now: iso(T + HOUR) });
  assert.equal(r2.retired, 1, 'every ref is gone — n recomputes to 0 and it retires the same hour');

  // Two months later the keyholder comes back to pottery, on all-new notes.
  await seedShelf('shelf/kiln-2.md', ['k2-0.md', 'k2-1.md', 'k2-2.md', 'k2-3.md', 'k2-4.md'], 'pottery', T + 60 * DAY);
  const r3 = await brain.mindTick({ now: iso(T + 60 * DAY) });
  assert.equal(r3.upserted, 0, 'one orphan, one reforming cluster, one subject — unambiguous');
  assert.equal(r3.revived, 1);
  assert.equal(r3.promoted, 1);
  const know = (await brain._internal.query(
    `SELECT content FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows;
  assert.equal(know.length, 1, 'still one knowledge row, still one history');
  assert.match(know[0].content, /promoted[\s\S]*retired[\s\S]*again/);
  await brain.close();
});

test('#18: adoption never fabricates continuity — no shared evidence and no shared subject is a NEW pattern', async () => {
  // The control. If adoption could not fail, the tests above would prove
  // nothing: they would just be describing a kernel that merges everything.
  await freshBrain();
  const T = Date.now();
  await seedShelf('shelf/kiln.md', ['k-0.md', 'k-1.md', 'k-2.md', 'k-3.md', 'k-4.md'], 'pottery', T);
  await brain.mindTick({ now: iso(T) });
  await dissolveShelf('shelf/kiln.md');
  for (let i = 0; i < 5; i++) await brain.deleteMemory(`k-${i}.md`);
  await brain.mindTick({ now: iso(T + HOUR) });

  await seedShelf('shelf/bikes.md', ['b-0.md', 'b-1.md', 'b-2.md', 'b-3.md', 'b-4.md'], 'bicycle', T + 2 * DAY);
  const r = await brain.mindTick({ now: iso(T + 2 * DAY) });
  assert.equal(r.upserted, 1, 'a genuinely different cluster is a genuinely new pattern');
  assert.equal(r.revived, 0, 'the pottery pattern stays retired — nothing revived it');
  assert.equal((await brain.mindStatus()).patterns, 2, 'two patterns, honestly separate');
  const know = (await brain._internal.query(
    `SELECT filename FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows;
  assert.equal(know.length, 2, 'two knowledge rows — a bicycle never inherits pottery\'s history');
  await brain.close();
});

test('#18: a live pattern is never on offer — a cluster that SPLITS cannot steal the surviving half\'s identity', async () => {
  // Adoption only ever considers patterns no live candidate is carrying. A
  // split leaves the original shelf live (matchClusters hands it to the bigger
  // half), so the breakaway half must start its own life even though it shares
  // both evidence and subject with the original.
  await freshBrain();
  const T = Date.now();
  const all = ['s-0.md', 's-1.md', 's-2.md', 's-3.md', 's-4.md', 's-5.md'];
  await seedShelf('shelf/split.md', all, 'sourdough', T);
  assert.equal((await brain.mindTick({ now: iso(T) })).upserted, 1);

  // The original shelf survives on three members; three break away onto a new
  // shelf. Same subject, and the original pattern's refs still name all six.
  await setShelfMembers('shelf/split.md', all.slice(0, 3), 'sourdough', T + DAY);
  await seedShelf('shelf/split-2.md', all.slice(3), 'sourdough', T + DAY);
  const r = await brain.mindTick({ now: iso(T + DAY) });
  assert.equal(r.upserted, 1, 'the breakaway half is a new pattern, not a hijack of the original');
  assert.equal((await brain.mindStatus()).patterns, 2);
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

// ── elifant#16: the third-party inference guard ─────────────────────────────

test('#16 acceptance: a grievance corpus shelves as observations and promotes ZERO verdicts', async () => {
  await freshBrain();
  const T = Date.now();
  // Five keyholder-authored vents about a coworker — tier-1, backdated 9 days,
  // n=5, fresh: this corpus clears EVERY promotion gate. Before the guard it
  // hardened into pinned knowledge exactly like a garden.
  const gripes = [
    'Dave was late to standup again and the whole morning slipped',
    'Dave shipped the broken build again, he never runs the tests',
    'so tired of covering for Dave, he is impossible to plan around',
    'Dave talked over me for the entire retro meeting',
    'another Dave morning, he left the build red and went home',
  ];
  for (let i = 0; i < gripes.length; i++) {
    const fn = `gripe-${i}.md`;
    await brain.setMemory(fn, gripes[i], 'test', 'instance', nearVec(30, 31 + i));
    await backdate(fn, T - (4 - i) * 2.25 * DAY);
  }

  const r = await brain.keeperTick({ mind: { now: iso(T) } });
  // Observations still shelve — structure is allowed, verdicts are not.
  assert.equal(r.shelvesWritten, 1, 'the grievance cluster still shelves (an observation, receipted)');
  assert.equal(r.mind.upserted, 1, 'the pattern is seen and tracked');
  assert.equal(r.mind.promoted, 0, 'zero promoted verdicts about a third party');
  assert.equal(r.mind.guarded, 1, 'the guard is what held it — not the thresholds');

  // The shelf carries the third-party mark, machine-readably, in its content.
  const shelf = (await brain._internal.query(
    "SELECT content FROM memories WHERE synthesized_via = 'keeper/shelving-v1'")).rows[0];
  assert.match(shelf.content, /^about: a third party/m, 'the shelf says who it is about');
  assert.equal(brain.injectDisposition({ content: shelf.content, trust_tier: 'tier-2-synthesized' }), 'hold',
    'the marked shelf can never travel into an injected context block');

  // The floor is PERMANENT: gates zeroed out AND a plausible "guard off" flag
  // must change nothing (nothing reads cfg in the guard, by construction).
  const r2 = await brain.mindTick({ now: iso(T + 60000), promoteConf: 0, promoteN: 0, promoteAgeH: 0, guard: false });
  assert.equal(r2.promoted, 0, 'no dial reaches the floor');
  assert.equal(r2.guarded, 1);
  const know = (await brain._internal.query(
    `SELECT 1 FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows;
  assert.equal(know.length, 0, 'zero knowledge rows, ever');

  // The refusal is visible ONCE (K-CARBON-4: no silent ladder decisions), then quiet.
  const guards = await brain.getCaptures({ source: 'mind', type: 'guard' });
  assert.equal(guards.length, 1, 'one visible guard receipt, not a nag');
  assert.match(guards[0].data.text, /someone who isn't you/);
  assert.equal(guards[0].data.guard, 'third-party');
  await brain.mindTick({ now: iso(T + HOUR) });
  assert.equal((await brain.getCaptures({ source: 'mind', type: 'guard' })).length, 1, 'announced once');

  // Recall for the keyholder's own use is untouched: the raw memories are
  // live, unarchived, and readable by name — the guard gates INJECTION and
  // PROMOTION, never the keyholder's access to their own words.
  const raw = await brain.getMemory('gripe-2.md');
  assert.ok(raw && /covering for Dave/.test(raw.content), 'the keyholder keeps their own words');
  await brain.close();
});

test('#16: a keyholder\'s own first-person pattern still promotes — the guard reads subjects, not sentiment', async () => {
  await freshBrain();
  const T = Date.now();
  // Self-directed and even self-critical — but about the KEYHOLDER, so the
  // ladder must work exactly as before (the control for the guard).
  const notes = [
    'i was late to standup again this morning, third time',
    'i keep skipping the standup prep and it shows',
    'late again today, i need a standing alarm for standup',
    'i promised the team i would fix my standup timing',
    'made it to standup on time once this week, i have to do better',
  ];
  for (let i = 0; i < notes.length; i++) {
    const fn = `self-${i}.md`;
    await brain.setMemory(fn, notes[i], 'test', 'instance', nearVec(80, 81 + i));
    await backdate(fn, T - (4 - i) * 2.25 * DAY);
  }
  const r = await brain.keeperTick({ mind: { now: iso(T) } });
  assert.equal(r.mind.guarded, 0, 'no third-party signal — the guard stays out of the way');
  assert.equal(r.mind.promoted, 1, 'the keyholder\'s own pattern climbs exactly as before');
  await brain.close();
});

// ── elifant#17: crisis lexicon + permanent domain denylist ──────────────────

test('#17 acceptance: health/grief/finance corpora that clear every gate produce ZERO knowledge', async () => {
  await freshBrain();
  const T = Date.now();
  // Three clusters, one per denylisted domain — each tier-1, n=5, 9 days old,
  // fresh: every one clears every promotion gate on the numbers.
  const corpora = {
    health: [
      'the new medication dose is 20mg every morning',
      'therapist moved the session to thursdays',
      'blood pressure was high again at the checkup',
      'the specialist wants another biopsy before deciding',
      'sleep is wrecked, the insomnia is back every night',
    ],
    grief: [
      'the funeral is on saturday at ten',
      'mom passed away two years ago this week',
      'grief hits hardest in the evenings lately',
      'picked up the death certificate copies today',
      'the memorial service playlist still needs songs',
    ],
    finance: [
      'the credit card balance went up again this month',
      'still trying to afford the january rent',
      'the loan officer wants two more pay stubs',
      'payday is the 15th and the bills land on the 12th',
      'the overdraft fee hit twice this week',
    ],
  };
  let axis = 40;
  for (const [domain, notes] of Object.entries(corpora)) {
    for (let i = 0; i < notes.length; i++) {
      const fn = `${domain}-${i}.md`;
      await brain.setMemory(fn, notes[i], 'test', 'instance', nearVec(axis, axis + 1 + i));
      await backdate(fn, T - (4 - i) * 2.25 * DAY);
    }
    axis += 10;
  }
  const r = await brain.keeperTick({ mind: { now: iso(T) } });
  assert.equal(r.mind.upserted, 3, 'three clusters, three tracked patterns');
  assert.equal(r.mind.promoted, 0, 'zero promoted knowledge in denylisted domains');
  assert.equal(r.mind.guarded, 3, 'all three held by the domain floor');

  // The floor is PERMANENT: zeroed gates and plausible bypass flags change nothing.
  const r2 = await brain.mindTick({
    now: iso(T + 60000), promoteConf: 0, promoteN: 0, promoteAgeH: 0,
    guard: false, denylist: [], crisisLexicon: [],
  });
  assert.equal(r2.promoted, 0, 'no dial reaches the floor');
  assert.equal(r2.guarded, 3);
  assert.equal((await brain._internal.query(
    `SELECT count(*)::int AS n FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA])).rows[0].n, 0,
    'zero knowledge rows across all three domains');

  // Each refusal narrated once, naming its domain — then quiet.
  const guards = await brain.getCaptures({ source: 'mind', type: 'guard' });
  assert.equal(guards.length, 3);
  const reasons = guards.map((g) => g.data.guard).sort();
  assert.deepEqual(reasons, ['domain:finance', 'domain:grief', 'domain:health']);
  await brain.close();
});

test('#17: crisis content never shelves, never patterns — and a hand-built crisis shelf still cannot promote', async () => {
  await freshBrain();
  const T = Date.now();
  const dark = [
    'i keep thinking about ending my life',
    'wrote about wanting to hurt myself again tonight',
    'the suicidal thoughts were loud all day',
    'searched for overdose amounts, scared myself',
    'i do not want to be alive this week',
  ];
  for (let i = 0; i < dark.length; i++) {
    const fn = `dark-${i}.md`;
    await brain.setMemory(fn, dark[i], 'test', 'instance', nearVec(70, 71 + i));
    await backdate(fn, T - (4 - i) * 2.25 * DAY);
  }
  const r = await brain.keeperTick({ mind: { now: iso(T) } });
  assert.equal(r.shelvesWritten, 0, 'crisis content never blends into a derived row — the shelving override');
  assert.equal(r.mind.upserted, 0, 'no shelf, no pattern, no ladder');
  assert.equal((await brain._internal.query(
    'SELECT count(*)::int AS n FROM memories WHERE synthesized_via IS NOT NULL')).rows[0].n, 0,
    'zero derived rows of any kind');
  // The raw memories themselves are untouched — recallable, never held from
  // the keyholder's own explicit access.
  const raw = await brain.getMemory('dark-0.md');
  assert.ok(raw && raw.content.includes('ending my life'), 'the keyholder keeps their own words');
  // ...but they can never travel into an injected context block.
  assert.equal(brain.injectDisposition({ content: raw.content, trust_tier: raw.trust_tier }), 'hold');

  // Belt and braces: even a shelf hand-built around crisis content (bypassing
  // the keeper) never promotes, and the hold is SILENT — no guard capture
  // narrates a person's darkest sentence back at them.
  await seedShelf('shelf/dark.md', ['sd-0.md', 'sd-1.md', 'sd-2.md', 'sd-3.md', 'sd-4.md'], 'ending my life', T);
  const r2 = await brain.mindTick({ now: iso(T) });
  assert.equal(r2.promoted, 0, 'a crisis pattern never hardens');
  assert.ok(r2.guarded >= 1, 'held by the crisis floor');
  assert.equal((await brain.getCaptures({ source: 'mind' })).length, 0,
    'NO mind capture of any stage — a crisis hold is tracked, never narrated');
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

// ── elifant#6 follow-up: confirmDuplicate() — a keyholder's vouch counts as
// full promotion evidence, not raw member count ────────────────────────────

test('a keyholder-confirmed pair promotes at n=2 — an auto-shelf pair never could', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('rent-a.md', 'rent goes up to 1850 starting next month', 'test', 'instance', nearVec(150, 1));
  await brain.setMemory('rent-b.md', 'starting next month rent is 1850', 'test', 'instance', nearVec(150, 2));
  await backdate('rent-a.md', T - 9 * DAY);
  await backdate('rent-b.md', T - 2 * DAY); // born = the OLDER of the two, same rule as a shelf

  const { filename } = await brain.confirmDuplicate('rent-a.md', 'rent-b.md');
  assert.ok(filename.startsWith('confirmed/'), filename);

  const r = await brain.mindTick({ now: iso(T) });
  assert.equal(r.upserted, 1);
  assert.equal(r.promoted, 1, 'a direct vouch clears promoteN even though n=2 < 5');

  const know = (await brain._internal.query(
    `SELECT content, trust_tier, pinned FROM memories WHERE synthesized_via = $1`, [mind.MIND_VIA]
  )).rows;
  assert.equal(know.length, 1);
  assert.equal(know[0].pinned, true);
  assert.match(know[0].content, /you confirmed/);

  // Sources: still exactly two, still untouched, still tier-1.
  const sources = (await brain._internal.query(
    "SELECT filename, synthesized_via, trust_tier FROM memories WHERE filename IN ('rent-a.md','rent-b.md')"
  )).rows;
  assert.equal(sources.length, 2);
  assert.ok(sources.every((s) => s.synthesized_via === null && s.trust_tier === 'tier-1-keyholder-direct'));
  await brain.close();
});

test('confirmDuplicate: fresh (same-day) memories still fail the 24h age floor — no snap-decision shortcut', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('fresh-a.md', 'the wifi password is on the fridge', 'test', 'instance', nearVec(151, 1));
  await brain.setMemory('fresh-b.md', 'the fridge has the wifi password on it', 'test', 'instance', nearVec(151, 2));
  // No backdate — both are ~now, so age is ~0h regardless of the confirmation.
  await brain.confirmDuplicate('fresh-a.md', 'fresh-b.md');
  const r = await brain.mindTick({ now: iso(T) });
  assert.equal(r.promoted, 0, 'the vouch skips the recurrence requirement, not the cooling-off period');
  assert.equal(r.upserted, 1, 'it is still tracked, just forming');
  await brain.close();
});

test('confirmDuplicate: refuses crisis-lexicon content outright — never even an observation', async () => {
  await freshBrain();
  await brain.setMemory('dark-a.md', 'been thinking about suicide again', 'test', 'instance', nearVec(152, 1));
  await brain.setMemory('dark-b.md', 'still thinking about suicide', 'test', 'instance', nearVec(152, 2));
  await assert.rejects(
    () => brain.confirmDuplicate('dark-a.md', 'dark-b.md'),
    /crisis-lexicon/
  );
  assert.equal((await brain._internal.query(
    "SELECT count(*)::int AS n FROM memories WHERE synthesized_via IS NOT NULL")).rows[0].n, 0,
    'no derived row was written');
  await brain.close();
});

test('confirmDuplicate: refuses a filename that is not a live tier-1 row', async () => {
  await freshBrain();
  await brain.setMemory('solo.md', 'a lone memory', 'test', 'instance', nearVec(153, 1));
  await assert.rejects(() => brain.confirmDuplicate('solo.md', 'nonexistent.md'), /live, tier-1/);
  await brain.deleteMemory('solo.md');
  await brain.setMemory('solo2.md', 'another lone memory', 'test', 'instance', nearVec(153, 2));
  await assert.rejects(() => brain.confirmDuplicate('solo.md', 'solo2.md'), /live, tier-1/,
    'a tombstoned filename is not eligible either');
  await brain.close();
});

test('#16/#17 still apply to a confirmed pair: your vouch does not bypass the Guard, only the recurrence gate', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('debt-a.md', 'still paying off the credit card debt', 'test', 'instance', nearVec(154, 1));
  await brain.setMemory('debt-b.md', 'the credit card debt is still not paid off', 'test', 'instance', nearVec(154, 2));
  await backdate('debt-a.md', T - 9 * DAY);
  await backdate('debt-b.md', T - 2 * DAY);
  await brain.confirmDuplicate('debt-a.md', 'debt-b.md');

  const r = await brain.mindTick({ now: iso(T) });
  assert.equal(r.promoted, 0, 'finance-domain content never hardens, confirmed or not');
  assert.ok(r.guarded >= 1);
  await brain.close();
});

test('a confirmed pattern decays honestly when one confirmed member is deleted', async () => {
  await freshBrain();
  const T = Date.now();
  await brain.setMemory('note-a.md', 'the garage code is 4471', 'test', 'instance', nearVec(155, 1));
  await brain.setMemory('note-b.md', 'garage code: 4471', 'test', 'instance', nearVec(155, 2));
  await backdate('note-a.md', T - 9 * DAY);
  await backdate('note-b.md', T - 2 * DAY);
  await brain.confirmDuplicate('note-a.md', 'note-b.md');
  const r1 = await brain.mindTick({ now: iso(T) });
  assert.equal(r1.promoted, 1);

  // One of the two confirmed sources is deleted — the boosted n=5 must not
  // survive on a producer row that no longer has 2 live members to boost.
  // n is pinned at the real count (1) from here on, so confidence can only
  // fall through recency decay — wait long enough past note-b's own
  // updated_at for that alone to clear the retirement floor.
  await brain.deleteMemory('note-a.md');
  const r2 = await brain.mindTick({ now: iso(T + 10 * DAY) });
  assert.equal(r2.retired, 1, 'live evidence dropped to 1 (< CONFIRMED_MIN_N) — real n, not the boosted one, decides');
  await brain.close();
});
