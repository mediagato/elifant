/**
 * The Keeper — the kernel's idle-time librarian (elifant#1/#2/#3, first tick).
 *
 * Everything below the retrieval line in this kernel is hardened storage:
 * causal version vectors, tombstones, snapshots, signed portability. Nothing
 * above it existed — no consolidation, no linking, no derived memories, and
 * three shipped surfaces polling for thinking nobody produced. The Keeper is
 * the first faculty above that line: it sorts like things together and says
 * what it noticed, deterministically.
 *
 * WHAT A TICK DOES
 *   1. prunes edges whose endpoints died (tombstoned / archived rows);
 *   2. drains a bounded batch of the NEIGHBOUR QUEUE — memories whose
 *      `neighbours_at` is NULL — computing each row's nearest neighbours over
 *      the embeddings that already exist and writing them to `memory_edges`;
 *   3. recomputes SHELVES from the edge graph: connected components (strict-
 *      floor edges, minimum three members) become derived memory rows —
 *      trust_tier 'tier-2-synthesized', synthesized_via 'keeper/shelving-v1',
 *      content listing every member it was built from (the receipt IS the
 *      content), embedding = normalized mean of the members' vectors;
 *   4. emits THOUGHTS as captures {source:'thought'} — the feed the bowl's
 *      ticker has polled since the day it shipped — each carrying a reasoning
 *      receipt {lens, considered, released} that re-derives from the ledger.
 *
 * THE QUEUE IS THE WATERMARK (elifant#1's durability requirement). Progress
 * is per-row: a memory leaves the queue only when its own edges are written
 * (`neighbours_at` set), so a mid-tick kill redoes at most the row in flight
 * and skips nothing. A content edit NULLs `neighbours_at` (same statement
 * that drops the stale embedding), so edited memories re-enter the queue by
 * the same mechanism as new ones. Imported souls arrive with `neighbours_at`
 * NULL — the Keeper meets newcomers by reading them. Missed nights collapse:
 * the queue doesn't care when it is drained, only that it is. O(new), never
 * O(history).
 *
 * WHAT IT WILL NEVER DO
 *   - touch a model. The noticing is arithmetic and counting; every word of a
 *     thought is assembled from ledger facts. (INV: no require of anything
 *     beyond what index.js hands in.)
 *   - modify a source row's content, tier, or causal history. Sources gain
 *     only `neighbours_at` (derived bookkeeping, unstamped — the same class
 *     of write as setMemoryEmbedding). Shelves are NEW rows; nothing is ever
 *     silently merged or promoted (K-CARBON-4).
 *   - score the keyholder. Shelf and thought copy describes what is on the
 *     ledger ("3 of your memories are about the garden"), never a verdict.
 *   - shelve anything but the keyholder's own words: sources are tier-1 rows
 *     only. Observed-external (tier-3) and raw exhaust (tier-4) never blend
 *     into something marked synthesized.
 *
 * KNOWN V1 WRINKLE: a shelf that round-trips through YOINK/SUMMON keeps its
 * tier-2 but loses synthesized_via (the soul format predates the column), so
 * the receiving Keeper treats it as content, not as one of its own shelves.
 * Harmless — it can no longer be auto-archived, that's all. A protocol rev
 * that carries the column is the fix, not a v1 hack.
 *
 * SINCE 0.23.0 the kernel's keeperTick() also drives the Mind's promotion
 * pass over the fresh shelves (src/mind.js, elifant#5). The Keeper itself
 * still NEVER promotes — the Mind promotes visibly, under its own producer
 * tag, per its own contract.
 */
'use strict';

// Tunables. Distances are pgvector cosine distances (smaller = more similar).
// EDGE_KEEP reuses the kernel's loose RECALL floor (the graph remembers weak
// links so future passes can reason about them), but SHELF binding is its own,
// much tighter calibration: memory-to-memory distances run far closer than
// query-to-memory relevance. Calibrated 2026-07-30 on the first real corpus
// (29 browser-captured memories, nomic Nose): genuinely same-subject pairs
// landed at 0.01-0.10, while UNRELATED captures sat at only 0.13-0.15 because
// the capture template's shared boilerplate dominates their embeddings — at
// the recall floor (0.33) transitive chaining fused 22 of 29 memories into
// one shelf whose "common thread" was the template's own words. 0.12 carves
// that corpus correctly. Re-examine when birth quality improves (mrmags#8) or
// the Nose changes; an ambient-distance-adaptive floor is the follow-up idea.
const NEIGHBOUR_K = 8;            // edges considered per queued memory
const EDGE_KEEP_FLOOR = 0.40;     // store the edge at all (graph memory)
const SHELF_EDGE_FLOOR = 0.12;    // an edge tight enough to bind a shelf
const MIN_SHELF = 3;              // pairs are near-dup territory (elifant#6), not a shelf
const QUEUE_BATCH = 50;           // bounded work per tick
const FIRST_LIGHT_MIN_CORPUS = 8; // below this, everything is new territory — stay quiet
const BULK_SNAPSHOT_ROWS = 100;   // kernel-ethic #11: snapshot before >100-row passes
const SNAPSHOT_THROTTLE_MS = 24 * 60 * 60 * 1000;
const SHELVING_VIA = 'keeper/shelving-v1';

const STOPWORDS = new Set(('a an and are as at be but by for from has have i if in into is it its me my not of on or ' +
  'our so that the their them they this to was we were what when which who will with you your just really very ' +
  'about after all also am any because been before can could did do does get got had he her him his how more most ' +
  'no now only other out over she should some than then there these up us use used want way well').split(' '));

function _tokens(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(/[a-z][a-z0-9']{2,}/g)) {
    const t = m[0];
    if (!STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

// The common thread across member contents: tokens present in >= 60% of the
// members (at least 2), at most three, ranked by DISTINCTIVENESS — presence
// inside the cluster divided by presence outside it. Without the outside leg,
// capture-template boilerplate ("auto-captured…") named every shelf on the
// first real corpus: it had perfect within-cluster frequency, because it has
// perfect frequency EVERYWHERE, which is exactly why it can't be a subject.
// Purely lexical and deterministic — a weak thread yields [], and the copy
// degrades honestly to "say similar things" rather than inventing a subject.
function commonThread(contents, outsideContents = []) {
  const df = new Map();
  for (const c of contents) {
    for (const t of _tokens(c)) df.set(t, (df.get(t) || 0) + 1);
  }
  const odf = new Map();
  for (const c of outsideContents) {
    for (const t of _tokens(c)) odf.set(t, (odf.get(t) || 0) + 1);
  }
  const need = Math.max(2, Math.ceil(contents.length * 0.6));
  const score = (t, n) => n / (1 + (odf.get(t) || 0));
  // score >= 1 = "at least as present inside the cluster as outside it" — a
  // token that fails this is corpus wallpaper, and an open slot in the top-3
  // never excuses it. Ties keep the keyholder's own word order ("ice, cream",
  // not "cream, ice") — first appearance in the members wins.
  const joined = contents.map((c) => String(c).toLowerCase()).join('\n');
  const pos = (t) => { const i = joined.indexOf(t); return i === -1 ? Infinity : i; };
  return [...df.entries()]
    .filter(([t, n]) => n >= need && score(t, n) >= 1)
    .sort((a, b) => (score(b[0], b[1]) - score(a[0], a[1])) || (pos(a[0]) - pos(b[0])) || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([t]) => t);
}

// Parse a vector's pgvector text form '[1,2,3]' into number[].
function _parseVec(text) {
  return String(text).replace(/^\[|\]$/g, '').split(',').map(Number);
}

// Normalized mean of member vectors — the shelf's own scent. Deterministic
// arithmetic, no model. Returns null if members disagree on dimension (a brain
// mid Nose-migration): the shelf simply isn't searchable until re-embed.
function meanVector(vectors) {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  if (!vectors.every((v) => v.length === dim)) return null;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) { sum[i] /= vectors.length; norm += sum[i] * sum[i]; }
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  return sum.map((x) => x / norm);
}

// Shelf content — the receipt IS the content. One writer, one format; the
// member lines are the durable membership record the next tick diffs against.
function renderShelf(members /* [{filename, day}] */, thread) {
  const head = `# on this shelf: ${members.length} memories`;
  const threadLine = thread.length ? `\ncommon thread: ${thread.join(', ')}\n` : '';
  const lines = members.map((m) => `- ${m.filename} (${m.day})`).join('\n');
  const foot = '_shelved by the keeper. every line above re-derives from the memories it names; ' +
    'the sources are untouched and this shelf can be archived without losing any of them._';
  return `${head}\n${threadLine}\n${lines}\n\n${foot}\n`;
}

function parseMembers(content) {
  const out = [];
  for (const m of String(content || '').matchAll(/^- (\S+)(?: |$)/gm)) out.push(m[1]);
  return out;
}

function shelfSlug(filename) {
  return 'shelf/' + String(filename).replace(/\.md$/i, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '.md';
}

// Union-find over strict-floor edges.
function components(edges /* [{a, b}] */) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const { a, b } of edges) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // deterministic root
  }
  const groups = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  }
  return [...groups.values()].map((g) => g.sort()).sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

// Match freshly computed clusters against the live shelves so a shelf keeps its
// filename as it grows (continuity beats churn). A cluster claims the shelf it
// overlaps most, needing >= half the smaller side; leftovers become new shelves;
// shelves no cluster claims get archived (reversible, never deleted).
function matchClusters(clusters, shelves /* [{filename, members}] */) {
  const claims = []; // {cluster idx, shelf filename, overlap}
  clusters.forEach((cluster, ci) => {
    const cset = new Set(cluster);
    for (const s of shelves) {
      const overlap = s.members.filter((m) => cset.has(m)).length;
      if (overlap >= Math.max(1, Math.ceil(Math.min(cluster.length, s.members.length) / 2))) {
        claims.push({ ci, shelf: s.filename, overlap });
      }
    }
  });
  claims.sort((a, b) => (b.overlap - a.overlap) || (a.shelf < b.shelf ? -1 : 1) || (a.ci - b.ci));
  const shelfTaken = new Set();
  const clusterMatched = new Map();
  for (const c of claims) {
    if (shelfTaken.has(c.shelf) || clusterMatched.has(c.ci)) continue;
    shelfTaken.add(c.shelf);
    clusterMatched.set(c.ci, c.shelf);
  }
  return { clusterMatched, shelfTaken };
}

/**
 * createKeeper(ctx) — wired by index.js with kernel internals:
 *   query(sql, params)          raw read/write on the live store
 *   addCapture(cap)             the captures ledger (thought emission)
 *   setMemoryDerived(...)       stamped write for tier-2 derived rows
 *   setMemoryArchive(fn, bool)  reversible shelf retirement
 *   snapshot(reason, opts)      kernel-ethic #11 guard
 *   ts()                        kernel timestamp
 *   trustTier                   TRUST_TIER constants
 */
function createKeeper(ctx) {
  const { query, addCapture, setMemoryDerived, setMemoryArchive, snapshot, ts, trustTier } = ctx;

  // The eligibility predicate for a SOURCE row (something the Keeper may read
  // and link): live, unarchived, not itself derived, and the keyholder's own
  // words — tier-3/4 never blends into anything marked synthesized. `alias`
  // qualifies the columns where a join makes bare names ambiguous.
  const sourceWhere = (alias = '') => {
    const p = alias ? `${alias}.` : '';
    return `${p}deleted_at IS NULL AND ${p}archived = false AND ${p}synthesized_via IS NULL ` +
      `AND ${p}trust_tier = '${trustTier.KEYHOLDER_DIRECT}'`;
  };
  const SOURCE_WHERE = sourceWhere();

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

  // Snapshot-before-bulk (kernel-ethic #11), throttled so a busy day costs one
  // snapshot, not one per tick. Also fires on the first pass ever: the Keeper
  // introduces a new class of writer, and integrity comes before cleverness.
  async function _maybeSnapshot(plannedRows) {
    const last = await _meta('keeper_last_snapshot');
    const due = !last || (Date.parse(ts()) - Date.parse(last)) > SNAPSHOT_THROTTLE_MS;
    if (!due) return false;
    if (last && plannedRows <= BULK_SNAPSHOT_ROWS) return false;
    await snapshot('keeper pass (pre-write guard)', { trigger: 'keeper' });
    await _setMeta('keeper_last_snapshot', ts());
    return true;
  }

  async function _neighbourQueue(limit) {
    const r = await query(
      `SELECT filename, embedding::text AS vec FROM memories
       WHERE embedding IS NOT NULL AND neighbours_at IS NULL AND ${SOURCE_WHERE}
       ORDER BY updated_at ASC, filename ASC LIMIT $1`, [limit]
    );
    return r.rows;
  }

  async function _corpusCount() {
    const r = await query(`SELECT count(*)::int AS n FROM memories WHERE embedding IS NOT NULL AND ${SOURCE_WHERE}`);
    return r.rows[0].n;
  }

  async function _pruneDeadEdges() {
    const r = await query(`
      DELETE FROM memory_edges e WHERE NOT EXISTS (
        SELECT 1 FROM memories m WHERE m.filename = e.a_filename AND ${sourceWhere('m')}
      ) OR NOT EXISTS (
        SELECT 1 FROM memories m WHERE m.filename = e.b_filename AND ${sourceWhere('m')}
      )`);
    return r.affectedRows || 0;
  }

  // Compute + persist one memory's neighbours. Returns its first-light verdict.
  async function _processRow(row, now) {
    await query('DELETE FROM memory_edges WHERE a_filename = $1 OR b_filename = $1', [row.filename]);
    const near = await query(
      `SELECT filename, (embedding <=> $1::vector) AS distance FROM memories
       WHERE embedding IS NOT NULL AND filename != $2 AND ${SOURCE_WHERE}
       ORDER BY embedding <=> $1::vector LIMIT $3`,
      [row.vec, row.filename, NEIGHBOUR_K]
    );
    let nearest = null;
    for (const n of near.rows) {
      const d = Number(n.distance);
      if (nearest == null || d < nearest.distance) nearest = { filename: n.filename, distance: d };
      if (d >= EDGE_KEEP_FLOOR) continue;
      const [a, b] = row.filename < n.filename ? [row.filename, n.filename] : [n.filename, row.filename];
      await query(
        `INSERT INTO memory_edges (a_filename, b_filename, distance, computed_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (a_filename, b_filename) DO UPDATE SET distance = EXCLUDED.distance, computed_at = EXCLUDED.computed_at`,
        [a, b, d, now]
      );
    }
    // Durable per-row progress — THE watermark. Set last, so a kill mid-row
    // redoes this row and loses nothing.
    await query('UPDATE memories SET neighbours_at = $1 WHERE filename = $2', [now, row.filename]);
    return nearest;
  }

  async function _liveShelves() {
    const r = await query(
      `SELECT filename, content FROM memories
       WHERE synthesized_via = $1 AND deleted_at IS NULL AND archived = false`, [SHELVING_VIA]
    );
    return r.rows.map((s) => ({ filename: s.filename, content: s.content, members: parseMembers(s.content) }));
  }

  async function _strictEdges() {
    const r = await query(`
      SELECT e.a_filename AS a, e.b_filename AS b FROM memory_edges e
      JOIN memories ma ON ma.filename = e.a_filename AND ${sourceWhere('ma')}
      JOIN memories mb ON mb.filename = e.b_filename AND ${sourceWhere('mb')}
      WHERE e.distance < $1`, [SHELF_EDGE_FLOOR]);
    return r.rows;
  }

  async function _memberDetails(filenames) {
    const r = await query(
      `SELECT filename, content, updated_at, embedding::text AS vec FROM memories
       WHERE filename = ANY($1::text[])`, [filenames]
    );
    const byName = new Map(r.rows.map((m) => [m.filename, m]));
    return filenames.map((f) => byName.get(f)).filter(Boolean);
  }

  async function _emitThought(type, thought, receipt) {
    return addCapture({ source: 'thought', type, data: { thought, ...receipt } });
  }

  /**
   * One bounded pass. Returns a receipt {processed, edges, firstLights,
   * shelvesWritten, shelvesArchived, thoughts, snapshotTaken, at} — every
   * number in it re-derives from the rows this tick wrote.
   */
  async function tick({ batch = QUEUE_BATCH } = {}) {
    const now = ts();
    const receipt = { at: now, processed: 0, firstLights: 0, shelvesWritten: 0, shelvesArchived: 0, thoughts: 0, prunedEdges: 0, snapshotTaken: false };

    receipt.prunedEdges = await _pruneDeadEdges();

    const queue = await _neighbourQueue(batch);
    if (queue.length) {
      receipt.snapshotTaken = await _maybeSnapshot(queue.length * NEIGHBOUR_K + MIN_SHELF);
    }

    const corpus = await _corpusCount();
    for (const row of queue) {
      const nearest = await _processRow(row, now);
      receipt.processed++;
      // First light: nothing the keyholder has saved is like this one. Only
      // said when the library is big enough for "unlike everything" to mean
      // something, and only once — the queue is the natural once-guard.
      if (corpus >= FIRST_LIGHT_MIN_CORPUS && (!nearest || nearest.distance >= EDGE_KEEP_FLOOR)) {
        await _emitThought('first-light',
          'this one is new territory — nothing else you have saved is like it',
          {
            lens: 'notice',
            considered: [row.filename],
            released: nearest ? [{ filename: nearest.filename, distance: Number(nearest.distance.toFixed(4)), why: 'nearest, but not close' }] : [],
          });
        receipt.firstLights++;
        receipt.thoughts++;
      }
    }

    // Shelving — recomputed from the whole (small) edge graph each tick, so it
    // is idempotent by construction: identical membership renders identical
    // content, and _stampWrite makes an identical re-save a causal no-op.
    const clusters = components(await _strictEdges()).filter((c) => c.length >= MIN_SHELF);
    const shelves = await _liveShelves();
    const { clusterMatched, shelfTaken } = matchClusters(clusters, shelves);
    const shelfByName = new Map(shelves.map((s) => [s.filename, s]));

    // Fetched once per tick, only when a shelf might be written: the outside-
    // cluster contents that let the thread namer tell a subject from template
    // boilerplate. Bounded (newest 1000) so shelf naming never becomes an
    // O(history) read on a big library.
    let corpusRows = null;

    for (let ci = 0; ci < clusters.length; ci++) {
      const cluster = clusters[ci];
      const details = await _memberDetails(cluster);
      if (details.length < MIN_SHELF) continue;
      if (corpusRows == null) {
        corpusRows = (await query(
          `SELECT filename, content FROM memories WHERE embedding IS NOT NULL AND ${SOURCE_WHERE}
           ORDER BY updated_at DESC LIMIT 1000`)).rows;
      }
      const inCluster = new Set(cluster);
      const outside = corpusRows.filter((r) => !inCluster.has(r.filename)).map((r) => r.content);
      const thread = commonThread(details.map((d) => d.content), outside);
      const members = details.map((d) => ({ filename: d.filename, day: String(d.updated_at).slice(0, 10) }));
      const content = renderShelf(members, thread);

      let target = clusterMatched.get(ci);
      let existing = target ? shelfByName.get(target) : null;
      if (!target) {
        target = shelfSlug(cluster[0]);
        // Only a truly absent (or tombstoned) filename is free: a keyholder's
        // own file must never be overwritten, and a LIVE unmatched shelf must
        // not be reused either — the end-of-tick sweep would archive it right
        // after this write. A tombstoned shelf resurrecting under the same
        // name is a legitimate causal event (_stampWrite dominates the delete).
        for (let suffix = 2; ; suffix++) {
          const clash = await query('SELECT 1 FROM memories WHERE filename = $1 AND deleted_at IS NULL', [target]);
          if (!clash.rows[0]) break;
          target = shelfSlug(cluster[0]).replace(/\.md$/, `-${suffix}.md`);
        }
      }

      if (existing && existing.content === content) continue; // nothing changed — honest silence

      const vec = meanVector(details.map((d) => _parseVec(d.vec)));
      await setMemoryDerived(target, content, {
        updatedBy: 'keeper', layer: 'instance', embedding: vec,
        trustTier: trustTier.SYNTHESIZED, synthesizedVia: SHELVING_VIA,
      });
      receipt.shelvesWritten++;

      const oldMembers = new Set(existing ? existing.members : []);
      const added = cluster.filter((m) => !oldMembers.has(m));
      if (!existing) {
        await _emitThought('shelf',
          thread.length
            ? `${cluster.length} of your memories are about ${thread.join(', ')} — I put them on one shelf`
            : `${cluster.length} of your memories say similar things — I put them on one shelf`,
          { lens: 'connect', considered: cluster, released: [], shelf: target });
        receipt.thoughts++;
      } else if (added.length) {
        await _emitThought('shelf',
          thread.length
            ? `the ${thread.join(', ')} shelf grew — ${cluster.length} memories now`
            : `a shelf grew — ${cluster.length} similar memories now`,
          { lens: 'connect', considered: added, released: [], shelf: target });
        receipt.thoughts++;
      }
    }

    // A shelf whose cluster dissolved is archived — reversible, never deleted,
    // and its content still names everything it once held.
    for (const s of shelves) {
      if (!shelfTaken.has(s.filename)) {
        await setMemoryArchive(s.filename, true);
        receipt.shelvesArchived++;
      }
    }

    await _setMeta('keeper_last_tick', JSON.stringify(receipt));
    return receipt;
  }

  async function status() {
    const [queue, edges, shelves, lastTick] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM memories WHERE embedding IS NOT NULL AND neighbours_at IS NULL AND ${SOURCE_WHERE}`),
      query('SELECT count(*)::int AS n FROM memory_edges'),
      query(`SELECT count(*)::int AS n FROM memories WHERE synthesized_via = $1 AND deleted_at IS NULL AND archived = false`, [SHELVING_VIA]),
      _meta('keeper_last_tick'),
    ]);
    let last = null;
    try { last = lastTick ? JSON.parse(lastTick) : null; } catch { last = null; }
    return { queue: queue.rows[0].n, edges: edges.rows[0].n, shelves: shelves.rows[0].n, lastTick: last };
  }

  return { tick, status };
}

module.exports = {
  createKeeper,
  // pure helpers, exported for the test suite
  commonThread,
  meanVector,
  renderShelf,
  parseMembers,
  shelfSlug,
  components,
  matchClusters,
  SHELVING_VIA,
  FLOORS: { NEIGHBOUR_K, EDGE_KEEP_FLOOR, SHELF_EDGE_FLOOR, MIN_SHELF, FIRST_LIGHT_MIN_CORPUS },
};
