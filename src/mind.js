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
 *   3. upserts candidates into the ledger; a first sighting emits a `pattern`
 *      capture (the forming band);
 *   4. recomputes confidence for EVERY pattern — including ones whose shelf
 *      dissolved: their n recomputes from still-live refs, so deletion and
 *      edit-away are contradiction, mechanically, not just staleness;
 *   5. transitions:
 *        forming  + conf >= 0.8 && n >= 5 && age >= 24h  -> PROMOTE: a durable
 *                   pinned knowledge memory (tier-2-synthesized, producer
 *                   'mind/promotion-v1', receipt history in the row itself)
 *                   + a `knowledge` capture — UNLESS the Guard holds it:
 *                   a pattern whose evidence is about a person who is not
 *                   the keyholder (elifant#16; guard.js) NEVER promotes, at
 *                   any confidence/n/age, under any per-tick option. The
 *                   refusal is visible once (a `guard` capture), then quiet;
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
 * SEAM RESERVED (elifant#6): near-duplicate families are pairs — below
 * MIN_SHELF, deliberately not shelves. When #6 lands, a dup cluster can feed
 * the same candidate interface; nothing here needs to change shape.
 * SEAM RESERVED (detector B, fast-follow): capture-theme recurrence — hosts
 * emitting addCapture({data:{theme}}) — feeds the same interface too; that is
 * how Allen-on-kernel keeps Minecraft semantics host-side forever.
 *
 * KNOWN GAP: pattern identity is the LIVE shelf's filename (`'shelf:' +
 * filename`). A shelf that shrinks and grows without ever fully dissolving
 * keeps its filename (keeper.js's matchClusters continuity), so revival works
 * — see the "fresh evidence revives" test. But if the shelf's cluster drops
 * below MIN_SHELF and the Keeper actually ARCHIVES it, `_liveShelves()` stops
 * returning it, so a later reforming of the same subject gets a brand-new
 * shelf filename (shelfSlug's collision loop won't reuse an archived-but-not-
 * deleted name) — a new, unrelated pattern id. The old retired pattern can
 * never revive; its knowledge memory's history sits orphaned instead of
 * gaining a "promoted again" line. Not a crash, not silent data loss (the old
 * knowledge memory is still there, still readable) — just broken continuity
 * for one specific round-trip. Fix would be identity keyed on theme/content
 * rather than the live filename; deferred, not attempted here.
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

function promotable(p, nowMs, cfg = DEFAULTS) {
  const ageH = (nowMs - (p.born || nowMs)) / 3600000;
  return p.status === 'forming'
    && p.confidence >= cfg.promoteConf
    && (p.signal.n || 0) >= cfg.promoteN
    && ageH >= cfg.promoteAgeH;
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
 *   setMemoryArchive(fn, bool)  reversible knowledge retirement
 *   getState/setState/deleteState  the pattern ledger + epoch
 *   ts()                        kernel timestamp
 *   trustTier                   TRUST_TIER constants
 */
function createMind(ctx) {
  const { query, addCapture, setMemoryDerived, setMemoryArchive, getState, setState, deleteState, ts, trustTier } = ctx;

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

  // Same source-eligibility predicate as the Keeper: live, unarchived, not
  // derived, the keyholder's own words. Evidence never counts anything else.
  const SOURCE_WHERE = `deleted_at IS NULL AND archived = false AND synthesized_via IS NULL ` +
    `AND trust_tier = '${trustTier.KEYHOLDER_DIRECT}'`;

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

  // Every live Keeper shelf is a pattern candidate. n / born / last derive
  // from the LIVE member rows, not the shelf text — deletions count against
  // the pattern the moment they happen.
  async function _candidates() {
    const shelves = await query(
      `SELECT filename, content, embedding::text AS vec FROM memories
       WHERE synthesized_via = $1 AND deleted_at IS NULL AND archived = false`, [SHELVING_VIA]
    );
    const out = [];
    for (const s of shelves.rows) {
      const members = [];
      for (const m of String(s.content || '').matchAll(/^- (\S+)(?: |$)/gm)) members.push(m[1]);
      if (!members.length) continue;
      const live = await query(
        `SELECT filename, updated_at, content FROM memories WHERE filename = ANY($1::text[]) AND ${SOURCE_WHERE}`,
        [members]
      );
      const rows = live.rows;
      if (rows.length < DEFAULTS.minPatternN) continue; // dissolving — the keeper will archive it
      const times = rows.map((r) => Date.parse(r.updated_at)).filter(Number.isFinite);
      const born = Math.min(...times);
      const last = Math.max(...times);
      const thread = threadOf(s.content);
      const label = thread.length ? thread.join(', ') : 'similar things';
      const days = Math.max(1, Math.round((last - born) / 86400000));
      out.push({
        id: 'shelf:' + s.filename,
        kind: 'shelf-recurrence',
        theme: s.filename,
        themeLabel: label,
        n: rows.length,
        born, last,
        refs: rows.slice(0, DEFAULTS.maxRefs).map((r) => ({ filename: r.filename, day: String(r.updated_at).slice(0, 10) })),
        evidenceSummary: thread.length
          ? `${rows.length} memories about ${label} over ${days} day${days === 1 ? '' : 's'}`
          : `${rows.length} memories saying similar things over ${days} day${days === 1 ? '' : 's'}`,
        vec: s.vec ? String(s.vec).replace(/^\[|\]$/g, '').split(',').map(Number) : null,
        // The Guard's verdict over the LIVE evidence (elifant#16) — recomputed
        // every tick from the member rows themselves, so an edit that changes
        // what the cluster is about changes the verdict with it.
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

  // How many of a pattern's recorded refs are still live keyholder rows? The
  // decay path for a dissolved shelf: evidence loss IS contradiction.
  async function _liveRefCount(p) {
    const names = (p.signal.refs || []).map((r) => r.filename);
    if (!names.length) return 0;
    const r = await query(
      `SELECT count(*)::int AS n FROM memories WHERE filename = ANY($1::text[]) AND ${SOURCE_WHERE}`, [names]
    );
    return r.rows[0].n;
  }

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
      await setMemoryArchive(p.knowledge, true); // reversible, never deleted
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
    const candIds = new Set(cands.map((c) => c.id));
    const vecById = new Map(cands.map((c) => [c.id, c.vec]));

    // 1. upsert candidates (merge signal; keep the stable born; first sighting
    //    emits the forming-band `pattern` capture; fresh evidence revives the
    //    retired — the ladder goes both ways).
    for (const c of cands) {
      const ex = patterns.get(c.id);
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
          await _emit('pattern', _event(ex, 'pattern',
            `this is forming again: ${ex.themeLabel} — ${ex.signal.evidenceSummary}`, nowIso));
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
        receipt.upserted++;
        await _emit('pattern', _event(p, 'pattern',
          `a pattern is forming around ${p.themeLabel} — ${p.signal.evidenceSummary}`, nowIso));
      }
    }

    // 2. recompute confidence for EVERY pattern. A pattern whose shelf
    //    dissolved recounts its evidence from still-live refs — losing the
    //    memories IS losing the pattern, without waiting for the calendar.
    for (const p of patterns.values()) {
      if (!candIds.has(p.id)) {
        p.signal.n = await _liveRefCount(p);
      }
      p.confidence = confidence({ n: p.signal.n, last: p.signal.last }, nowMs, cfg);
    }

    // 3. transitions + persist.
    for (const p of patterns.values()) {
      if (promotable(p, nowMs, cfg)) {
        // The Guard (elifant#16) — the permanent WHAT-ABOUT floor under the
        // ladder. Deliberately NOT cfg-driven: no per-tick option, shell
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
          await _promote(p, nowIso, vecById.get(p.id) || null);
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
      } else if (p.status === 'forming' && !candIds.has(p.id) && p.confidence < cfg.retireConf) {
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
  slug,
  renderKnowledge,
  appendHistory,
  MIND_VIA,
  STATE_PREFIX,
  EPOCH_KEY,
  KNOWLEDGE_PREFIX,
  DEFAULTS,
};
