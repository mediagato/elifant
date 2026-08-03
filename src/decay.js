/**
 * Decay — the kernel's forgetting curve (elifant#9): "decay toward the
 * archive, never delete." Before this, nothing ever left the active set
 * unless a human archived it by hand (app/api.js) or the Mind retired its own
 * knowledge row (mind.js's _retire, elifant#5) — every untouched, never-
 * recalled, low-value capture accumulated forever. Combined with no semantic
 * dedup (elifant#6/#7), the store only ever grew, which is exactly why
 * auto-inject had to be strangled to ONE memory at the strict floor: nothing
 * was ever taken OFF the shelf, so the shelf just got more crowded.
 *
 * WHAT A TICK DOES — one bounded pass, fully re-derived from live state every
 * time (no ledger to drift, no watermark to lose — same idempotent-by-
 * recomputation idiom as the Keeper's own shelving pass):
 *   1. reads up to DEFAULTS.scanLimit eligible rows, oldest-edited first;
 *   2. for each, computes its earned recall strength (elifant#8's own
 *      ln(1+n) * 2^(-days/halfLife) curve — reused via ctx.strengthOf, not
 *      re-derived, so this can never quietly drift from what the fusion
 *      actually ranks by);
 *   3. archives (reason: 'decay') every row that is both OLD ENOUGH (untouched
 *      since decayAgeDays ago) and WEAK ENOUGH (strength under
 *      decayStrengthFloor), up to DEFAULTS.batch per tick — bounded write
 *      volume, and a snapshot-before-bulk guard (kernel-ethic #11) if a tick's
 *      planned writes ever exceed BULK_SNAPSHOT_ROWS;
 *   4. narrates each one as a receipted capture {source:'decay'} — visible,
 *      never silent (K-CARBON-4).
 *
 * THE CANDIDATE PREDICATE — three gates, all mechanical, no model, matching
 * the issue's own three words: "untouched, never-recalled, low-strength."
 *
 *   ELIGIBLE AT ALL: trust_tier = keyholder-direct (the keyholder's own raw
 *   words — never a synthesized row; the Keeper and the Mind already retire
 *   their own derived rows through their own mechanisms and decay has no
 *   business touching either), NOT pinned, not already archived, not deleted.
 *   Pinned is the sanctioned vouch (decision-a) and a PERMANENT exemption —
 *   note this also protects every Mind-grown knowledge row for free, since
 *   _promote() already pins every one it writes (mind.js). This is what the
 *   issue's "never removes a pinned or keyholder-authored row" means in
 *   practice: the trust-tier + pinned gates ARE the protection, not a
 *   separate carve-out — decay is scoped to keyholder-direct rows in the
 *   first place, so it was never going to reach a synthesized or foreign row,
 *   and pinned removes the keyholder's own vouched-for rows from the pool too.
 *
 *   OLD ("untouched"): no edit — updated_at unchanged — for at least
 *   DECAY_AGE_DAYS (60). An edit is exactly what updated_at records, so age-
 *   since-last-edit already means "untouched." 60 is deliberately DOUBLE
 *   mind.js's own horizonDays (30): the Mind's confidence curve already
 *   reaches zero recency at 30 days on a PATTERN's member rows, and letting
 *   decay use that same window would mean decay could archive a row before
 *   the Mind has even finished judging its own pattern's staleness from it.
 *   Doubling gives decay a full extra cycle of headroom, so it is always the
 *   Mind's own recency math that resolves a pattern's fate first; decay only
 *   ever adds a second, independent, slower pressure underneath.
 *
 *   WEAK ("never-recalled"): earned strength below DECAY_STRENGTH_FLOOR
 *   (0.1), using elifant#8's own curve. A row with no memory_access row at
 *   all (truly never recalled) scores 0 — comfortably under the floor, which
 *   is the issue's "never-recalled" case exactly. A row recalled once and
 *   never again crosses back OVER the floor for roughly the first 90 days
 *   after that recall (ln(2) * 2^(-90/30) ~= 0.087 < 0.1 is where it finally
 *   drops below), so a single genuine recall buys real, calendar-scaled
 *   protection — proportionally more for a row recalled twice or more (the
 *   same log curve the fusion ranks by), never a permanent shield.
 *
 * WHAT DECAY IS NOT: retraction. See mind.js's header for the full argument —
 * in short, a decay-archived row was never contradicted, never edited away,
 * nobody said it was wrong. Disuse is not disagreement, so mind.js's
 * SOURCE_WHERE treats a decay-archived row as still-live EVIDENCE, while a
 * keyholder-archived or deleted row still counts as evidence loss exactly as
 * it did before this issue shipped. archived_reason (index.js) is the
 * mechanism that lets the Mind tell the two apart; decay.js only ever writes
 * ARCHIVE_REASON.DECAY through it.
 *
 * REVERSIBLE, ALWAYS. Un-decaying a row is not a special decay-side
 * operation — it is the same generic primitive every archive already uses:
 * setMemoryArchive(filename, false). That call clears both `archived` and
 * `archived_reason` unconditionally (index.js), so a keyholder (or a shell
 * surface built on getAllMemories({onlyArchived:true}), which surfaces
 * archived_reason precisely so a host can render "why archived" and offer
 * "bring this back") gets the row back exactly as it was, with no residue.
 *
 * WHAT IT WILL NEVER DO
 *   - touch a model (deterministic thresholds only, same INV as the Keeper
 *     and the Mind: no require beyond what index.js hands in);
 *   - decay a synthesized row, a pinned row, or anything not keyholder-direct;
 *   - delete anything — archive only, and only with reason 'decay';
 *   - decide silently — every row it archives is a receipted capture.
 *
 * NOT WIRED INTO keeperTick(). mindTick() rides keeperTick's tail (0.23.0)
 * because the Mind reads the Keeper's own fresh output every pass; decay has
 * no such dependency — it reads `memories` and `memory_access` directly and
 * runs on its own clock. A host that wants decay running automatically calls
 * decayTick() on whatever cadence it already polls keeperTick on (or less
 * often — decay's own age gate means calling it hourly vs. daily changes
 * nothing about which rows are eligible, only how promptly a newly-eligible
 * one is caught). Chaining it into keeperTick, if ever wanted, is a follow-on
 * change, not assumed here.
 */
'use strict';

const DEFAULTS = {
  decayAgeDays: 60,      // untouched (no edit) for at least this long — see header
  decayStrengthFloor: 0.1, // earned recall strength (elifant#8) below this is "weak"
  batch: 50,             // bounded writes per tick (mirrors keeper.js's QUEUE_BATCH)
  scanLimit: 500,        // bounded READ per tick — oldest-edited-first candidates considered
};

const BULK_SNAPSHOT_ROWS = 100; // kernel-ethic #11: snapshot before a >100-row archive pass

/**
 * createDecay(ctx) — wired by index.js with kernel internals (keeper/mind twins):
 *   query(sql, params)          raw read/write on the live store
 *   addCapture(cap)             visible receipt emission (source:'decay')
 *   setMemoryArchive(fn, bool, reason)  reversible archive, reason-tagged
 *   snapshot(reason, opts)      kernel-ethic #11 guard
 *   ts()                        kernel timestamp
 *   trustTier                   TRUST_TIER constants
 *   archiveReason                ARCHIVE_REASON constants
 *   strengthOf(accessCount, lastAccessed)  elifant#8's own strength curve —
 *                                REUSED, not re-derived, so this can never
 *                                drift from what the fusion actually ranks by
 */
function createDecay(ctx) {
  const { query, addCapture, setMemoryArchive, snapshot, ts, trustTier, archiveReason, strengthOf } = ctx;

  async function _meta(key) {
    const r = await query('SELECT value FROM brain_meta WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  }
  async function _setMeta(key, value) {
    await query(
      'INSERT INTO brain_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
  }

  // Snapshot-before-bulk (kernel-ethic #11), same shape as keeper.js's
  // _maybeSnapshot: a genuinely bulk pass ALWAYS snapshots first — the
  // ethic's MUST has no throttle clause — while a small pass (the default
  // batch of 50 sits comfortably under BULK_SNAPSHOT_ROWS) only snapshots if
  // nothing is on record yet.
  async function _maybeSnapshot(plannedRows) {
    const last = await _meta('decay_last_snapshot');
    if (last && plannedRows <= BULK_SNAPSHOT_ROWS) return false;
    await snapshot('decay pass (pre-write guard)', { trigger: 'decay' });
    await _setMeta('decay_last_snapshot', ts());
    return true;
  }

  // Candidates: eligible at all (trust_tier keyholder-direct, unpinned, live,
  // unarchived) AND old enough (updated_at at least decayAgeDays ago). The
  // strength gate is applied in JS below, against memory_access joined in
  // here — a LEFT JOIN so a never-recalled row (no memory_access row at all)
  // still comes back, with access_count/last_accessed both null.
  async function _oldCandidates(cutoffIso, scanLimit) {
    const r = await query(
      `SELECT m.filename, m.updated_at, ma.access_count, ma.last_accessed
       FROM memories m
       LEFT JOIN memory_access ma ON ma.filename = m.filename
       WHERE m.deleted_at IS NULL AND m.archived = false AND m.pinned = false
         AND m.synthesized_via IS NULL AND m.trust_tier = $1
         AND m.updated_at <= $2
       ORDER BY m.updated_at ASC, m.filename ASC
       LIMIT $3`,
      [trustTier.KEYHOLDER_DIRECT, cutoffIso, scanLimit]
    );
    return r.rows;
  }

  function _event(row, strength, nowIso) {
    return {
      t: nowIso, filename: row.filename, strength,
      text: `this hasn't come up in a while, so I'm setting it aside — reversible any time: ${row.filename}`,
    };
  }

  /**
   * One bounded pass. Returns a receipt {at, scanned, decayed, snapshotTaken}.
   * opts.now (ISO string) overrides the clock — test hook, same convention as
   * mind.js's tick(opts.now).
   */
  async function tick(opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS, opts);
    const nowIso = opts.now || ts();
    const nowMs = Date.parse(nowIso);
    const cutoffIso = new Date(nowMs - cfg.decayAgeDays * 86400000).toISOString();

    const old = await _oldCandidates(cutoffIso, cfg.scanLimit);
    const weak = [];
    for (const row of old) {
      const strength = strengthOf(row.access_count || 0, row.last_accessed);
      if (strength < cfg.decayStrengthFloor) weak.push({ row, strength });
      if (weak.length >= cfg.batch) break; // bounded write volume, oldest-first
    }

    const snapshotTaken = weak.length ? await _maybeSnapshot(weak.length) : false;

    for (const { row, strength } of weak) {
      await setMemoryArchive(row.filename, true, archiveReason.DECAY);
      await addCapture({ source: 'decay', type: 'decayed', data: _event(row, strength, nowIso) });
    }

    const receipt = { at: nowIso, scanned: old.length, decayed: weak.length, snapshotTaken };
    await _setMeta('decay_last_tick', JSON.stringify(receipt));
    return receipt;
  }

  async function status() {
    const last = await _meta('decay_last_tick');
    let lastTick = null;
    try { lastTick = last ? JSON.parse(last) : null; } catch { lastTick = null; }
    return { lastTick };
  }

  return { tick, status };
}

module.exports = {
  createDecay,
  DEFAULTS,
};
