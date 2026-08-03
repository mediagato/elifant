/**
 * The Mind — the kernel's promotion ladder (elifant#5).
 *
 * The Keeper answers "what belongs together" (structure: the neighbour graph
 * and its shelves). The Mind answers "does it keep being true" (time +
 * confidence). It watches the Keeper's shelves persist and refresh across
 * ticks, earns confidence from recurrence, and walks each pattern up and down
 * a visible ladder:
 *
 *   thought -> pattern -> knowledge -> (revision) -> (retirement)
 *
 * The bottom rung already exists: the capture stream (Keeper thoughts, host
 * captures). The Mind adds the upper rungs. Growth is MECHANICAL — thresholds
 * over counted evidence, no model anywhere (same INV as the Keeper: nothing is
 * required beyond what index.js hands in). Hosts re-voice the deterministic
 * template text through their own narrators; if there is no narrator, the
 * ladder still climbs.
 *
 * (INV, same as the Keeper: no model, no require beyond what index.js hands
 * in — kernel-sibling pure modules (./guard) excepted.)
 *
 * WHAT A TICK DOES
 *   1. loads the pattern ledger (state keys `mind:pattern:<id>`);
 *   2. reads every live Keeper shelf as a pattern CANDIDATE — n counts the
 *      shelf's LIVE tier-1 members, born/last come from their real updated_at
 *      timestamps (so a genuinely old cluster is old at birth and can promote
 *      on tick one — genesis is not a special mode);
 *   3. resolves each candidate to the pattern it CONTINUES — its own producer
 *      row, one it has been carried on before, or (elifant#18) an orphaned
 *      pattern it can be shown to be the reformation of;
 *   4. upserts candidates into the ledger; a first sighting emits a `pattern`
 *      capture (the forming band);
 *   5. recomputes confidence for EVERY pattern — including ones whose shelf
 *      dissolved: their n recomputes from still-live refs, so deletion and
 *      edit-away are contradiction, mechanically, not just staleness;
 *   6. transitions:
 *        forming  + conf >= 0.8 && n >= 5 && (age >= 24h
 *                   || n >= promoteHighN, the rolling-window escape hatch of
 *                   elifant#20, Infinity unless a host opts in) -> PROMOTE: a durable
 *                   pinned knowledge memory (tier-2-synthesized, producer
 *                   'mind/promotion-v1', receipt history in the row itself)
 *                   + a `knowledge` capture — UNLESS the Guard holds it:
 *                   a pattern whose evidence is about a person who is not
 *                   the keyholder (elifant#16), majority-touches a denylisted
 *                   domain (health/grief/finance), or contains any crisis-
 *                   lexicon match (elifant#17) NEVER promotes, at any
 *                   confidence/n/age, under any per-tick option. The refusal
 *                   is visible once (a `guard` capture), then quiet — except
 *                   a crisis hold, which is never narrated at all;
 *        hardened + conf < 0.4                           -> REVISE (visible,
 *                   once per softening) + a `revision` capture;
 *        hardened + conf < 0.2                           -> RETIRE (visible;
 *                   the knowledge row is archived — reversible, never
 *                   deleted) + a `retirement` capture;
 *        retired  + fresh evidence                       -> back to forming
 *                   (the ladder goes both ways).
 *
 * WHAT IT WILL NEVER DO
 *   - touch a model (deterministic templates only);
 *   - modify a source row (knowledge rows are NEW rows, honestly marked);
 *   - promote silently: every transition is a receipted capture
 *     {source:'mind'}, and the knowledge row's `## history` block is the
 *     durable record of every rung it climbed or fell;
 *   - pin through the keyholder's path: knowledge is pinned as
 *     tier-2-synthesized via the derived-write primitive, NEVER via
 *     setMemoryPin (which is the keyholder's tier-1 vouch and must stay so).
 *
 * CONFIDENCE IS THRESHOLD-MECHANICAL. askari/mind (the reference impl this
 * ports, built for Allen) floored recency at 0.3, which made its own <0.2
 * retirement threshold unreachable and forced a second, age-driven retirement
 * mechanism. The kernel drops the floor: recency decays linearly to ZERO at
 * horizonDays, so <0.4 revision and <0.2 retirement are genuinely reachable
 * through the one confidence number, in both the staleness and the
 * evidence-loss direction.
 *
 * elifant#6 SHIPPED (keeper.js) via a DIFFERENT path than this seam reserved:
 * near-dup pairs become a needs-decision Bell ask, not a Mind candidate — a
 * pair climbing toward pinned knowledge on its own is a bigger call than
 * either #6 or #7's acceptance criterion asked for. The seam below is still
 * open if that call is ever made deliberately: nothing here needs to change
 * shape to accept it.
 * SEAM RESERVED (detector B, fast-follow): capture-theme recurrence — hosts
 * emitting addCapture({data:{theme}}) — feeds the same interface too; that is
 * how Allen-on-kernel keeps Minecraft semantics host-side forever.
 *
 * IDENTITY SURVIVES ARCHIVE-AND-REFORM (elifant#18 — was the KNOWN GAP here).
 * A pattern's ledger id is the producer row it was first seen on ('shelf:' /
 * 'confirmed:' + filename), and that id is stable for as long as the shelf is:
 * keeper.js's matchClusters keeps a shelf's filename while its cluster grows
 * and shrinks, so ordinary revival always worked (the "fresh evidence revives"
 * test). It was NOT stable across a full dissolve. Once a cluster drops below
 * MIN_SHELF the Keeper ARCHIVES the shelf, `_candidates()` stops returning it,
 * and a later reforming of the same subject lands on a brand-new filename
 * (shelfSlug's collision loop refuses an archived-but-not-deleted name) — which
 * used to be a brand-new, disconnected pattern. The old one could never revive,
 * and its knowledge memory's history sat orphaned instead of gaining a
 * "promoted again" line. #9 (decay-to-archive) will cause strictly MORE shelf
 * dissolution than happens today, so the gap was going to fire more often, not
 * less.
 *
 * Identity is therefore RESOLVED now, not merely read. A candidate whose
 * producer row nobody in the ledger recognizes may ADOPT an orphaned pattern —
 * keeping that pattern's id, threadKey, knowledge row and history — and records
 * the new producer row in `aliases`, so the next tick recognizes it directly.
 * Old ledger rows need no migration: they carry no `aliases` and simply resolve
 * by id, exactly as before, until the day one of them is adopted onto.
 *
 * WHAT DECIDES "the same pattern" — and why it is NOT the theme alone. The
 * issue proposed keying identity on a theme/content signature. Alone that is
 * wrong twice over. Shelves routinely have no thread at all (keeper's
 * commonThread returns [] on a weak cluster and the copy degrades honestly to
 * "similar things"), so every threadless shelf would collapse into one
 * identity; and two genuinely different clusters can share a thread — the
 * "two distinct shelves whose slugs collide" regression seeds exactly that.
 * Deeper: merging two clusters because their lexical threads match is an
 * INFERENCE, and acting on it appends "promoted again" to a knowledge row that
 * describes different evidence. K-CARBON-4 forbids the kernel asserting what it
 * only inferred, and the `## history` block is an assertion.
 *
 * So the primary key is the EVIDENCE: does the reforming cluster still contain
 * the memories this pattern stands on? That is a fact, not a guess, and the
 * threshold is keeper.js matchClusters' own overlap rule — the same test that
 * carries a shelf's filename across ticks, applied across the archive boundary
 * matchClusters cannot see. Theme signature survives only as a FALLBACK for the
 * one case evidence cannot answer (every original member is gone and the
 * subject reformed on new memories), and only when the pairing is unambiguous
 * on both sides: exactly one orphan and exactly one unrecognized candidate
 * carrying that signature. See adoptionClaims().
 *
 * DECAY IS NOT CONTRADICTION (elifant#9). src/decay.js archives an untouched,
 * never/rarely-recalled, old memory on its own — but it was never retracted,
 * never edited away, nobody said it was wrong, it just stopped being asked
 * for. Disuse is not disagreement, so it must not read as the evidence-loss
 * contradiction the header above describes for deletion and edit-away. Every
 * evidence-liveness read this file does — _candidates()'s member-liveness
 * check, _guardFromRefs, _liveRefNames/_liveRefCount — runs through the ONE
 * SOURCE_WHERE below, which now treats a decay-archived row as still-live
 * evidence while a keyholder-archived or deleted row still counts against a
 * pattern exactly as it always has. Concretely: a shelf whose members are all
 * decay-archived (not gone, not keyholder-archived) still recomputes n at its
 * live-evidence count, so a hardened pattern built on it does not spuriously
 * revise or retire, and a shelf that later ARCHIVES for real reasons (elifant
 * #18's continuity) sees only-decayed members as ordinary continuing
 * evidence, not as a dissolved cluster reforming from nothing. The reverse
 * direction is symmetric and requires no special code: un-decaying a row is
 * the same setMemoryArchive(fn, false) every archive already reverses through
 * (index.js), which clears archived_reason too — so a reformed/revived
 * pattern whose members get un-decayed sees its evidence recover exactly like
 * any other write, with nothing decay-specific left behind to clean up.
 */
'use strict';

const { promotionGuard } = require('./guard');

// Tunables (elifant#5's stated gates; override per tick via mindTick(opts)) —
// except minPatternN and maxRefs, which _candidates() reads from DEFAULTS
// directly and are not per-tick overridable (index.d.ts's MindTickOptions
// correctly omits both; this comment previously implied otherwise).
const DEFAULTS = {
  promoteConf: 0.8,   // confidence gate to harden a pattern into knowledge
  promoteN: 5,        // ...and this much live evidence
  promoteAgeH: 24,    // ...and this old (born is real evidence time — no shortcut)
  // ...UNLESS the evidence is this deep, which is the age gate's only escape
  // hatch (elifant#20). Infinity by default: the gate is unconditional for
  // every existing consumer, and only a host that explicitly sets a finite
  // number opts in. It exists because `born` is derived from the member rows'
  // own updated_at, so a host whose evidence lives in a ROLLING WINDOW (askari
  // /mind, built for Allen's deathzone memory, keeps ~24h) has patterns whose
  // born can never age past the window no matter how much evidence piles up —
  // a 40-observation pattern would sit in `forming` forever. Depth of evidence
  // substituting for elapsed time is a real, defensible signal; assuming every
  // host wants it is not, hence the opt-in default.
  promoteHighN: Infinity,
  reviseConf: 0.4,    // hardened below this -> visible revision (once per softening)
  retireConf: 0.2,    // hardened below this -> visible retirement
  targetN: 5,         // n at which the evidence factor saturates
  freshDays: 3,       // full recency weight for this long...
  horizonDays: 30,    // ...then linear decay to ZERO here (no floor — see header)
  minPatternN: 3,     // a shelf is >= 3 members by construction (keeper MIN_SHELF)
  maxRefs: 20,        // evidence refs carried on the ledger row (bounded)
};

const MIND_VIA = 'mind/promotion-v1';
const STATE_PREFIX = 'mind:pattern:';
const EPOCH_KEY = 'mind:epoch';
const KNOWLEDGE_PREFIX = 'mind/knowledge/';
const SHELVING_VIA = 'keeper/shelving-v1'; // the evidence source (keeper.js)
// elifant#6 follow-up — a keyholder's own "yes these are the same fact"
// (index.js's confirmDuplicate). Same string literal owned there; kept in
// sync by hand exactly like SHELVING_VIA above already is.
const CONFIRMED_VIA = 'keeper/confirmed-dup-v1';
// A confirmed pair is, by construction, exactly two members forever (nothing
// ever grows it) — DEFAULTS.minPatternN (3) would silently exclude every
// confirmed-dup candidate from ever reaching the ladder at all.
const CONFIRMED_MIN_N = 2;
// The label the Keeper's copy degrades to when commonThread found no subject
// worth naming. It is deliberately NOT an identity (see themeSignature).
const NO_THREAD_LABEL = 'similar things';
// A pattern's id is its FIRST producer row; `aliases` records every later one
// it has been adopted onto (elifant#18). Bounded like refs: an alias only
// matters while that producer row could return as a live candidate, and an
// archived shelf superseded twenty reformations ago will not.
const MAX_ALIASES = 20;

// ── pure helpers (exported for the test suite) ──────────────────────────────

// Stable public grouping key — djb2 over the theme, so consumers thread events
// without ever needing the raw pattern id (askari ports.js convention).
function threadKey(theme) {
  let h = 5381;
  const s = String(theme);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function slug(s) {
  return String(s).toLowerCase().replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function titleCase(s) { return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase()); }

// Parse the `common thread: a, b` line out of a shelf's content. Empty array
// when the Keeper declined to name a subject — the copy degrades honestly.
function threadOf(shelfContent) {
  const m = String(shelfContent || '').match(/^common thread: (.+)$/m);
  return m ? m[1].split(',').map((t) => t.trim()).filter(Boolean) : [];
}

// The subject signature of a candidate or a ledger row (elifant#18): the
// Keeper's `common thread` tokens, order-independent. Read off themeLabel
// because that is the one field BOTH sides already carry, and it is derived
// from the thread deterministically (thread.join(', '), or NO_THREAD_LABEL).
// An unnamed subject signs as '' and matches nothing, ever: a cluster the
// Keeper could not name is not thereby the same cluster as every other one it
// could not name.
function themeSignature(themeLabel) {
  const s = String(themeLabel || '').trim();
  if (!s || s === NO_THREAD_LABEL) return '';
  return s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).sort().join(',');
}

/**
 * Which unrecognized candidates continue which orphaned patterns (elifant#18)?
 * Pure, deterministic, and strictly one-to-one. Takes shapes rather than ledger
 * rows so the rule is unit-testable on its own:
 *   candidates [{id, kind, members: [filename], threadSig}]
 *   orphans    [{id, kind, liveRefs: [filename], threadSig}]
 * Returns Map(candidate id -> pattern id) for the claims that win.
 *
 * Two tiers, EVIDENCE always beating subject:
 *   tier 2 — the candidate contains enough of the pattern's still-live refs.
 *            The threshold is keeper.js matchClusters' own rule (at least half
 *            the smaller side, minimum one), so "this is the same shelf" means
 *            the same thing on both sides of the archive boundary. Scored by
 *            overlap, so the best-supported claim wins a contested pattern.
 *   tier 1 — identical, non-empty thread signature, and ONLY when exactly one
 *            orphan and exactly one candidate carry it. This is the fallback
 *            for a subject that reformed on entirely new memories, where there
 *            is no shared evidence left to reason from. Ambiguity is refused
 *            rather than guessed: two orphans with one signature is a question
 *            the kernel cannot answer, and inventing an answer would fabricate
 *            a knowledge row's history (K-CARBON-4).
 * Kinds must match either way — a confirmed pair never adopts a shelf, or the
 * reverse; they are different evidence with different weighting rules.
 */
function adoptionClaims(candidates, orphans) {
  const claims = [];
  for (const c of candidates) {
    const members = new Set(c.members || []);
    if (!members.size) continue;
    for (const o of orphans) {
      if (o.kind !== c.kind) continue;
      const refs = o.liveRefs || [];
      if (!refs.length) continue;
      const overlap = refs.filter((f) => members.has(f)).length;
      const need = Math.max(1, Math.ceil(Math.min(members.size, refs.length) / 2));
      if (overlap >= need) claims.push({ tier: 2, score: overlap, c: c.id, o: o.id });
    }
  }
  const bySig = new Map();
  const group = (sig) => {
    if (!bySig.has(sig)) bySig.set(sig, { c: [], o: [] });
    return bySig.get(sig);
  };
  for (const c of candidates) if (c.threadSig) group(c.threadSig).c.push(c);
  for (const o of orphans) if (o.threadSig) group(o.threadSig).o.push(o);
  for (const g of bySig.values()) {
    if (g.c.length !== 1 || g.o.length !== 1) continue;
    if (g.c[0].kind !== g.o[0].kind) continue;
    claims.push({ tier: 1, score: 0, c: g.c[0].id, o: g.o[0].id });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  claims.sort((a, b) => (b.tier - a.tier) || (b.score - a.score) || cmp(a.c, b.c) || cmp(a.o, b.o));
  const takenC = new Set();
  const takenO = new Set();
  const out = new Map();
  for (const cl of claims) {
    if (takenC.has(cl.c) || takenO.has(cl.o)) continue;
    takenC.add(cl.c);
    takenO.add(cl.o);
    out.set(cl.c, cl.o);
  }
  return out;
}

/**
 * confidence = evidence factor x recency factor, rounded to 2 decimals.
 *   evidence: min(1, n / targetN)
 *   recency:  1 for the first freshDays, then linear to 0 at horizonDays.
 * No floor — the issue's <0.4 / <0.2 thresholds must be reachable (see header).
 */
function confidence({ n, last }, nowMs, cfg = DEFAULTS) {
  const nFactor = Math.min(1, (n || 0) / cfg.targetN);
  const dLast = Math.max(0, (nowMs - (last || nowMs)) / 86400000);
  const recency = dLast <= cfg.freshDays
    ? 1
    : Math.max(0, 1 - (dLast - cfg.freshDays) / (cfg.horizonDays - cfg.freshDays));
  return Math.round(nFactor * recency * 100) / 100;
}

// Confidence and evidence are hard gates. Age is a hard gate too, with exactly
// one escape hatch: n >= promoteHighN (elifant#20, Infinity unless a host opts
// in — see DEFAULTS). Note the OR sits INSIDE the age clause, never around
// promoteConf/promoteN: deep evidence buys a pattern out of the calendar, never
// out of the confidence or recurrence floors, and never out of the Guard (which
// is checked by the caller and reads no config at all).
function promotable(p, nowMs, cfg = DEFAULTS) {
  const ageH = (nowMs - (p.born || nowMs)) / 3600000;
  const n = p.signal.n || 0;
  // Anything that is not an explicit FINITE number reads as "no escape hatch".
  // Not defensive noise: the default is Infinity, and JSON.stringify turns
  // Infinity into `null` — so a host that round-trips its config through JSON
  // (or a settings file, or a wire hop) would hand back null, and `n >= null`
  // is `n >= 0`, which is true for every pattern alive. The one value meaning
  // "off" would have silently become the value meaning "always on".
  const highN = Number.isFinite(cfg.promoteHighN) ? cfg.promoteHighN : Infinity;
  return p.status === 'forming'
    && p.confidence >= cfg.promoteConf
    && n >= cfg.promoteN
    && (ageH >= cfg.promoteAgeH || n >= highN);
}

// The knowledge row — the receipt IS the content, keeper style. The `## history`
// block is the durable, visible record of every transition; revisions append,
// never rewrite (a mind that changes its mind shows its work).
function renderKnowledge(label, evidenceSummary, date, historyLines) {
  return `# ${titleCase(label)}\n\n` +
    `I keep coming back to this — ${evidenceSummary}.\n\n` +
    `Decided ${date} — ${evidenceSummary}.\n\n` +
    `## history\n${historyLines.map((l) => `- ${l}`).join('\n')}\n\n` +
    '_grown by the mind. every line above re-derives from the ledger row and the ' +
    'memories the shelf names; the sources are untouched._\n';
}

// Append a history line to an existing knowledge row's content; if the content
// is unparseable/missing, regenerate from scratch with the line as history.
function appendHistory(content, label, evidenceSummary, date, line) {
  const s = String(content || '');
  const at = s.indexOf('## history\n');
  if (at === -1) return renderKnowledge(label, evidenceSummary, date, [line]);
  const end = s.indexOf('\n\n', at);
  const block = end === -1 ? s.slice(at) : s.slice(at, end);
  const rest = end === -1 ? '' : s.slice(end);
  return s.slice(0, at) + block + `\n- ${line}` + rest;
}

/**
 * createMind(ctx) — wired by index.js with kernel internals (keeper twin):
 *   query(sql, params)          raw read/write on the live store
 *   addCapture(cap)             transition emission (source:'mind')
 *   setMemoryDerived(...)       stamped write for tier-2 derived rows (+pinned)
 *   setMemoryArchive(fn, bool, reason)  reversible knowledge retirement
 *   getState/setState/deleteState  the pattern ledger + epoch
 *   ts()                        kernel timestamp
 *   trustTier                   TRUST_TIER constants
 *   archiveReason                ARCHIVE_REASON constants (elifant#9) — _retire()
 *                                tags its own archive 'mind-retirement', distinct
 *                                from a keyholder archive AND from decay, so
 *                                SOURCE_WHERE below can tell them apart.
 */
function createMind(ctx) {
  const { query, addCapture, setMemoryDerived, setMemoryArchive, getState, setState, deleteState, ts, trustTier, archiveReason } = ctx;

  async function _setMeta(key, value) {
    await query(
      'INSERT INTO brain_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
  }
  async function _meta(key) {
    const r = await query('SELECT value FROM brain_meta WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  }

  // Same source-eligibility predicate as the Keeper: live, not derived, the
  // keyholder's own words — PLUS one deliberate difference from the Keeper's
  // own copy (elifant#9): a row archived FOR DECAY still counts. Decay is a
  // retrieval-tier softening, not a retraction — nobody said the row was
  // wrong, it just went quiet — so it must not read as evidence loss the way
  // a keyholder archive or a delete still does. Any other archived row
  // (reason 'keyholder', 'mind-retirement', or NULL — the grandfather case
  // for every archive that pre-dates archived_reason, including the Keeper's
  // own shelf-dissolve archive) is excluded exactly as before this issue
  // shipped: decay is a NAMED exception, not a general softening of what
  // "live" means. See the header above and decay.js for the full argument.
  const SOURCE_WHERE = `deleted_at IS NULL AND (archived = false OR archived_reason = '${archiveReason.DECAY}') ` +
    `AND synthesized_via IS NULL AND trust_tier = '${trustTier.KEYHOLDER_DIRECT}'`;

  async function _ledger() {
    const r = await query(
      `SELECT key, value FROM state WHERE key LIKE $1 AND deleted_at IS NULL`, [STATE_PREFIX + '%']
    );
    const out = new Map();
    for (const row of r.rows) {
      try { const p = JSON.parse(row.value); if (p && p.id) out.set(p.id, p); } catch { /* garbage row: skip */ }
    }
    return out;
  }

  async function _save(p) { await setState(STATE_PREFIX + p.id, JSON.stringify(p), 'mind'); }

  // Every live Keeper shelf, AND every keyholder-confirmed duplicate pair
  // (elifant#6 follow-up), is a pattern candidate. n / born / last derive
  // from the LIVE member rows, not the row's own text — deletions count
  // against the pattern the moment they happen.
  async function _candidates() {
    const producers = await query(
      `SELECT filename, content, synthesized_via, embedding::text AS vec FROM memories
       WHERE synthesized_via = ANY($1::text[]) AND deleted_at IS NULL AND archived = false`,
      [[SHELVING_VIA, CONFIRMED_VIA]]
    );
    const out = [];
    for (const s of producers.rows) {
      const confirmed = s.synthesized_via === CONFIRMED_VIA;
      const members = [];
      for (const m of String(s.content || '').matchAll(/^- (\S+)(?: |$)/gm)) members.push(m[1]);
      if (!members.length) continue;
      const live = await query(
        `SELECT filename, updated_at, content FROM memories WHERE filename = ANY($1::text[]) AND ${SOURCE_WHERE}`,
        [members]
      );
      const rows = live.rows;
      // A confirmed pair only ever has 2 declared members — DEFAULTS.minPatternN
      // (3) is a shelf-shaped floor and would drop it every single tick.
      if (rows.length < (confirmed ? CONFIRMED_MIN_N : DEFAULTS.minPatternN)) continue; // dissolving
      const times = rows.map((r) => Date.parse(r.updated_at)).filter(Number.isFinite);
      const born = Math.min(...times);
      const last = Math.max(...times);
      const thread = threadOf(s.content);
      const label = thread.length ? thread.join(', ') : NO_THREAD_LABEL;
      const days = Math.max(1, Math.round((last - born) / 86400000));
      // A keyholder's own confirmation IS complete evidence — it doesn't need
      // to wait for statistical recurrence the way an auto-detected shelf
      // does, so it presents at full evidence weight (targetN) rather than
      // its raw (always-2) member count. The boost only fires while this
      // producer row is still live with enough members to be a candidate at
      // all; the moment it drops below CONFIRMED_MIN_N (one side deleted),
      // this branch is skipped and the decay path below recomputes the real,
      // smaller n from _liveRefCount — same self-correction a shelf gets.
      const n = confirmed ? Math.max(rows.length, DEFAULTS.targetN) : rows.length;
      out.push({
        id: (confirmed ? 'confirmed:' : 'shelf:') + s.filename,
        kind: confirmed ? 'confirmed-dup' : 'shelf-recurrence',
        theme: s.filename,
        themeLabel: label,
        n, born, last,
        refs: rows.slice(0, DEFAULTS.maxRefs).map((r) => ({ filename: r.filename, day: String(r.updated_at).slice(0, 10) })),
        evidenceSummary: confirmed
          ? `you confirmed ${thread.length ? label : 'these say the same thing'} — ${rows.length} memories`
          : (thread.length
            ? `${rows.length} memories about ${label} over ${days} day${days === 1 ? '' : 's'}`
            : `${rows.length} memories saying similar things over ${days} day${days === 1 ? '' : 's'}`),
        vec: s.vec ? String(s.vec).replace(/^\[|\]$/g, '').split(',').map(Number) : null,
        // The Guard's verdict over the LIVE evidence (elifant#16) — recomputed
        // every tick from the member rows themselves, so an edit that changes
        // what the cluster is about changes the verdict with it. Applies to a
        // confirmed pair exactly as it does to a shelf — your own vouch does
        // not bypass the safety floor, only the recurrence requirement.
        guard: promotionGuard(rows.map((r) => r.content)),
      });
    }
    return out;
  }

  // Guard verdict for a pattern with no fresh candidate this tick (its shelf
  // dissolved, or the ledger row predates the Guard): re-derive from whichever
  // refs are still live keyholder rows. Never assume unguarded.
  async function _guardFromRefs(p) {
    const names = (p.signal.refs || []).map((r) => r.filename);
    if (!names.length) return null;
    const r = await query(
      `SELECT content FROM memories WHERE filename = ANY($1::text[]) AND ${SOURCE_WHERE}`, [names]
    );
    return promotionGuard(r.rows.map((row) => row.content));
  }

  // WHICH of a pattern's recorded refs are still live keyholder rows. Two
  // callers, one query: the decay path below only needs the count (evidence
  // loss IS contradiction), while adoption (elifant#18) needs the names — what
  // a pattern still stands on is exactly what a reforming cluster has to
  // contain to be recognized as the same pattern.
  async function _liveRefNames(p) {
    const names = (p.signal.refs || []).map((r) => r.filename);
    if (!names.length) return [];
    const r = await query(
      `SELECT filename FROM memories WHERE filename = ANY($1::text[]) AND ${SOURCE_WHERE}`, [names]
    );
    return r.rows.map((row) => row.filename);
  }

  async function _liveRefCount(p) { return (await _liveRefNames(p)).length; }

  function _event(p, stage, text, nowIso, extra) {
    return Object.assign({
      t: nowIso, stage, patternId: p.id, kind: p.kind, theme: p.theme,
      themeLabel: p.themeLabel, threadKey: p.threadKey,
      text, confidence: p.confidence, evidenceSummary: p.signal.evidenceSummary,
    }, extra || {});
  }

  async function _emit(stage, event) { await addCapture({ source: 'mind', type: stage, data: event }); }

  // {content, vec} — vec is the row's own current embedding (or null), so a
  // revision/retirement rewrite can carry it forward instead of silently
  // dropping search relevance (setMemoryDerived's ON CONFLICT sets whatever
  // embedding it's given, including null, on every write).
  async function _knowledgeRow(filename) {
    const r = await query('SELECT content, embedding::text AS vec FROM memories WHERE filename = $1 AND deleted_at IS NULL', [filename]);
    if (!r.rows[0]) return { content: null, vec: null };
    const raw = r.rows[0].vec;
    const vec = raw ? String(raw).replace(/^\[|\]$/g, '').split(',').map(Number) : null;
    return { content: r.rows[0].content, vec };
  }

  async function _promote(p, nowIso, vec) {
    const date = nowIso.slice(0, 10);
    const line = `${date} promoted (confidence ${p.confidence}, n=${p.signal.n})`;
    let fn = p.knowledge;
    if (!fn) {
      fn = KNOWLEDGE_PREFIX + slug(p.theme.replace(/^shelf\//, '')) + '.md';
      // A keyholder's own live file must never be overwritten. A row already
      // claimed by ANOTHER pattern isn't free either — re-promotion of THIS
      // pattern always takes the `fn = p.knowledge` branch above and never
      // reaches this loop, so anything found here belongs to someone else.
      for (let suffix = 2; ; suffix++) {
        const clash = await query(
          'SELECT 1 FROM memories WHERE filename = $1 AND deleted_at IS NULL', [fn]
        );
        if (!clash.rows[0]) break;
        fn = KNOWLEDGE_PREFIX + slug(p.theme.replace(/^shelf\//, '')) + `-${suffix}.md`;
      }
    }
    const { content: existing, vec: existingVec } = await _knowledgeRow(fn);
    // Re-promotion (p.knowledge already set) keeps its existing scent if this
    // call wasn't handed a fresh one — otherwise a revival that skips the
    // shelf's own embedding read would silently de-search the row.
    const carryVec = vec || existingVec || null;
    const content = existing
      ? appendHistory(existing, p.themeLabel, p.signal.evidenceSummary, date, `${line} again`)
      : renderKnowledge(p.themeLabel, p.signal.evidenceSummary, date, [line]);
    await setMemoryDerived(fn, content, {
      updatedBy: 'mind', layer: 'instance', embedding: carryVec,
      trustTier: trustTier.SYNTHESIZED, synthesizedVia: MIND_VIA, pinned: true,
    });
    p.status = 'hardened';
    p.knowledge = fn;
    p.softenedAt = null;
    const text = `this hardened into knowledge: ${p.themeLabel} — ${p.signal.evidenceSummary}`;
    await _emit('knowledge', _event(p, 'knowledge', text, nowIso, { knowledge: fn }));
  }

  async function _revise(p, nowIso, staleDaysN) {
    const date = nowIso.slice(0, 10);
    const { content: existing, vec } = await _knowledgeRow(p.knowledge);
    const line = `${date} revised (confidence ${p.confidence} — no fresh evidence in ${staleDaysN} days)`;
    if (p.knowledge) {
      await setMemoryDerived(p.knowledge,
        appendHistory(existing, p.themeLabel, p.signal.evidenceSummary, date, line), {
          updatedBy: 'mind', layer: 'instance', embedding: vec,
          trustTier: trustTier.SYNTHESIZED, synthesizedVia: MIND_VIA, pinned: true,
        });
    }
    p.softenedAt = nowIso;
    const text = `I'm less sure about ${p.themeLabel} — the evidence has gone quiet (confidence ${p.confidence})`;
    await _emit('revision', _event(p, 'revision', text, nowIso, { knowledge: p.knowledge }));
  }

  async function _retire(p, nowIso) {
    const date = nowIso.slice(0, 10);
    if (p.knowledge) {
      const { content: existing, vec } = await _knowledgeRow(p.knowledge);
      await setMemoryDerived(p.knowledge,
        appendHistory(existing, p.themeLabel, p.signal.evidenceSummary, date,
          `${date} retired (confidence ${p.confidence})`), {
          updatedBy: 'mind', layer: 'instance', embedding: vec,
          trustTier: trustTier.SYNTHESIZED, synthesizedVia: MIND_VIA, pinned: true,
        });
      // reversible, never deleted — tagged 'mind-retirement' (elifant#9) so
      // this row, unlike a decay-archived one, still reads as evidence loss
      // if anything ever re-derived a pattern from a knowledge row itself
      // (nothing does today, but the reason should be honest regardless).
      await setMemoryArchive(p.knowledge, true, archiveReason.MIND_RETIREMENT);
    }
    p.status = 'retired';
    const text = `letting go of ${p.themeLabel} — the evidence went quiet (confidence ${p.confidence})`;
    await _emit('retirement', _event(p, 'retirement', text, nowIso, { knowledge: p.knowledge, retired: true }));
  }

  /**
   * One bounded pass. Returns a receipt {at, upserted, promoted, revised,
   * retired, revived, culled, forming, hardened, patterns} — every number
   * re-derives from the ledger rows this tick wrote.
   *
   * opts.now (ISO string) overrides the clock — test hook, keeper `batch` twin.
   * Write volume is O(shelves) — dozens of rows, far under the kernel-ethic
   * #11 bulk threshold; inside keeperTick the keeper's own snapshot guard has
   * already run ahead of this pass.
   */
  async function tick(opts) {
    // opts = {} only guards undefined, not an explicit null (mindTick(null)
    // and keeperTick({mind:null}) before its own guard both pass one through)
    // — normalize here, at the one place every caller funnels through.
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS, opts);
    const nowIso = opts.now || ts();
    const nowMs = Date.parse(nowIso);
    const receipt = { at: nowIso, upserted: 0, promoted: 0, revised: 0, retired: 0, revived: 0, culled: 0, guarded: 0, forming: 0, hardened: 0, patterns: 0 };

    const patterns = await _ledger();
    const cands = await _candidates();
    const vecById = new Map(cands.map((c) => [c.id, c.vec]));

    // 0. RESOLVE IDENTITY (elifant#18). Which ledger pattern does each
    //    candidate producer row continue? A direct hit on the pattern's id, or
    //    on any producer row it has carried before, answers it for everything
    //    that never fully dissolved — that is the ordinary case and costs one
    //    map lookup.
    const byId = new Map([...patterns.values()].map((p) => [p.id, p]));
    const byAlias = new Map();
    for (const p of patterns.values()) for (const a of p.aliases || []) byAlias.set(a, p);
    const resolved = new Map(); // candidate id -> the ledger pattern it continues
    const held = new Set();     // ...and the pattern ids already spoken for
    for (const c of cands) {    // identity first: a pattern's own id outranks
      const p = byId.get(c.id); // any alias it has picked up since.
      if (p) { resolved.set(c.id, p); held.add(p.id); }
    }
    // An alias only binds while nothing else is carrying that pattern. Both can
    // be live at once — an archived shelf CAN be un-archived — and one pattern
    // may only be the continuation of one of them; the other falls through to
    // the pass below and gets a life of its own rather than being swallowed.
    for (const c of cands) {
      if (resolved.has(c.id)) continue;
      const p = byAlias.get(c.id);
      if (p && !held.has(p.id)) { resolved.set(c.id, p); held.add(p.id); }
    }
    // Anything left is a producer row nobody recognizes — the archive-and-
    // reform case. Offer those candidates the patterns no live candidate is
    // carrying this tick (an ORPHAN: its own shelf is archived or gone). A
    // pattern whose shelf is still live is never on offer, so a cluster that
    // merely SPLIT can never steal the surviving half's identity.
    const unrecognized = cands.filter((c) => !resolved.has(c.id));
    if (unrecognized.length) {
      const orphans = [...patterns.values()].filter((p) => !held.has(p.id));
      if (orphans.length) {
        const orphanShapes = [];
        for (const p of orphans) {
          orphanShapes.push({
            id: p.id, kind: p.kind, liveRefs: await _liveRefNames(p),
            threadSig: themeSignature(p.themeLabel),
          });
        }
        const adopted = adoptionClaims(
          unrecognized.map((c) => ({
            id: c.id, kind: c.kind,
            members: c.refs.map((r) => r.filename),
            threadSig: themeSignature(c.themeLabel),
          })),
          orphanShapes
        );
        for (const [cid, pid] of adopted) {
          const p = patterns.get(pid);
          // The pattern keeps its id, its threadKey, its knowledge row and its
          // history — that IS the continuity, and it means a host threading
          // events by threadKey never sees the seam. Only the producer list
          // grows, and it is the ledger row's own durable record that this
          // pattern has been carried by more than one shelf.
          p.aliases = [...(p.aliases || []).filter((a) => a !== cid), cid].slice(-MAX_ALIASES);
          resolved.set(cid, p);
          held.add(p.id);
        }
      }
    }

    // 1. upsert candidates (merge signal; keep the stable born; first sighting
    //    emits the forming-band `pattern` capture; fresh evidence revives the
    //    retired — the ladder goes both ways).
    for (const c of cands) {
      const ex = resolved.get(c.id); // NOT patterns.get(c.id): an adopted
                                     // pattern's id is its FIRST producer row.
      if (ex) {
        const fresh = c.last > (ex.signal.last || 0);
        ex.signal = { n: c.n, born: Math.min(ex.born || c.born, c.born), last: c.last, refs: c.refs, evidenceSummary: c.evidenceSummary };
        ex.born = Math.min(ex.born || c.born, c.born);
        ex.last = c.last;
        ex.themeLabel = c.themeLabel;
        ex.guard = c.guard;
        if (ex.status === 'retired' && fresh) {
          ex.status = 'forming';
          ex.softenedAt = null;
          ex.confidence = confidence({ n: c.n, last: c.last }, nowMs, cfg);
          receipt.revived++;
          // Crisis-guarded evidence is tracked but never narrated (elifant#17)
          // — echoing it into a feed is its own harm.
          if (ex.guard !== 'crisis') {
            await _emit('pattern', _event(ex, 'pattern',
              `this is forming again: ${ex.themeLabel} — ${ex.signal.evidenceSummary}`, nowIso));
          }
        }
      } else {
        const p = {
          id: c.id, kind: c.kind, theme: c.theme, themeLabel: c.themeLabel,
          threadKey: threadKey(c.theme),
          signal: { n: c.n, born: c.born, last: c.last, refs: c.refs, evidenceSummary: c.evidenceSummary },
          confidence: confidence({ n: c.n, last: c.last }, nowMs, cfg),
          status: 'forming', born: c.born, last: c.last, softenedAt: null, knowledge: null,
          guard: c.guard, guardAnnounced: null,
        };
        patterns.set(p.id, p);
        resolved.set(c.id, p);
        receipt.upserted++;
        // Crisis-guarded evidence is tracked (auditable in the ledger and the
        // `guarded` count) but never narrated (elifant#17): the normal path
        // never gets here — the Keeper's shelving override means no crisis
        // shelf exists — but a hand-built or imported shelf must not have its
        // darkest line echoed back as a cheery "a pattern is forming" capture.
        if (p.guard !== 'crisis') {
          await _emit('pattern', _event(p, 'pattern',
            `a pattern is forming around ${p.themeLabel} — ${p.signal.evidenceSummary}`, nowIso));
        }
      }
    }

    // Every ledger pattern a live candidate is carrying this tick, keyed by
    // PATTERN id — which after an adoption is not the candidate's id, so the
    // two steps below can no longer ask "is my own id a candidate?".
    const carried = new Set([...resolved.values()].map((p) => p.id));
    // ...and the fresh shelf embeddings re-keyed the same way, so an adopted
    // pattern's re-promotion carries the NEW shelf's scent rather than
    // silently falling back to the old knowledge row's.
    const vecByPattern = new Map();
    for (const [cid, p] of resolved) vecByPattern.set(p.id, vecById.get(cid) || null);

    // 2. recompute confidence for EVERY pattern. A pattern whose shelf
    //    dissolved recounts its evidence from still-live refs — losing the
    //    memories IS losing the pattern, without waiting for the calendar.
    for (const p of patterns.values()) {
      if (!carried.has(p.id)) {
        p.signal.n = await _liveRefCount(p);
      }
      p.confidence = confidence({ n: p.signal.n, last: p.signal.last }, nowMs, cfg);
    }

    // 3. transitions + persist.
    for (const p of patterns.values()) {
      if (promotable(p, nowMs, cfg)) {
        // The Guard (elifant#16/#17) — the permanent WHAT-ABOUT floor under
        // the ladder. Deliberately NOT cfg-driven: no per-tick option, shell
        // setting, or keyholder dial reaches it (#14's "non-negotiable
        // regardless of dials"). A pattern whose shelf was live this tick
        // carries a fresh verdict from _candidates(); a dissolved-shelf or
        // pre-guard ledger row re-derives from its live refs.
        const guard = p.guard !== undefined ? p.guard : await _guardFromRefs(p);
        p.guard = guard;
        if (guard) {
          receipt.guarded++;
          // The refusal is visible ONCE per reason (K-CARBON-4: no silent
          // ladder decisions), then quiet — a floor, not a nag. A 'crisis'
          // hold is the exception: never narrated back (elifant#17).
          if (p.guardAnnounced !== guard && guard !== 'crisis') {
            const why = guard === 'third-party'
              ? "it's about someone who isn't you, so it stays observations — never a verdict"
              : `it touches ${guard.replace(/^domain:/, '')}, which never hardens into knowledge`;
            await _emit('guard', _event(p, 'guard',
              `this keeps coming up — ${p.themeLabel} — but ${why}`, nowIso, { guard }));
            p.guardAnnounced = guard;
          }
        } else {
          await _promote(p, nowIso, vecByPattern.get(p.id) || null);
          receipt.promoted++;
        }
      } else if (p.status === 'hardened') {
        if (p.confidence < cfg.retireConf) {
          await _retire(p, nowIso);
          receipt.retired++;
        } else if (p.confidence < cfg.reviseConf && !p.softenedAt) {
          const staleDaysN = Math.round((nowMs - (p.signal.last || nowMs)) / 86400000);
          await _revise(p, nowIso, staleDaysN);
          receipt.revised++;
        } else if (p.softenedAt && p.confidence >= cfg.reviseConf) {
          p.softenedAt = null; // recovered — a later second decline is visible again
        }
      } else if (p.status === 'forming' && !carried.has(p.id) && p.confidence < cfg.retireConf) {
        // A fizzle: never hardened, shelf gone, evidence cold. Cull the ledger
        // row quietly (narrating every fizzle would be noise, not honesty —
        // nothing the keyholder was ever told about is disappearing).
        patterns.delete(p.id);
        await deleteState(STATE_PREFIX + p.id);
        receipt.culled++;
        continue;
      }
      await _save(p);
      if (p.status === 'forming') receipt.forming++;
      else if (p.status === 'hardened') receipt.hardened++;
    }
    receipt.patterns = patterns.size;

    // 4. epoch — the mind's own birthday, written once, after the first
    //    successful pass (write-last so a failed genesis re-runs, never
    //    stranding promoted knowledge with no epoch).
    const epoch = await getState(EPOCH_KEY);
    if (!epoch) await setState(EPOCH_KEY, JSON.stringify({ t: nowIso }), 'mind');

    await _setMeta('mind_last_tick', JSON.stringify(receipt));
    return receipt;
  }

  async function status() {
    const [epochRow, ledger, lastTick] = await Promise.all([
      getState(EPOCH_KEY), _ledger(), _meta('mind_last_tick'),
    ]);
    let epoch = null;
    try { epoch = epochRow ? JSON.parse(epochRow.value) : null; } catch { epoch = null; }
    let last = null;
    try { last = lastTick ? JSON.parse(lastTick) : null; } catch { last = null; }
    let forming = 0, hardened = 0, retired = 0;
    for (const p of ledger.values()) {
      if (p.status === 'forming') forming++;
      else if (p.status === 'hardened') hardened++;
      else if (p.status === 'retired') retired++;
    }
    const day = epoch ? Math.floor((Date.now() - Date.parse(epoch.t)) / 86400000) + 1 : 0;
    return { day, forming, hardened, retired, patterns: ledger.size, lastTick: last };
  }

  return { tick, status };
}

module.exports = {
  createMind,
  // pure helpers, exported for the test suite
  confidence,
  promotable,
  threadKey,
  threadOf,
  themeSignature,
  adoptionClaims,
  slug,
  renderKnowledge,
  appendHistory,
  MIND_VIA,
  STATE_PREFIX,
  EPOCH_KEY,
  KNOWLEDGE_PREFIX,
  DEFAULTS,
};
