/**
 * elifant#15 — learned steering must be proposed, never self-applied.
 *
 * #11 already built the mechanical guarantee this issue's acceptance
 * criterion asks for: proposeSteering() cannot enable a rule under any
 * argument, grantSteering() is the only writer of enabled=true and requires
 * grantedBy, and the storage-layer CHECK constraint holds even against raw
 * SQL. See test/steering.test.js for those.
 *
 * What #11 explicitly did NOT build is the PATH that notices a manner
 * mismatch and turns it into a proposal in the first place. This file tests
 * that path: keeper.js's new pass over the existing pair ledger (elifant#6/
 * #7's "same project" = a strict-floor pair), which notices when the same
 * pair has stood open, unresolved, and un-acted-upon for
 * MANNER_MISMATCH_MIN_TICKS ticks running, and turns that into (a) a DISABLED
 * proposeSteering() proposal and (b) a needs-decision Bell item carrying the
 * receipts that prompted it — never anything enabled, never anything silent.
 *
 * Run with: node --test test/manner-mismatch.test.js
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

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'manner-mismatch-')); }

function normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}
function axisVec(axis, weight = 1.0) {
  const v = new Array(DIM).fill(0);
  v[axis] = weight;
  return v;
}
// A vector near axis `axis`, tilted toward axis `tilt` by `eps` — lands well
// inside SHELF_EDGE_FLOOR (0.12), same recipe as keeper.test.js.
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

// Ticks a still-open, UNCHANGED pair `n` times and returns the receipts.
async function tickTimes(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await brain.keeperTick({ mind: false }));
  return out;
}

// ── the pure prompt helper ───────────────────────────────────────────────────

test('mannerMismatchPrompt: describes the observation, offers a choice, never scolds', () => {
  const p = keeper.mannerMismatchPrompt('pay-a.md', 'pay-b.md', 'near-dup', 6, '2026-07-28');
  assert.match(p, /pay-a\.md/);
  assert.match(p, /pay-b\.md/);
  assert.match(p, /2026-07-28/);
  assert.match(p, /6/);
  assert.ok(!/wrong|mistake|should have|ignored you|fault/i.test(p),
    'never implies the keyholder did something wrong by leaving it open');
  assert.match(p, /\?/, 'offers a choice, does not just assert a verdict');
});

// ── the threshold: exactly MANNER_MISMATCH_MIN_TICKS, not one tick sooner ──

test('elifant#15: a pair open and unchanged for MANNER_MISMATCH_MIN_TICKS ticks proposes — never before', async () => {
  await freshBrain();
  try {
    await brain.setMemory('proj-a.md', 'the widget migration needs another pass', 'test', 'instance', nearVec(300, 1));
    await brain.setMemory('proj-b.md', 'another pass needed on the widget migration', 'test', 'instance', nearVec(300, 2));

    const n = keeper.MANNER_MISMATCH_MIN_TICKS;
    assert.ok(n >= 2, 'sanity: the threshold is a real number, not accidentally 0/1');

    const receipts = await tickTimes(n - 1);
    for (const r of receipts) assert.equal(r.mannerMismatches, 0, 'below threshold: never proposes');
    assert.equal(await brain.getSteering(keeper.MANNER_STEERING_ID), null,
      'no proposal exists before the pair has stood open long enough');

    const last = await brain.keeperTick({ mind: false }); // the Nth tick
    assert.equal(last.mannerMismatches, 1, 'crossing the threshold proposes exactly once');

    const row = await brain.getSteering(keeper.MANNER_STEERING_ID);
    assert.ok(row, 'a steering PROPOSAL now exists');
    assert.equal(row.enabled, false, 'proposeSteering can never write an enabled row');
    assert.equal(row.origin, 'learned');
    assert.equal(row.granted_by, null);
    assert.equal(row.granted_at, null);
    assert.equal(row.content, keeper.MANNER_STEERING_CONTENT);

    const nd = await brain.getCaptures({ type: 'needs-decision' });
    const mm = nd.filter((c) => c.data.kind === 'manner-mismatch');
    assert.equal(mm.length, 1);
    assert.equal(mm[0].source, 'keeper');
    // Receipts: which project, how many nudges, over what period.
    assert.deepEqual([mm[0].data.receipts.files[0], mm[0].data.receipts.files[1]].sort(),
      ['proj-a.md', 'proj-b.md']);
    assert.equal(mm[0].data.receipts.askCount, n);
    assert.ok(mm[0].data.receipts.firstSeen);
    assert.ok(mm[0].data.receipts.lastSeen);
    assert.equal(mm[0].data.receipts.underlyingKind, 'near-dup');
    assert.equal(mm[0].data.steeringId, keeper.MANNER_STEERING_ID);
    assert.ok(mm[0].data.proposalId, 'traceable back to the evidence that suggested it');
    assert.match(mm[0].data.prompt, /proj-a\.md/);
    assert.match(mm[0].data.prompt, /proj-b\.md/);

    // The original near-dup Bell item (elifant#6) still exists too — the
    // manner-mismatch notice is IN ADDITION to it, never a replacement.
    assert.equal(nd.filter((c) => c.data.kind === 'near-dup').length, 1);
  } finally { await brain.close(); }
});

test('elifant#15: does not re-propose every tick after crossing — asked once per occurrence', async () => {
  await freshBrain();
  try {
    await brain.setMemory('rep-a.md', 'the invoice numbering is inconsistent', 'test', 'instance', nearVec(310, 1));
    await brain.setMemory('rep-b.md', 'invoice numbering inconsistent, still', 'test', 'instance', nearVec(310, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    assert.equal((await brain.getCaptures({ type: 'needs-decision' })).filter((c) => c.data.kind === 'manner-mismatch').length, 1);

    // Three more ticks, pair still open and unchanged.
    const more = await tickTimes(3);
    for (const r of more) assert.equal(r.mannerMismatches, 0, 'no re-ask while the same occurrence stands');
    assert.equal((await brain.getCaptures({ type: 'needs-decision' })).filter((c) => c.data.kind === 'manner-mismatch').length, 1,
      'still exactly one manner-mismatch Bell item');
  } finally { await brain.close(); }
});

test('elifant#15: a content edit resets the count — an edit is an act, not a silent ignore', async () => {
  await freshBrain();
  try {
    await brain.setMemory('edit-a.md', 'the release notes draft is stale', 'test', 'instance', nearVec(320, 1));
    await brain.setMemory('edit-b.md', 'stale release notes draft, still', 'test', 'instance', nearVec(320, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS - 1); // one short of the threshold

    // The keyholder edits one side — this IS an action, so the streak breaks.
    await brain.setMemory('edit-b.md', 'release notes draft was rewritten today', 'test', 'instance', nearVec(320, 2));

    const r1 = await brain.keeperTick({ mind: false });
    assert.equal(r1.mannerMismatches, 0, 'a fresh occurrence starts its count over'); // askCount = 1

    // It takes a FULL fresh run of the threshold from here, not one more tick:
    // r1 already spent one tick of the new streak, so MANNER_MISMATCH_MIN_TICKS-2
    // more must stay quiet, and the NEXT one after that is the one that crosses.
    const rest = await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS - 2);
    for (const r of rest) assert.equal(r.mannerMismatches, 0);
    const cross = await brain.keeperTick({ mind: false });
    assert.equal(cross.mannerMismatches, 1, 'the reset streak still eventually crosses on its own schedule');
  } finally { await brain.close(); }
});

// ── grant: the keyholder's own act, correctly attributed ────────────────────

test('elifant#15: grantSteering resolves the proposal with real attribution; further ticks stay quiet', async () => {
  await freshBrain();
  try {
    await brain.setMemory('grant-a.md', 'the onboarding doc needs a rewrite', 'test', 'instance', nearVec(330, 1));
    await brain.setMemory('grant-b.md', 'onboarding doc rewrite needed', 'test', 'instance', nearVec(330, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);

    const mm = (await brain.getCaptures({ type: 'needs-decision' })).find((c) => c.data.kind === 'manner-mismatch');
    assert.ok(mm);
    const { proposalId, steeringId } = mm.data;

    const g = await brain.grantSteering(steeringId, { grantedBy: 'steve', proposalId, note: 'yes, be more direct' });
    assert.equal(g.enabled, true);
    assert.equal(g.granted_by, 'steve');

    const row = await brain.getSteering(steeringId);
    assert.equal(row.enabled, true);
    assert.equal(row.granted_by, 'steve');
    assert.ok(row.granted_at);
    assert.equal(row.proposal_id, proposalId, 'the enabled rule traces back to the exact occurrence that proposed it');

    // elifant#15's acceptance criterion, restated over the live table: every
    // active manner rule traces to who turned it on and when.
    for (const s of await brain.getAllSteering({ enabled: true })) {
      assert.ok(s.granted_by && s.granted_at, `${s.id} is enabled and attributed`);
    }

    // Further ticks over the SAME still-open pair must not re-ask — the
    // keyholder already answered.
    const more = await tickTimes(3);
    for (const r of more) assert.equal(r.mannerMismatches, 0, 'granted — no further nagging');
    assert.equal((await brain.getCaptures({ type: 'needs-decision' })).filter((c) => c.data.kind === 'manner-mismatch').length, 1);
  } finally { await brain.close(); }
});

test('elifant#15: once granted, a DIFFERENT later occurrence does not re-ask (already-enabled short-circuit)', async () => {
  await freshBrain();
  try {
    await brain.setMemory('first-a.md', 'the changelog format keeps drifting', 'test', 'instance', nearVec(340, 1));
    await brain.setMemory('first-b.md', 'changelog format drifting again', 'test', 'instance', nearVec(340, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    const first = (await brain.getCaptures({ type: 'needs-decision' })).find((c) => c.data.kind === 'manner-mismatch');
    await brain.grantSteering(first.data.steeringId, { grantedBy: 'steve' });

    // A wholly separate pair, unrelated content, on its own embedding axis.
    await brain.setMemory('second-a.md', 'the deploy checklist is out of date', 'test', 'instance', nearVec(350, 1));
    await brain.setMemory('second-b.md', 'deploy checklist out of date again', 'test', 'instance', nearVec(350, 2));
    const receipts = await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    for (const r of receipts) assert.equal(r.mannerMismatches, 0,
      'the rule is already granted — a second occurrence is not a fresh question');

    assert.equal((await brain.getCaptures({ type: 'needs-decision' })).filter((c) => c.data.kind === 'manner-mismatch').length, 1,
      'still only the first ask ever happened');
  } finally { await brain.close(); }
});

// ── decline: nothing is ever enabled, and a decline does not silence the future ──

test('elifant#15: decline (tombstone the proposal) never enables anything, and the same occurrence is not re-asked', async () => {
  await freshBrain();
  try {
    await brain.setMemory('dec-a.md', 'the pricing page copy is out of date', 'test', 'instance', nearVec(360, 1));
    await brain.setMemory('dec-b.md', 'pricing page copy out of date, again', 'test', 'instance', nearVec(360, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    const mm = (await brain.getCaptures({ type: 'needs-decision' })).find((c) => c.data.kind === 'manner-mismatch');
    assert.ok(mm);

    // Decline: nothing is written as enabled — the proposal is simply
    // withdrawn (a tombstone, exactly like any other steering deletion).
    await brain.deleteSteering(mm.data.steeringId);
    assert.equal(await brain.getSteering(mm.data.steeringId), null, 'reads as absent');
    const raw = (await brain._internal.query(
      'SELECT enabled, granted_by, deleted_at FROM steering WHERE id = $1', [mm.data.steeringId]
    )).rows[0];
    assert.ok(raw.deleted_at, 'tombstoned, not hard-deleted — the ledger keeps the receipt');
    assert.equal(raw.enabled, false);
    assert.equal(raw.granted_by, null);

    // The SAME occurrence (pair unchanged) must not be re-asked — a decline
    // is a decision, and re-nagging about it would be exactly the failure
    // mode this issue exists to prevent.
    const more = await tickTimes(3);
    for (const r of more) assert.equal(r.mannerMismatches, 0, 'a decline sticks for this occurrence');
    assert.equal((await brain.getCaptures({ type: 'needs-decision' })).filter((c) => c.data.kind === 'manner-mismatch').length, 1);
  } finally { await brain.close(); }
});

test('elifant#15: a decline does not silence a genuinely later, unrelated occurrence', async () => {
  await freshBrain();
  try {
    await brain.setMemory('decfut-a.md', 'the support macro wording is off', 'test', 'instance', nearVec(370, 1));
    await brain.setMemory('decfut-b.md', 'support macro wording off, still', 'test', 'instance', nearVec(370, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    const first = (await brain.getCaptures({ type: 'needs-decision' })).find((c) => c.data.kind === 'manner-mismatch');
    await brain.deleteSteering(first.data.steeringId); // decline

    // A different pair, unrelated, later crosses the same threshold — the
    // keyholder's earlier decline was about that evidence, not a permanent ban.
    await brain.setMemory('fresh-a.md', 'the api rate limit docs are wrong', 'test', 'instance', nearVec(380, 1));
    await brain.setMemory('fresh-b.md', 'api rate limit docs wrong, still', 'test', 'instance', nearVec(380, 2));
    const receipts = await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    assert.equal(receipts[receipts.length - 1].mannerMismatches, 1, 'a later, distinct occurrence gets asked fresh');

    const second = (await brain.getCaptures({ type: 'needs-decision' }))
      .filter((c) => c.data.kind === 'manner-mismatch');
    assert.equal(second.length, 2, 'the declined ask and the fresh ask both stand');
    const row = await brain.getSteering(keeper.MANNER_STEERING_ID);
    assert.equal(row.enabled, false, 'the fresh re-propose is STILL disabled — a decline never leaves a live rule behind');
  } finally { await brain.close(); }
});

// ── the structural negative: this code cannot self-grant, by any argument ──

test('elifant#15 NEGATIVE: smuggling enabled:true into the exact propose payload keeper.js sends still lands disabled', async () => {
  await freshBrain();
  try {
    // This is the identical shape the manner-mismatch pass in keeper.js hands
    // to proposeSteering — plus an enabled:true field, as if a bug (or a
    // deliberately weakened copy of this code) tried to smuggle a self-grant
    // through the ONE door this whole feature is allowed to use.
    const r = await brain.proposeSteering({
      id: keeper.MANNER_STEERING_ID,
      name: keeper.MANNER_STEERING_NAME,
      content: keeper.MANNER_STEERING_CONTENT,
      mode: 'always',
      layer: 'instance',
      origin: 'learned',
      proposalId: 'attempted-self-grant',
      enabled: true,       // <- the attempted bypass
      granted_by: 'nobody', // <- and this one
    });
    assert.equal(r.enabled, false, 'proposeSteering structurally ignores an enabled argument — not a convention, a fact about the function');
    const row = await brain.getSteering(keeper.MANNER_STEERING_ID);
    assert.equal(row.enabled, false);
    assert.equal(row.granted_by, null);
  } finally { await brain.close(); }
});

test('elifant#15 NEGATIVE: raw SQL cannot enable the manner-mismatch proposal without a grant either', async () => {
  await freshBrain();
  try {
    await brain.setMemory('sql-a.md', 'the backup retention policy is unclear', 'test', 'instance', nearVec(145, 1));
    await brain.setMemory('sql-b.md', 'backup retention policy unclear, still', 'test', 'instance', nearVec(145, 2));
    await tickTimes(keeper.MANNER_MISMATCH_MIN_TICKS);
    assert.equal((await brain.getSteering(keeper.MANNER_STEERING_ID)).enabled, false);

    // Same escape hatch #11's own grant-floor test exercises, aimed at the
    // exact row this feature writes: the storage-layer CHECK constraint does
    // not care who is asking.
    await assert.rejects(
      () => brain._internal.query(`UPDATE steering SET enabled = true WHERE id = $1`, [keeper.MANNER_STEERING_ID]),
      /steering_enabled_requires_grant/);
    assert.equal((await brain.getSteering(keeper.MANNER_STEERING_ID)).enabled, false);
  } finally { await brain.close(); }
});
