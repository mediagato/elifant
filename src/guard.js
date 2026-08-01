/**
 * The Guard — permanent content floors under the promotion ladder (elifant#16).
 *
 * The Mind's ladder is threshold-mechanical: recurrence earns confidence,
 * confidence crosses gates, a shelf hardens into pinned knowledge. The gates
 * measure HOW OFTEN — nothing measured WHAT ABOUT. Five vents about a coworker
 * promoted exactly like five notes about a garden, and the promoted verdict
 * came out pinned, receipted, and structurally boosted above everything else
 * in search. This module is the WHAT-ABOUT check, and it is a floor, not a
 * dial:
 *
 *   #16 THIRD PARTIES — about people who are not the keyholder, the mind
 *       consolidates OBSERVATIONS, never VERDICTS (kernel-ethic #6,
 *       K-CARBON-4). A cluster about someone else may still shelve — the
 *       shelf is a receipted observation, and it is MARKED as third-party in
 *       its own content — but it must never harden into knowledge, and a
 *       derived row about a person must never travel into an AI-facing
 *       context block.
 *
 * PERMANENT FLOOR, BY CONSTRUCTION: nothing in this module reads options,
 * state, env, or per-tick config. The Mind's tick options merge into cfg and
 * cfg is never consulted here, so no configuration path — kernel, shell, or
 * keyholder dial — can disable these checks (#14: "non-negotiable regardless
 * of dials"). If a future setting must tune this, it belongs in a NEW,
 * deliberate seam with its own review — not in an argument.
 *
 * DETERMINISTIC AND MODEL-FREE, like everything above the retrieval line:
 * lexicons and token arithmetic only (same INV as keeper.js/mind.js). That
 * buys auditable behavior and costs recall at the edges — known misses are
 * documented on each detector. Every miss fails toward the ladder's ordinary
 * thresholds, and every false positive fails toward "stays an observation":
 * conservative in both directions, never toward a silent verdict.
 */
'use strict';

// ── lexicons ────────────────────────────────────────────────────────────────

// Third-person singular pronouns. they/them/their are deliberately absent:
// they name organizations, products and crowds far more often than a specific
// person, and a floor should be steady, not jumpy.
const PRONOUNS = new Set(['he', 'him', 'his', 'she', 'her', 'hers']);

// Relationship/role nouns that name a person in the keyholder's life — a
// coworker, a student, a parent. All of them are third parties (someone the
// keyholder writes ABOUT), which is the point: "my son" consented to a pinned
// verdict no more than a coworker did.
const RELATION_NOUNS = new Set([
  'coworker', 'coworkers', 'co-worker', 'co-workers', 'colleague', 'colleagues',
  'boss', 'bosses', 'manager', 'managers', 'supervisor', 'supervisors',
  'neighbor', 'neighbors', 'neighbour', 'neighbours',
  'friend', 'friends', 'girlfriend', 'boyfriend', 'partner',
  'brother', 'brothers', 'sister', 'sisters',
  'mom', 'mother', 'dad', 'father', 'parents', 'husband', 'wife',
  'son', 'sons', 'daughter', 'daughters', 'cousin', 'cousins',
  'aunt', 'uncle', 'grandma', 'grandpa', 'grandmother', 'grandfather',
  'roommate', 'roommates', 'landlord', 'tenant', 'tenants',
  'teammate', 'teammates', 'classmate', 'classmates',
  'student', 'students', 'client', 'clients', 'customer', 'customers',
  'employee', 'employees', 'kid', 'kids',
]);

// Capitalized tokens that are ordinary English, never a person: calendar
// words. Everything else capitalized MID-sentence is treated as a proper name
// — over-detection is the safe direction (the cost of a false positive is
// "stays an observation", never data loss). The pronoun I never matches the
// name shape ([A-Z] followed by lowercase).
const NOT_NAMES = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

// The machine-readable line the Keeper writes into a shelf whose cluster is
// about a third party (#16). Content IS the receipt, so the mark lives in the
// content — visible to the keyholder, parseable by every inject surface, and
// it survives YOINK/SUMMON because it travels with the row.
const THIRD_PARTY_MARK = 'about: a third party (observations only — never a verdict)';

// ── matching machinery ──────────────────────────────────────────────────────

function _norm(text) {
  return String(text || '').toLowerCase().replace(/[’‘]/g, "'");
}

// Capitalized tokens split by position. MID-sentence occurrences are read as
// proper names; sentence/line-initial ones are just how English capitalizes —
// in isolation. thirdPartyCluster()'s cross-member pass upgrades initial
// tokens that the same cluster establishes as names mid-sentence elsewhere.
function nameTokens(text) {
  const mid = new Set();
  const initial = new Set();
  const s = String(text || '');
  const re = /[A-Z][a-z]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const word = m[0].toLowerCase();
    if (NOT_NAMES.has(word)) continue;
    const prev = m.index > 0 ? s[m.index - 1] : '';
    if (/[A-Za-z0-9'’]/.test(prev)) continue; // mid-word tail ("McDonald"), not a token start
    // Walk back over same-line whitespace and wrapper punctuation (quotes,
    // markdown markers) to the nearest hard boundary. Start-of-text, a
    // newline, or sentence punctuation means this capital is just how
    // sentences begin. \n must NOT be skippable — a line start is a boundary,
    // and skipping past it would misread every heading/blockquote capital as
    // a mid-sentence name.
    let k = m.index - 1;
    while (k >= 0 && /[ \t"'“”‘’()[\]>*#_-]/.test(s[k])) k--;
    if (k < 0 || /[.!?:;\n\r]/.test(s[k])) initial.add(word);
    else mid.add(word);
  }
  return { mid, initial };
}

// ── detectors ───────────────────────────────────────────────────────────────

/**
 * Does this ONE text carry a third-party person signal — a third-person
 * pronoun, a relationship/role noun, or a mid-sentence proper name?
 * KNOWN MISS (deliberate): a text whose only signal is a sentence-initial
 * name ("Dave was late.") is lexically indistinguishable from ordinary
 * capitalization in isolation; the cluster-level pass in thirdPartyCluster
 * recovers it when any sibling text uses the name mid-sentence.
 */
function thirdPartySignal(text) {
  const words = _norm(text).match(/[a-z][a-z'’-]*/g) || [];
  for (const w of words) {
    if (PRONOUNS.has(w) || RELATION_NOUNS.has(w)) return true;
  }
  return nameTokens(text).mid.size > 0;
}

/**
 * Is this CLUSTER of evidence about a person who is not the keyholder?
 * At least half the members must carry a person signal — a couple of
 * incidental mentions inside a garden cluster ("Dave lent me his tiller")
 * must not strip the garden of its ladder. Names established mid-sentence
 * ANYWHERE in the cluster count at sentence starts too: "Dave was late again"
 * carries no signal alone, but the cluster that also says "so tired of
 * covering for Dave" has established who this is about.
 */
function thirdPartyCluster(contents) {
  const texts = (contents || []).map((c) => String(c || ''));
  if (!texts.length) return false;
  const established = new Set();
  const perText = texts.map((t) => {
    const names = nameTokens(t);
    for (const w of names.mid) established.add(w);
    return { t, names };
  });
  let flagged = 0;
  for (const { t, names } of perText) {
    if (thirdPartySignal(t) || [...names.initial].some((w) => established.has(w))) flagged++;
  }
  return flagged >= Math.ceil(texts.length / 2);
}

/**
 * The promotion gate: the FIRST reason this cluster of evidence must never
 * harden into knowledge, or null when it is free to climb. Reason vocabulary
 * today: 'third-party' (#16); the sensitive-domain and crisis floors
 * (elifant#17) land in this same function so the Mind asks ONE question.
 * Reads no options and no config — this is the permanent floor (#14).
 */
function promotionGuard(contents) {
  const texts = (contents || []).map((c) => String(c || ''));
  if (!texts.length) return null;
  return thirdPartyCluster(texts) ? 'third-party' : null;
}

// ── inject policy (what AI-facing surfaces ask) ─────────────────────────────

/**
 * How may a memory travel into an AI-facing context block? One canonical
 * answer, RELEVANCE_FLOORS-style, so shells stop re-deriving policy:
 *
 *   'hold'              never inject: a synthesized (tier-2) row about a
 *                       third party — the mind's own output about a person
 *                       must never be re-voiced into a conversation (#16);
 *   'mark-third-party'  inject ONLY wrapped/marked: the keyholder's own words
 *                       about someone who is not them — their past words,
 *                       never established fact (#16);
 *   'plain'             no constraint from this guard. (tier-3 wrapping and
 *                       tier-4 holding stay with the surfaces — this guard is
 *                       additive, not a replacement for tier discipline.)
 *
 * A deliberate by-name recall is NOT injection (same rule as tier-4: holding
 * applies to context-inject/discovery, not to a fetch the keyholder asked
 * for) — surfaces may still choose to show the mark there.
 */
function injectDisposition(hit) {
  const content = hit && typeof hit.content === 'string' ? hit.content : '';
  const tier = String((hit && hit.trust_tier) || '');
  const third = content.includes(THIRD_PARTY_MARK) || thirdPartySignal(content);
  if (third) return tier.startsWith('tier-2') ? 'hold' : 'mark-third-party';
  return 'plain';
}

module.exports = {
  thirdPartySignal,
  thirdPartyCluster,
  promotionGuard,
  injectDisposition,
  nameTokens,
  THIRD_PARTY_MARK,
};
