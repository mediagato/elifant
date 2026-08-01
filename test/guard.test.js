/**
 * The Guard — permanent content floors (elifant#16).
 *
 * Pure-function tests: no PGlite, no model — the detectors must be auditable
 * arithmetic over text, and these tests ARE that audit. The integration side
 * (a grievance corpus shelving as observations and promoting nothing) lives
 * in mind.test.js; here we pin the detectors' behavior, including the
 * documented misses, so a future "improvement" that changes the floor's shape
 * fails loudly.
 *
 * Run with: node --test test/guard.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../src/guard.js');

// ── thirdPartySignal (per-text) ─────────────────────────────────────────────

test('thirdPartySignal: pronouns, role nouns, and mid-sentence names all signal', () => {
  assert.equal(guard.thirdPartySignal('he never runs the tests'), true, 'pronoun');
  assert.equal(guard.thirdPartySignal('borrowed her ladder for the gutters'), true, 'possessive pronoun');
  assert.equal(guard.thirdPartySignal('my coworker rewrote the schema overnight'), true, 'role noun');
  assert.equal(guard.thirdPartySignal('my student needs the 504 paperwork filed'), true, 'a student is a third party');
  assert.equal(guard.thirdPartySignal('so tired of covering for Dave every sprint'), true, 'mid-sentence name');
  assert.equal(guard.thirdPartySignal("waiting on Dave's review again"), true, 'mid-sentence possessive name');
});

test('thirdPartySignal: first-person and impersonal text stays clean', () => {
  assert.equal(guard.thirdPartySignal('i was late to standup again'), false, 'the keyholder is not a third party');
  assert.equal(guard.thirdPartySignal('the garden tomatoes are ripening early this year'), false);
  assert.equal(guard.thirdPartySignal('turned the compost, needs two more weeks'), false);
  assert.equal(guard.thirdPartySignal(''), false);
  assert.equal(guard.thirdPartySignal(null), false);
});

test('thirdPartySignal: calendar capitals and sentence-initial capitals are not names', () => {
  assert.equal(guard.thirdPartySignal('moved the meeting to Tuesday afternoon'), false, 'weekday');
  assert.equal(guard.thirdPartySignal('the review lands in January now'), false, 'month');
  assert.equal(guard.thirdPartySignal('Remember to water the beds'), false, 'sentence-initial capital is just English');
  // The DOCUMENTED MISS, pinned on purpose: a sentence-initial name with no
  // other signal reads clean in isolation. The cluster-level pass recovers it.
  assert.equal(guard.thirdPartySignal('Dave was late again.'), false,
    'known per-text miss — recovered by thirdPartyCluster, see next test');
});

test('nameTokens: line starts, headings, and blockquotes count as sentence-initial', () => {
  const t = guard.nameTokens('# Morning notes\n> User said hello\nlunch with Priya tomorrow');
  assert.ok(t.initial.has('morning'), 'heading capital is initial');
  assert.ok(t.initial.has('user'), 'blockquote line start is initial');
  assert.ok(t.mid.has('priya'), 'a genuine mid-sentence name lands in mid');
  assert.ok(!t.mid.has('user') && !t.mid.has('morning'), 'wallpaper capitals never read as names');
});

// ── thirdPartyCluster (cross-member) ────────────────────────────────────────

test('thirdPartyCluster: a grievance cluster is caught, including sentence-initial-only members', () => {
  const gripes = [
    'Dave was late to standup again and the whole morning slipped',
    'Dave shipped the broken build again, he never runs the tests',
    'so tired of covering for Dave, he is impossible to plan around',
    'Dave talked over me for the entire retro meeting',
    'another Dave morning, he left the build red and went home',
  ];
  assert.equal(guard.thirdPartyCluster(gripes), true);
});

test('thirdPartyCluster: incidental mentions never strip a keyholder cluster of its ladder', () => {
  const garden = [
    'the garden tomatoes are ripening early this year',
    'turned the garden compost, needs two more weeks',
    'Dave lent me his tiller for the garden beds',   // one incidental mention
    'ordered garden seeds for the spring beds',
    'the garden fence post by the gate is rotting',
  ];
  assert.equal(guard.thirdPartyCluster(garden), false, '1 of 5 flagged is not "about Dave"');
  assert.equal(guard.thirdPartyCluster([]), false, 'empty evidence is not third-party');
});

test('thirdPartyCluster: majority rule sits at half', () => {
  const three = [
    'he missed the deadline again',
    'she moved the meeting without asking',
    'watered the plants before work',
  ];
  assert.equal(guard.thirdPartyCluster(three), true, '2 of 3 clears ceil(3/2)=2');
  const onlyOne = [
    'he missed the deadline again',
    'watered the plants before work',
    'refilled the bird feeder',
  ];
  assert.equal(guard.thirdPartyCluster(onlyOne), false, '1 of 3 does not');
});

// ── promotionGuard ──────────────────────────────────────────────────────────

test('promotionGuard: third-party evidence is refused; keyholder evidence climbs free', () => {
  assert.equal(guard.promotionGuard([
    'my boss rewrote the roadmap again',
    'she cancelled the one-on-one twice',
    'the boss wants dailies now',
  ]), 'third-party');
  assert.equal(guard.promotionGuard([
    'garden note about the beds',
    'garden note about the compost',
    'garden note about the fence',
  ]), null);
  assert.equal(guard.promotionGuard([]), null);
});

// ── injectDisposition ───────────────────────────────────────────────────────

test('injectDisposition: a synthesized row about a third party is held outright', () => {
  const shelf = `# on this shelf: 5 memories\ncommon thread: dave\n${guard.THIRD_PARTY_MARK}\n\n- a.md (2026-07-01)\n`;
  assert.equal(guard.injectDisposition({ content: shelf, trust_tier: 'tier-2-synthesized' }), 'hold',
    'the mark alone holds a derived row — no re-detection needed');
  assert.equal(guard.injectDisposition({ content: 'she is impossible to plan around', trust_tier: 'tier-2-synthesized' }), 'hold',
    'an unmarked derived row about a person is still held (text detection backstop)');
});

test('injectDisposition: the keyholder\'s own words about someone else inject only marked', () => {
  assert.equal(guard.injectDisposition({ content: 'my coworker rewrote the schema overnight', trust_tier: 'tier-1-keyholder-direct' }),
    'mark-third-party');
  assert.equal(guard.injectDisposition({ content: 'lunch with Priya tomorrow at noon' }),
    'mark-third-party', 'missing tier defaults to keyholder-direct handling');
});

test('injectDisposition: clean content is unconstrained', () => {
  assert.equal(guard.injectDisposition({ content: 'the garden tomatoes are ripening', trust_tier: 'tier-1-keyholder-direct' }), 'plain');
  assert.equal(guard.injectDisposition({ content: '', trust_tier: 'tier-2-synthesized' }), 'plain');
  assert.equal(guard.injectDisposition({}), 'plain');
});

test('THIRD_PARTY_MARK is the exact line the keeper renders and the mind/surfaces parse', () => {
  assert.match(guard.THIRD_PARTY_MARK, /^about: a third party/);
  const keeper = require('../src/keeper.js');
  const content = keeper.renderShelf(
    [{ filename: 'a.md', day: '2026-07-01' }, { filename: 'b.md', day: '2026-07-02' }, { filename: 'c.md', day: '2026-07-03' }],
    ['dave'], { thirdParty: true }
  );
  assert.ok(content.includes(guard.THIRD_PARTY_MARK), 'renderShelf writes the exact mark');
  assert.match(content, /^about: a third party/m, 'parseable as its own line');
  assert.deepEqual(keeper.parseMembers(content), ['a.md', 'b.md', 'c.md'], 'the mark never disturbs member parsing');
  const unmarked = keeper.renderShelf(
    [{ filename: 'a.md', day: '2026-07-01' }, { filename: 'b.md', day: '2026-07-02' }, { filename: 'c.md', day: '2026-07-03' }],
    ['garden']
  );
  assert.ok(!unmarked.includes('about: a third party'), 'no mark on an ordinary shelf');
});
