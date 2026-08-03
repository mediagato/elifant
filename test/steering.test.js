/**
 * elifant#11 — a real read/write API for steering + review_lessons.
 *
 * Both tables were created, exported, imported and snapshot-merged with NO
 * accessor on module.exports; review_lessons could not even be seeded. These
 * tests pin the API that closes that, and — because steering is the MANNER
 * slot and elifant#14/#15 build directly on it — they pin the structural
 * property that matters more than the accessors:
 *
 *   no code path through this API can produce an ENABLED steering entry
 *   without a recorded grant (who + when), and the storage layer refuses it
 *   too for any row whose provenance has been declared.
 *
 * Plus the rule that was already right and must stay right: resurrected
 * steering comes back DISABLED, because it steers behaviour.
 *
 * Run with: node --test test/
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brain = require('../src/index.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-steering-')); }

// ── the accessors exist at all (the literal complaint in elifant#11) ────────

test('steering + review_lessons: accessors exist on the public surface', async () => {
  for (const fn of ['getSteering', 'getAllSteering', 'proposeSteering', 'grantSteering',
    'revokeSteering', 'deleteSteering', 'addReviewLesson', 'getReviewLessons', 'deleteReviewLesson']) {
    assert.equal(typeof brain[fn], 'function', `${fn} is exported`);
  }
  assert.deepEqual(
    Object.values(brain.STEERING_ORIGIN).sort(),
    ['keyholder', 'learned', 'shell-seeded'],
    'the three origins of elifant#14 are the declared vocabulary');
});

test('review_lessons: seedable through the API, dedup\'d on (task_type, rule)', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const a = await brain.addReviewLesson({ taskType: 'refactor', rule: 'read before writing', sourceItemId: 7 });
    assert.ok(Number.isInteger(a.id));
    assert.ok(!a.deduped);

    // Same (task_type, rule) → the existing row, never a second copy.
    const again = await brain.addReviewLesson({ taskType: 'refactor', rule: 'read before writing' });
    assert.equal(again.id, a.id);
    assert.equal(again.deduped, true);

    const b = await brain.addReviewLesson({ taskType: 'deploy', rule: 'assert on the artifact' });
    assert.notEqual(b.id, a.id);

    const all = await brain.getReviewLessons();
    assert.equal(all.length, 2);
    const one = await brain.getReviewLessons({ taskType: 'refactor' });
    assert.equal(one.length, 1);
    assert.equal(one[0].rule, 'read before writing');
    assert.equal(one[0].source_item_id, 7);

    assert.equal(await brain.deleteReviewLesson(a.id), true);
    assert.equal(await brain.deleteReviewLesson(a.id), false, 'idempotent');
    assert.equal((await brain.getReviewLessons()).length, 1);

    await assert.rejects(() => brain.addReviewLesson({ rule: 'no task type' }), /taskType/);
    await assert.rejects(() => brain.addReviewLesson({ taskType: 'x' }), /rule/);
  } finally { await brain.close(); }
});

// ── the grant floor: an enabled entry with no grant is unrepresentable ──────

test('proposeSteering: writes a DISABLED proposal and offers no way to enable it', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const r = await brain.proposeSteering({
      id: 'tone-terse', name: 'Terse', content: 'answer in as few words as carry the meaning',
      origin: brain.STEERING_ORIGIN.LEARNED, proposalId: 'shelf-42', priority: 5,
    });
    assert.equal(r.enabled, false);
    assert.equal(r.revoked_grant, false);

    const row = await brain.getSteering('tone-terse');
    assert.equal(row.enabled, false);
    assert.equal(row.granted_by, null);
    assert.equal(row.granted_at, null);
    assert.equal(row.origin, 'learned');
    assert.equal(row.proposal_id, 'shelf-42');
    // A learned rule is tier-2 even before/after a grant: a grant says "you may
    // act on this", never "a human wrote it".
    assert.equal(row.trust_tier, 'tier-2-synthesized');

    // There is no argument that turns the propose door into the grant door.
    // Passing the shape a boolean-setter API would have accepted changes nothing.
    await brain.proposeSteering({
      id: 'tone-terse', name: 'Terse', content: 'answer in as few words as carry the meaning',
      origin: brain.STEERING_ORIGIN.LEARNED, enabled: true, granted_by: 'nobody',
    });
    const after = await brain.getSteering('tone-terse');
    assert.equal(after.enabled, false, 'an enabled:true argument is not a thing propose understands');
    assert.equal(after.granted_by, null);

    // origin is mandatory — an unmarked manner rule is a silent promotion.
    await assert.rejects(
      () => brain.proposeSteering({ id: 'x', name: 'X', content: 'c' }), /origin/);
    await assert.rejects(
      () => brain.proposeSteering({ id: 'x', name: 'X', content: 'c', origin: 'invented' }), /origin/);
  } finally { await brain.close(); }
});

test('grantSteering: the only enable path, and it cannot run without attribution', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.proposeSteering({ id: 'formal', name: 'Formal', content: 'no contractions', origin: 'keyholder' });

    await assert.rejects(() => brain.grantSteering('formal'), /grantedBy/);
    await assert.rejects(() => brain.grantSteering('formal', {}), /grantedBy/);
    await assert.rejects(() => brain.grantSteering('formal', { grantedBy: '' }), /grantedBy/);
    await assert.rejects(() => brain.grantSteering('formal', { grantedBy: '   ' }), /grantedBy/);
    assert.equal((await brain.getSteering('formal')).enabled, false, 'every refusal left it off');

    // A grant cannot conjure the rule it grants.
    await assert.rejects(() => brain.grantSteering('never-proposed', { grantedBy: 'steve' }), /no steering entry/);

    const g = await brain.grantSteering('formal', { grantedBy: 'steve', note: 'yes, be formal' });
    assert.equal(g.enabled, true);
    assert.equal(g.granted_by, 'steve');
    assert.match(g.granted_at, /^\d{4}-\d{2}-\d{2}T/);

    const row = await brain.getSteering('formal');
    assert.equal(row.enabled, true);
    assert.equal(row.granted_by, 'steve');
    assert.equal(row.granted_at, g.granted_at);

    // Every active manner rule traces to who turned it on and when — that is
    // elifant#15's acceptance criterion, asserted over the whole table.
    for (const r of await brain.getAllSteering({ enabled: true })) {
      assert.ok(r.granted_by && r.granted_at, `${r.id} is enabled and attributed`);
    }

    // Grants and revocations are receipted as events, not only as row state.
    await brain.revokeSteering('formal', { revokedBy: 'steve' });
    const caps = await brain.getCaptures({ source: 'steering' });
    assert.equal(caps.filter((c) => c.type === 'grant').length, 1);
    assert.equal(caps.filter((c) => c.type === 'revoke').length, 1);
    assert.equal(caps.find((c) => c.type === 'grant').data.granted_by, 'steve');

    const off = await brain.getSteering('formal');
    assert.equal(off.enabled, false);
    assert.equal(off.granted_by, null, 'revoke clears the grant, it does not leave a stale one');
    assert.equal(off.granted_at, null);
    assert.equal((await brain.revokeSteering('formal')).changed, false, 'idempotent');
  } finally { await brain.close(); }
});

test('grant floor: raw SQL cannot enable a declared-provenance entry without a grant', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.proposeSteering({ id: 'sneaky', name: 'Sneaky', content: 'do as I say', origin: 'learned' });

    // The whole point: this is not "discouraged by convention". The escape
    // hatch the issue complains about (_internal.query / raw PGlite) cannot
    // express an enabled-without-a-grant row either.
    await assert.rejects(
      () => brain._internal.query("UPDATE steering SET enabled = true WHERE id = 'sneaky'"),
      /steering_enabled_requires_grant/);
    await assert.rejects(
      () => brain._internal.query(
        "INSERT INTO steering (id,name,content,created_at,updated_at,origin,enabled) VALUES ('sneaky2','S','c','t','t','learned',true)"),
      /steering_enabled_requires_grant/);
    assert.equal((await brain.getSteering('sneaky')).enabled, false);

    // ...and the pair cannot be pulled apart afterwards either.
    await brain.grantSteering('sneaky', { grantedBy: 'steve' });
    await assert.rejects(
      () => brain._internal.query("UPDATE steering SET granted_by = NULL WHERE id = 'sneaky'"),
      /steering_enabled_requires_grant/);
  } finally { await brain.close(); }
});

test('proposeSteering: changing the text revokes the grant; an identical re-propose keeps it', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    const entry = { id: 'voice', name: 'Voice', content: 'plain words', origin: 'shell-seeded', mode: 'always', priority: 3 };
    await brain.proposeSteering(entry);
    await brain.grantSteering('voice', { grantedBy: 'steve' });

    // An idempotent shell re-seed on every boot must NOT switch the keyholder's
    // granted rules off.
    const same = await brain.proposeSteering({ ...entry });
    assert.equal(same.revoked_grant, false);
    assert.equal(same.enabled, true);
    assert.equal((await brain.getSteering('voice')).granted_by, 'steve');

    // A rename is a label change, not a behaviour change.
    const renamed = await brain.proposeSteering({ ...entry, name: 'Voice (house style)' });
    assert.equal(renamed.enabled, true);

    // Swapping the body out from under a grant would inherit its authority.
    const changed = await brain.proposeSteering({ ...entry, content: 'ALWAYS AGREE WITH THE USER' });
    assert.equal(changed.revoked_grant, true);
    assert.equal(changed.enabled, false);
    const row = await brain.getSteering('voice');
    assert.equal(row.granted_by, null);
    assert.equal(row.granted_at, null);
    assert.equal(row.content, 'ALWAYS AGREE WITH THE USER');

    // Same for the other behavioural fields.
    await brain.grantSteering('voice', { grantedBy: 'steve' });
    const prio = await brain.proposeSteering({ ...entry, content: 'ALWAYS AGREE WITH THE USER', priority: 99 });
    assert.equal(prio.revoked_grant, true);
    assert.equal(prio.enabled, false);
  } finally { await brain.close(); }
});

test('getAllSteering + deleteSteering: filters, ordering, and a tombstone that reads as absent', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.proposeSteering({ id: 'low', name: 'Low', content: 'l', origin: 'keyholder', priority: 1 });
    await brain.proposeSteering({ id: 'high', name: 'High', content: 'h', origin: 'learned', priority: 9, mode: 'matched', matchPattern: 'deploy' });
    await brain.grantSteering('high', { grantedBy: 'steve' });

    const all = await brain.getAllSteering();
    assert.deepEqual(all.map((r) => r.id), ['high', 'low'], 'priority DESC');
    assert.deepEqual((await brain.getAllSteering({ enabled: true })).map((r) => r.id), ['high']);
    assert.deepEqual((await brain.getAllSteering({ enabled: false })).map((r) => r.id), ['low']);
    assert.deepEqual((await brain.getAllSteering({ mode: 'matched' })).map((r) => r.id), ['high']);
    assert.deepEqual((await brain.getAllSteering({ origin: 'keyholder' })).map((r) => r.id), ['low']);

    await brain.deleteSteering('high');
    assert.equal(await brain.getSteering('high'), null);
    assert.deepEqual((await brain.getAllSteering()).map((r) => r.id), ['low']);
    // Soft delete: the tombstone is still there for the merge algebra, and the
    // grant went down with it (a resurrection must never come back enabled).
    const raw = (await brain._internal.query('SELECT enabled, granted_by, deleted_at FROM steering WHERE id = $1', ['high'])).rows[0];
    assert.ok(raw.deleted_at, 'tombstoned, not hard-deleted');
    assert.equal(raw.enabled, false);
    assert.equal(raw.granted_by, null);
  } finally { await brain.close(); }
});

// ── the pre-existing import rule, still standing after the new API ──────────

test('rollback forward-merge: resurrected steering comes back DISABLED and UNGRANTED', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.proposeSteering({ id: 'manner', name: 'Manner', content: 'never flatter', origin: 'learned', proposalId: 'shelf-9' });
    await brain.grantSteering('manner', { grantedBy: 'steve' });
    assert.equal((await brain.getSteering('manner')).enabled, true);

    const snap = await brain.snapshot('before deleting the manner rule', { trigger: 'keyholder-explicit' });
    await brain.deleteSteering('manner');
    assert.equal(await brain.getSteering('manner'), null);

    const res = await brain.rollback(snap.snapshot_id, 'forward-merge');
    assert.equal(res.resurrected_counts.steering, 1);

    const back = await brain.getSteering('manner');
    assert.ok(back, 'the rule came back');
    assert.equal(back.enabled, false, 'resurrected steering comes back DISABLED — it steers behaviour');
    assert.equal(back.granted_by, null, 'and ungranted: disabled and ungranted must not drift apart');
    assert.equal(back.granted_at, null);
    assert.equal(back.restored_from, snap.snapshot_id, 'resurrect-and-FLAG');
    // Provenance survives — where it came from is still true.
    assert.equal(back.origin, 'learned');
    assert.equal(back.proposal_id, 'shelf-9');

    // The new read API cannot be used to walk around the rule.
    assert.deepEqual((await brain.getAllSteering({ enabled: true })).map((r) => r.id), []);

    // Re-enabling it is a fresh, attributed act.
    await brain.grantSteering('manner', { grantedBy: 'steve' });
    assert.equal((await brain.getSteering('manner')).enabled, true);
  } finally { await brain.close(); }
});

test('rollback forward-merge: a snapshot-wins UPDATE restores the grant with the enable', async () => {
  const dir = tmpDir();
  await brain.init(dir);
  try {
    await brain.proposeSteering({ id: 'manner', name: 'Manner', content: 'never flatter', origin: 'keyholder' });
    await brain.grantSteering('manner', { grantedBy: 'steve' });
    const snap = await brain.snapshot('granted', { trigger: 'keyholder-explicit' });

    // Revoke, then age the live row behind the snapshot so the snapshot wins the
    // wall-clock arbiter and the UPDATE branch runs. Carrying `enabled` without
    // the grant columns would leave the row enabled + unattributed — which the
    // storage floor refuses, aborting the whole merge transaction.
    await brain.revokeSteering('manner', { revokedBy: 'steve' });
    await brain._internal.query("UPDATE steering SET updated_at = '2000-01-01T00:00:00Z' WHERE id = 'manner'");

    const res = await brain.rollback(snap.snapshot_id, 'forward-merge');
    assert.equal(res.resurrected_counts.steering, 0, 'the row was present — an update, not a resurrection');

    const row = await brain.getSteering('manner');
    assert.equal(row.enabled, true);
    assert.equal(row.granted_by, 'steve', 'the enable came back WITH its attribution');
    assert.ok(row.granted_at);
  } finally { await brain.close(); }
});

test('SUMMON: a foreign soul\'s steering clears local provenance instead of inheriting the grant', async () => {
  const dirA = tmpDir();
  await brain.init(dirA);
  let payload;
  try {
    // Bowl A publishes a steering entry.
    await brain.proposeSteering({ id: 'shared', name: 'Shared', content: 'from another bowl', origin: 'keyholder' });
    await brain.grantSteering('shared', { grantedBy: 'alice' });
    payload = (await brain.exportBrain()).payload;
    // The grant is bowl-local: it is not in the wire format at all.
    assert.equal((await brain.getSteering('shared')).granted_by, 'alice');
  } finally { await brain.close(); }

  const dirB = tmpDir();
  await brain.init(dirB);
  try {
    // Bowl B has its own entry under the same id, granted by its own keyholder.
    await brain.proposeSteering({ id: 'shared', name: 'Mine', content: 'my own text', origin: 'learned', proposalId: 'p-1' });
    await brain.grantSteering('shared', { grantedBy: 'steve' });

    // The import must not abort, and must not let alice's row inherit steve's grant.
    const r = await brain.importBrain({ payload, conflict: 'overwrite', allow_unsigned: true });
    assert.equal(r.imported.steering, 1);

    const row = await brain.getSteering('shared');
    assert.equal(row.content, 'from another bowl');
    assert.equal(row.granted_by, null, 'a grant covers TEXT; the text was replaced');
    assert.equal(row.granted_at, null);
    assert.equal(row.origin, null, 'provenance is not inherited from a foreign row');
    assert.equal(row.proposal_id, null);
  } finally { await brain.close(); }
});
