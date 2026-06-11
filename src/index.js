/**
 * @mediagato/elifant — local-first PGlite-backed memory engine.
 *
 * Six tables:
 *   state          — key/value with updated_by, updated_at, layer
 *   memories       — filename-keyed long-form notes
 *   captures       — event stream; any substrate-conformant source writes here
 *   steering       — routing/template entries with mode + match_pattern
 *   review_lessons — auto-generated rules from prior tasks
 *   brain_meta     — internal kv (e.g. brain_name, spore_seeded_at)
 *
 * 'layer' distinguishes user-created rows ('instance') from
 * template-seeded rows ('pattern'). The kernel itself initiates no
 * outbound network calls; any export/import happens via caller code.
 *
 * The captures table is the projection sink: every substrate surface
 * (browser extension on AI sites, companion daemon, dispatch relay,
 * future sources) POSTs structured events here and consumers read
 * them back to render dashboards.
 */
const path = require('path');
const fs = require('fs');

// v0.10.0 — the polyglot-skills layer (read + carry verbs over a host-map
// registry). Self-contained filesystem module; exported as the `skills`
// namespace below so it never collides with the storage core's flat surface.
const skills = require('./skills');

// Gate debug stderr behind an opt-in env var so consumers don't see "[brain] ..."
// lines unless they ask for them. Was unconditional through v0.2.x; gated in
// v0.3.0-dev.1, made strict + runtime-evaluated in v0.3.0-dev.2 after a
// reviewer flagged that the module-load eval meant setting the env var
// AFTER require() wouldn't take effect, and that any truthy string ('0',
// 'false') would enable debug. Now: enabled only when MEDIAGATO_ELIFANT_DEBUG
// is exactly '1' or 'true'. Re-checked on every call.
function _debug(...args) {
  const v = process.env.MEDIAGATO_ELIFANT_DEBUG;
  if (v === '1' || v === 'true') console.error(...args);
}

let _db = null;
let _dbPath = null;
let _ready = false;

/**
 * Initialize the brain.
 * @param {string} dataDir - directory under which a 'brain/' subdir will be created
 * @returns {Promise<PGlite>} the underlying PGlite instance (advanced use only)
 */
async function init(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const { vector } = require('@electric-sql/pglite/vector');

  _dbPath = path.join(dataDir, 'brain');
  // crash-safety: finish or revert an interrupted replace-rollback directory swap
  // BEFORE we open the brain dir — otherwise a missing brain/ (mid-swap crash) gets
  // bootstrapped fresh+empty, stranding the keyholder's data in brain.old. See #2.
  _recoverInterruptedSwap(dataDir);
  fs.mkdirSync(_dbPath, { recursive: true });

  _db = new PGlite(_dbPath, { extensions: { vector } });

  await _applySchema(_db);

  _ready = true;
  // _debug writes to stderr (never stdout) so MCP servers using stdio transport
  // don't get "[brain] ..." lines in their JSON-RPC channel. With
  // MEDIAGATO_ELIFANT_DEBUG unset (default), _debug is a no-op for all consumers.
  _debug(`[brain] PGlite initialized at ${_dbPath}`);
  return _db;
}

// Apply the full schema + every idempotent migration to a PGlite instance. init()
// runs it on the live brain; rollback (replace/fork/forward-merge) runs it on the
// reopened or snapshot-loaded instance so a snapshot predating a column is
// backfilled before any read ("column does not exist" can't happen). Every
// statement is CREATE/ALTER ... IF NOT EXISTS, so it is safe on any instance.
async function _applySchema(db) {
  // pgvector must be enabled before any vector(N) columns are declared.
  await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      layer TEXT DEFAULT 'instance',
      anonymizable BOOLEAN DEFAULT true,
      trust_tier TEXT DEFAULT 'tier-1-keyholder-direct'
    );

    CREATE TABLE IF NOT EXISTS memories (
      filename TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      layer TEXT DEFAULT 'instance',
      anonymizable BOOLEAN DEFAULT true,
      embedding vector(384),
      pinned BOOLEAN DEFAULT false,
      archived BOOLEAN DEFAULT false,
      trust_tier TEXT DEFAULT 'tier-1-keyholder-direct'
    );

    CREATE TABLE IF NOT EXISTS steering (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'always',
      match_pattern TEXT,
      priority INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT true,
      layer TEXT DEFAULT 'instance',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      trust_tier TEXT DEFAULT 'tier-1-keyholder-direct'
    );

    CREATE TABLE IF NOT EXISTS review_lessons (
      id SERIAL PRIMARY KEY,
      task_type TEXT NOT NULL,
      rule TEXT NOT NULL,
      source_item_id INTEGER,
      layer TEXT DEFAULT 'instance',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brain_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS captures (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      type TEXT,
      ts TEXT NOT NULL,
      data JSONB,
      layer TEXT DEFAULT 'instance',
      anonymizable BOOLEAN DEFAULT true
    );

    CREATE INDEX IF NOT EXISTS captures_ts_idx ON captures (ts DESC);
    CREATE INDEX IF NOT EXISTS captures_source_ts_idx ON captures (source, ts DESC);

    -- crypto-01: pinned keyholder signing keys (TOFU trust anchor). Records the
    -- Ed25519 public key first seen for each foreign substrate_identity, so a
    -- later soul claiming the same identity with a DIFFERENT key is caught as
    -- impersonation. Receiver-private: never exported (not in ALL_TABLES).
    CREATE TABLE IF NOT EXISTS keyholders (
      substrate_identity TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      display_name TEXT,
      trusted BOOLEAN NOT NULL DEFAULT false,
      first_seen TEXT NOT NULL,
      last_seen TEXT,
      last_exported_at TEXT,
      last_signature TEXT
    );
  `);

  // crypto-01 anti-replay (A.1): newest exported_at accepted from each keyholder.
  // A captured OLDER export replayed to resurrect rows you deleted is rejected; the
  // stamp is a SIGNED manifest field so it can't be forged newer. Migration for
  // brains created at 0.11.0 (keyholders pre-dates this column). Idempotent.
  await db.exec(`ALTER TABLE keyholders ADD COLUMN IF NOT EXISTS last_exported_at TEXT;`);
  // 0.14.0 anti-replay edge-hardening: signature of the last-accepted soul, so an
  // EXACT re-import of the newest soul (same exported_at, same bytes) is caught as a
  // replay rather than silently resurrecting rows the keyholder deleted since. A
  // genuinely different same-second sibling has a different signature and still imports.
  await db.exec(`ALTER TABLE keyholders ADD COLUMN IF NOT EXISTS last_signature TEXT;`);

  // Migration: add embedding column if upgrading from a 0.3.x database that
  // pre-dates pgvector. Idempotent.
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(384);`);

  // Migration: add curation flags (pinned, archived) for databases that
  // pre-date v0.6.0. Idempotent.
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;`);
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false;`);

  // Migration (0.15.0 — H1 trust_tier slice 1): add trust_tier to the three
  // recall-surfaced/importable tables. The constant DEFAULT backfills every
  // existing row to tier-1 (keyholder-direct) — they're your own local content.
  // Idempotent. SUMMON demotes a foreign soul's rows on import (decision-b); pin
  // promotes to tier-1 (decision-a). The inject path honoring tiers is slice 2.
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS trust_tier TEXT DEFAULT 'tier-1-keyholder-direct';`);
  await db.exec(`ALTER TABLE state ADD COLUMN IF NOT EXISTS trust_tier TEXT DEFAULT 'tier-1-keyholder-direct';`);
  await db.exec(`ALTER TABLE steering ADD COLUMN IF NOT EXISTS trust_tier TEXT DEFAULT 'tier-1-keyholder-direct';`);

  // Migration (0.16.0 — H2 snapshot/rollback): restored_from provenance. A
  // forward-merge that resurrects a row absent in live stamps it with the
  // snapshot_id, so the keyholder can see — and re-z86 — exactly what a rollback
  // brought back (resurrect-and-FLAG, not silently). Idempotent.
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS restored_from TEXT;`);
  await db.exec(`ALTER TABLE state ADD COLUMN IF NOT EXISTS restored_from TEXT;`);
  await db.exec(`ALTER TABLE steering ADD COLUMN IF NOT EXISTS restored_from TEXT;`);
  await db.exec(`ALTER TABLE review_lessons ADD COLUMN IF NOT EXISTS restored_from TEXT;`);

  // v0.7.0 — record the Nose (embedder) identity so a brain knows which model
  // produced its Scents. Seeds the historical MiniLM/384 Nose ONLY if absent,
  // so existing brains stay byte-identical. A future Nose swap bumps these via
  // setEmbedMeta() and re-embeds every memory against the new model.
  await db.exec(`
    INSERT INTO brain_meta (key, value) VALUES
      ('embed_model', 'Xenova/all-MiniLM-L6-v2'),
      ('embed_dim', '384'),
      ('embed_version', '1')
    ON CONFLICT (key) DO NOTHING;
  `);
}

function _ts() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Tolerate a producer's clock skew, but reject an export stamped beyond this far
// in the future — a hostile first-contact soul could otherwise seed a keyholder's
// anti-replay high-water at year 9999 and lock out their genuine later exports.
const REPLAY_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000;

// Parse an export stamp (manifest.exported_at) to epoch ms for ordering + validity.
// Returns a finite number for a well-formed timestamp, NaN otherwise. Comparing
// NUMERICALLY (not lexically) is format-robust: a ms-precision or offset stamp from
// another open-protocol peer still orders correctly, and garbage / non-strings are
// caught as NaN instead of silently mis-sorting or failing a check OPEN.
function _parseStamp(s) {
  if (typeof s !== 'string' || !s) return NaN;
  return Date.parse(s);
}

// ── trust_tier (H1 / decision-a + decision-b) ──────────────────────────────
// Every memory/state/steering row carries a trust tier. tier-1 = keyholder-direct
// (your own writes, or a pin — the one sanctioned promotion, decision-a). tier-2 =
// synthesized. tier-3 = observed-external (a foreign keyholder's claim, from YOUR
// bowl's view). tier-4 = raw exhaust. Native writes default to tier-1 via the
// column DEFAULT; SUMMON DEMOTES a foreign soul's rows (decision-b) so their
// keyholder-direct is, to you, observed-external. The READ/inject path honoring
// these tiers (tier-3 wrapped, tier-4 held) is slice 2 — this slice only tags +
// carries them, so nothing about what surfaces to an LLM changes yet.
const TRUST_TIER = {
  KEYHOLDER_DIRECT: 'tier-1-keyholder-direct',
  SYNTHESIZED: 'tier-2-synthesized',
  OBSERVED_EXTERNAL: 'tier-3-observed-external',
  RAW_EXHAUST: 'tier-4-raw-exhaust',
};
const TIER_RANK = { 'tier-1-keyholder-direct': 1, 'tier-2-synthesized': 2, 'tier-3-observed-external': 3, 'tier-4-raw-exhaust': 4 };

// Resolve the tier to WRITE for an imported row given the import's tier policy.
// 'preserve' keeps the incoming tier (the "I trust this keyholder" override, and
// the default for a self round-trip). 'demote' (default for any foreign/unsigned
// soul) floors the row at tier-3 — a foreign claim is never more trusted than
// observed-external — while leaving already-lower raw exhaust at tier-4. A missing
// incoming tier is treated as most-trusted (rank 1) so demote still floors it.
function _resolveImportTier(rowTier, policy) {
  if (policy === 'preserve') return rowTier || TRUST_TIER.KEYHOLDER_DIRECT;
  const rank = TIER_RANK[rowTier] || 1;
  return rank < 3 ? TRUST_TIER.OBSERVED_EXTERNAL : (rowTier || TRUST_TIER.OBSERVED_EXTERNAL);
}

function _ensure() {
  if (!_ready) throw new Error('Brain not initialized. Call init() first.');
}

/** Get the database directory path. */
function dbPath() { return _dbPath; }

/** Get this brain's name. Default: Bob. */
async function getName() {
  _ensure();
  const result = await _db.query("SELECT value FROM brain_meta WHERE key = 'brain_name'");
  return result.rows[0] ? result.rows[0].value : 'Bob';
}

/** Name this brain. */
async function setName(name) {
  _ensure();
  await _db.query(`
    INSERT INTO brain_meta (key, value) VALUES ('brain_name', $1)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
  `, [name]);
}

// ── The Nose (embedder identity) ──────────────────────────────────────────
// A brain's Scents (embeddings) are only comparable to a query embedded by the
// SAME Nose. Recording the model/dim/version lets a model-swap migration know a
// re-embed is required, and lets federated elifants check Nose-compatibility
// before comparing Scents. Defaults match the historical MiniLM/384 Nose.

/** Get the Nose (embedder) identity recorded in this brain. */
async function getEmbedMeta() {
  _ensure();
  const r = await _db.query(
    "SELECT key, value FROM brain_meta WHERE key IN ('embed_model','embed_dim','embed_version')"
  );
  const m = {};
  for (const row of r.rows) m[row.key] = row.value;
  return {
    model: m.embed_model || 'Xenova/all-MiniLM-L6-v2',
    dim: m.embed_dim ? Number(m.embed_dim) : 384,
    version: m.embed_version || '1',
  };
}

/** Record the Nose (embedder) identity. Used by a model-swap migration. */
async function setEmbedMeta({ model = null, dim = null, version = null } = {}) {
  _ensure();
  const pairs = [];
  if (model != null) pairs.push(['embed_model', String(model)]);
  if (dim != null) pairs.push(['embed_dim', String(dim)]);
  if (version != null) pairs.push(['embed_version', String(version)]);
  for (const [key, value] of pairs) {
    await _db.query(
      'INSERT INTO brain_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
  }
}

/**
 * Re-dimension the Scent column for a Nose swap (v0.9.0). pgvector cannot ALTER
 * a populated vector(N) column in place, so this DROPs + re-ADDs `embedding` at
 * the new dimension — nulling every Scent — then records the new Nose identity.
 * Memory CONTENT is untouched; only the vectors are cleared, so the backfill
 * queue (getMemoriesNeedingEmbedding) re-embeds every row against the new Nose.
 *
 * DESTRUCTIVE: the caller MUST back up the brain dir BEFORE calling this and
 * re-embed AFTER. No-op-safe to call when already at newDim (drops + re-adds an
 * empty/!current column either way). Returns the number of memories now needing
 * a fresh Scent.
 *
 * @param {number} newDim
 * @param {{model?: string, version?: string}} [nose] - new Nose identity to record
 * @returns {Promise<number>} count of memories awaiting re-embed
 */
async function migrateEmbedDim(newDim, { model = null, version = null } = {}) {
  _ensure();
  if (!Number.isInteger(newDim) || newDim < 1) {
    throw new Error('migrateEmbedDim: newDim must be a positive integer');
  }
  await _db.exec('ALTER TABLE memories DROP COLUMN IF EXISTS embedding;');
  await _db.exec(`ALTER TABLE memories ADD COLUMN embedding vector(${newDim});`);
  await setEmbedMeta({ model, dim: newDim, version });
  const r = await _db.query('SELECT COUNT(*)::int AS n FROM memories');
  return r.rows[0] ? r.rows[0].n : 0;
}

// ── State operations ──────────────────────────────────────────────────────

async function getState(key) {
  _ensure();
  const result = await _db.query(
    'SELECT value, layer, updated_at FROM state WHERE key = $1', [key]
  );
  return result.rows[0] || null;
}

async function setState(key, value, updatedBy = 'brain') {
  _ensure();
  await _db.query(`
    INSERT INTO state (key, value, updated_by, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at
  `, [key, value, updatedBy, _ts()]);
}

async function getAllState() {
  _ensure();
  const result = await _db.query('SELECT key, value, layer, updated_at FROM state ORDER BY key');
  return result.rows;
}

async function deleteState(key) {
  _ensure();
  await _db.query('DELETE FROM state WHERE key = $1', [key]);
}

// ── Memory operations ─────────────────────────────────────────────────────

async function getMemory(filename) {
  _ensure();
  const result = await _db.query(
    'SELECT content, layer, updated_at, trust_tier, restored_from FROM memories WHERE filename = $1', [filename]
  );
  return result.rows[0] || null;
}

// Format a JS number[] as the canonical pgvector literal string '[1,2,3]'.
// Rejects non-finite values so we don't poison the index with NaN/Infinity.
function _vectorLiteral(arr) {
  if (!Array.isArray(arr)) throw new Error('embedding must be a number array');
  for (const x of arr) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new Error('embedding contains non-finite values');
    }
  }
  return `[${arr.join(',')}]`;
}

async function setMemory(filename, content, updatedBy = 'brain', layer = 'instance', embedding = null) {
  _ensure();
  if (embedding == null) {
    await _db.query(`
      INSERT INTO memories (filename, content, updated_by, updated_at, layer)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(filename) DO UPDATE SET
        content = EXCLUDED.content,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at,
        layer = EXCLUDED.layer
    `, [filename, content, updatedBy, _ts(), layer]);
    return;
  }
  const vec = _vectorLiteral(embedding);
  await _db.query(`
    INSERT INTO memories (filename, content, updated_by, updated_at, layer, embedding)
    VALUES ($1, $2, $3, $4, $5, $6::vector)
    ON CONFLICT(filename) DO UPDATE SET
      content = EXCLUDED.content,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at,
      layer = EXCLUDED.layer,
      embedding = EXCLUDED.embedding
  `, [filename, content, updatedBy, _ts(), layer, vec]);
}

// Update only the embedding for an existing memory. Used by callers that
// embed asynchronously (after save) or by backfill workers running over
// memories that pre-date the embedding column. Silently no-ops if the
// memory doesn't exist.
async function setMemoryEmbedding(filename, embedding) {
  _ensure();
  const vec = _vectorLiteral(embedding);
  await _db.query(
    'UPDATE memories SET embedding = $1::vector WHERE filename = $2',
    [vec, filename]
  );
}

// Return up to `limit` memories that don't have an embedding yet, oldest
// first (so backfill makes steady progress over the long tail). Returns
// {filename, content} pairs the caller can embed and feed back via
// setMemoryEmbedding.
async function getMemoriesNeedingEmbedding(limit = 50) {
  _ensure();
  const result = await _db.query(
    'SELECT filename, content FROM memories WHERE embedding IS NULL ORDER BY updated_at ASC LIMIT $1',
    [limit]
  );
  return result.rows;
}

// List memories with optional filters and richer columns. Pinned memories
// float to the top; archived memories are excluded by default. Pass
// {includeArchived:true} to see everything, or {onlyArchived:true} for the
// archive view. updated_by is surfaced so consumers can render provenance
// ("why is this here?") without a follow-up fetch.
async function getAllMemories({ includeArchived = false, onlyArchived = false } = {}) {
  _ensure();
  const where = [];
  if (onlyArchived) {
    where.push('archived = true');
  } else if (!includeArchived) {
    where.push('archived = false');
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await _db.query(`
    SELECT filename, layer, updated_at, updated_by, pinned, archived, trust_tier, restored_from
    FROM memories
    ${whereSql}
    ORDER BY pinned DESC, filename
  `);
  return result.rows;
}

// Toggle the pinned flag on a memory. Pinned memories float to the top of
// listings and (caller's choice) can be boosted in semantic recall. No-op if
// the memory doesn't exist.
async function setMemoryPin(filename, pinned) {
  _ensure();
  if (pinned) {
    // decision-a: a pin is the keyholder vouching directly, so it promotes the
    // memory to tier-1 (keyholder-direct). This is the ONE sanctioned re-tag path —
    // keyholder-initiated, not channel-inferred — the explicit exception to
    // never-re-tag. Unpinning does NOT demote (the vouch stands).
    await _db.query(
      'UPDATE memories SET pinned = true, trust_tier = $1 WHERE filename = $2',
      [TRUST_TIER.KEYHOLDER_DIRECT, filename]
    );
  } else {
    await _db.query('UPDATE memories SET pinned = false WHERE filename = $1', [filename]);
  }
}

// Toggle the archived flag on a memory. Archived memories are hidden from
// the default listing and excluded from semantic search at the caller's
// discretion. The memory itself is preserved. No-op if the memory doesn't
// exist.
async function setMemoryArchive(filename, archived) {
  _ensure();
  await _db.query(
    'UPDATE memories SET archived = $1 WHERE filename = $2',
    [Boolean(archived), filename]
  );
}

// ── Hybrid reranking helpers (additive; only engaged when queryText is given) ──
// The Nose produces a Scent (embedding); cosine over Scents is the base signal.
// When a consumer also passes the raw query TEXT, searchMemories fuses three
// rank lists — semantic (cosine), lexical (BM25 over content), and pin-aware
// recency — via Reciprocal Rank Fusion. This RE-ORDERS rows but NEVER mutates
// the raw cosine `distance` field (downstream relevance floors depend on its
// absolute value, so it must never be repurposed); the fused value rides a
// separate `rerank_score`.
const _RERANK_STOP = new Set((
  'a an the i my me do does what is are was were be been of to in on at for it its that this these those ' +
  'you your yours we our us they them he she his her remember please tell show find search about know want ' +
  'like likes love loves enjoy enjoys favorite favourite say said how where who when which whats'
).split(/\s+/));
function _rerankToks(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !_RERANK_STOP.has(w));
}
function _bm25(queryText, docs) {
  const k1 = 1.5, b = 0.75, N = docs.length || 1;
  const df = Object.create(null), dl = Object.create(null), dt = Object.create(null);
  let avg = 0;
  for (const d of docs) {
    const t = _rerankToks(d.text); dt[d.id] = t; dl[d.id] = t.length; avg += t.length;
    for (const w of new Set(t)) df[w] = (df[w] || 0) + 1;
  }
  avg = (avg / N) || 1;
  const qt = _rerankToks(queryText);
  const out = Object.create(null);
  for (const d of docs) {
    const tf = Object.create(null);
    for (const w of dt[d.id]) tf[w] = (tf[w] || 0) + 1;
    let s = 0;
    for (const w of qt) {
      if (!tf[w]) continue;
      const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
      s += idf * (tf[w] * (k1 + 1)) / (tf[w] + k1 * (1 - b + b * (dl[d.id] / avg)));
    }
    out[d.id] = s;
  }
  return out;
}
function _ageDays(updatedAt) {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 3650;
  return Math.max(0, (Date.now() - t) / 86400000);
}
// Competition ranking BY VALUE: equal values share a rank (the index of the
// group's first member). This matters because two memories with identical
// cosine distance must contribute identically to the fusion — otherwise the
// arbitrary DB tie-order leaks in and the pin-aware recency leg can't decide
// ties. dir 'asc' = smaller-is-better (cosine), 'desc' = larger-is-better.
function _denseRankMap(ids, valueOf, dir) {
  const sorted = [...ids].sort((a, b) => (dir === 'asc' ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a)));
  const rank = Object.create(null);
  let cur = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && valueOf(sorted[i]) !== valueOf(sorted[i - 1])) cur = i;
    rank[sorted[i]] = cur;
  }
  return rank;
}

// Reciprocal Rank Fusion of cosine + lexical + (pin-aware) recency. Higher =
// better. recencyWeight keeps recency a light tie-breaker. Pinned rows are
// treated as freshest, so the recency leg can only HELP a pinned memory — it
// never demotes one below an unpinned row of equal relevance.
function _fuseRerank(rows, queryText, recencyWeight) {
  const K0 = 60;
  const ids = rows.map((r) => r.filename);
  const distOf = Object.create(null), recOf = Object.create(null);
  for (const r of rows) {
    distOf[r.filename] = r.distance;
    recOf[r.filename] = r.pinned ? Number.POSITIVE_INFINITY : -_ageDays(r.updated_at);
  }
  const bm = _bm25(queryText, rows.map((r) => ({ id: r.filename, text: r.content })));
  const cosRank = _denseRankMap(ids, (id) => distOf[id], 'asc');
  const lexRank = _denseRankMap(ids, (id) => (bm[id] || 0), 'desc');
  const recRank = _denseRankMap(ids, (id) => recOf[id], 'desc');
  const score = Object.create(null);
  for (const id of ids) {
    score[id] = 1 / (K0 + cosRank[id]) + 1 / (K0 + lexRank[id]) + recencyWeight * (1 / (K0 + recRank[id]));
  }
  return score;
}

// Semantic search over memories.
//
// Base mode (queryEmbedding only): top-K rows ordered by cosine distance to the
// query embedding (smaller = more similar) — byte-identical to pre-0.7.0.
// Memories without an embedding are excluded; archived excluded unless
// {includeArchived:true}. Filters: layer + filename prefix.
//
// Hybrid mode (also pass queryText): fetches a wider candidate pool, then
// re-ranks by Reciprocal Rank Fusion of semantic + lexical (BM25) + pin-aware
// recency before the top-K cut. The raw cosine `distance` is PRESERVED on every
// row (downstream relevance floors read its absolute value); the fused order is
// exposed as `rerank_score`. Pass {rerank:false} to force base mode.
//
// Returns base mode:  [{ filename, content, layer, updated_at, distance }]
//         hybrid mode: [{ ..., distance (raw cosine, unchanged), rerank_score, pinned }]
//   - distance is the raw pgvector cosine distance (0 = identical, 2 = opposite).
//     Score-as-similarity = 1 - distance/2.
async function searchMemories({ queryEmbedding, queryText = null, k = 5, layer = null, prefix = null, includeArchived = false, rerank = true, recencyWeight = 0.5 } = {}) {
  _ensure();
  if (!queryEmbedding) throw new Error('searchMemories: queryEmbedding is required');
  const vec = _vectorLiteral(queryEmbedding);

  const doRerank = rerank && typeof queryText === 'string' && queryText.trim().length > 0;

  const where = ['embedding IS NOT NULL'];
  const params = [vec];
  let nextParam = 2;
  if (!includeArchived) { where.push('archived = false'); }
  if (layer) { where.push(`layer = $${nextParam++}`); params.push(layer); }
  if (prefix) { where.push(`filename LIKE $${nextParam++}`); params.push(`${prefix}%`); }

  // Hybrid pulls a wider candidate pool so the reranker has rows to move; base
  // mode pulls exactly k (unchanged behavior + query plan).
  const limit = doRerank ? Math.max(k * 5, 30) : k;
  params.push(limit);

  const cols = doRerank
    ? 'filename, content, layer, updated_at, pinned, trust_tier, (embedding <=> $1::vector) AS distance'
    : 'filename, content, layer, updated_at, trust_tier, (embedding <=> $1::vector) AS distance';
  const sql = `
    SELECT ${cols}
    FROM memories
    WHERE ${where.join(' AND ')}
    ORDER BY embedding <=> $1::vector
    LIMIT $${nextParam}
  `;
  let result;
  try {
    result = await _db.query(sql, params);
  } catch (e) {
    // Dimension-mismatch guard (v0.8.0): a query embedded by a different-
    // dimensioned Nose than the stored Scents (e.g. an old 384-dim app querying
    // a brain mid model-swap migration to 768) makes pgvector throw. Degrade to
    // "no recall" instead of crashing the caller with a 500 — a half-migrated
    // brain stays usable until the re-embed finishes.
    if (/dimension/i.test(String((e && e.message) || ''))) return [];
    throw e;
  }
  const rows = result.rows.map((r) => ({
    filename: r.filename,
    content: r.content,
    layer: r.layer,
    updated_at: r.updated_at,
    pinned: r.pinned,
    trust_tier: r.trust_tier,
    distance: Number(r.distance),
  }));

  if (!doRerank) {
    // Base mode: pre-0.7.0 shape + the additive trust_tier (slice 2's inject path
    // reads it; existing callers ignore it). Order/distance unchanged.
    return rows.map((r) => ({
      filename: r.filename,
      content: r.content,
      layer: r.layer,
      updated_at: r.updated_at,
      trust_tier: r.trust_tier,
      distance: r.distance,
    }));
  }

  // Hybrid mode: fuse + re-order, PRESERVING the raw cosine distance per row.
  const score = _fuseRerank(rows, queryText, recencyWeight);
  return rows
    .map((r) => ({ ...r, rerank_score: score[r.filename] }))
    .sort((a, b) => (b.rerank_score - a.rerank_score) || ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)))
    .slice(0, k)
    .map((r) => ({
      filename: r.filename,
      content: r.content,
      layer: r.layer,
      updated_at: r.updated_at,
      distance: r.distance,        // raw cosine — UNCHANGED (relevance floors depend on it)
      rerank_score: r.rerank_score,
      pinned: r.pinned,
      trust_tier: r.trust_tier,
    }));
}

async function deleteMemory(filename) {
  _ensure();
  await _db.query('DELETE FROM memories WHERE filename = $1', [filename]);
}

// ── Captures (event stream) ───────────────────────────────────────────────
//
// The captures table is the projection sink. Substrate-conformant surfaces
// (browser extension, companion daemon, dispatch relay, future producers)
// write structured events here. Consumers read them back to render
// dashboards / timelines / activity feeds.
//
// Source-specific fields go on `data` (JSONB); top-level columns are the
// protocol contract. The payload shape is designed so any process that can
// POST JSON (browser extension, daemon, CLI, foreign program) can append
// events without depending on this library directly.

/**
 * Write a capture event.
 * @param {Object} cap
 * @param {string} cap.source - producer identifier ('extension', 'daemon', 'cli', ...)
 * @param {string} [cap.type] - source-specific event type ('conversation_visit', 'job_started', ...)
 * @param {Object} [cap.data] - structured payload, JSON-serializable
 * @param {string} [cap.ts] - ISO 8601 timestamp; defaults to now
 * @returns {Promise<{id: string, ts: string}>}
 */
async function addCapture({ source, type = null, data = null, ts = null } = {}) {
  _ensure();
  if (!source || typeof source !== 'string') {
    throw new Error('addCapture: source (string) required');
  }
  const timestamp = ts || _ts();
  const payload = data == null ? null : JSON.stringify(data);
  const result = await _db.query(
    `INSERT INTO captures (source, type, ts, data) VALUES ($1, $2, $3, $4) RETURNING id, ts`,
    [source, type, timestamp, payload]
  );
  return { id: String(result.rows[0].id), ts: result.rows[0].ts };
}

/**
 * Read captures, newest first.
 * @param {Object} [opts]
 * @param {string} [opts.since] - inclusive lower bound on ts (ISO 8601)
 * @param {string} [opts.until] - inclusive upper bound on ts
 * @param {string} [opts.source] - filter by producer
 * @param {string} [opts.type] - filter by event type
 * @param {number} [opts.limit=1000] - max rows
 * @returns {Promise<Array<{id: string, source: string, type: string|null, ts: string, data: Object|null}>>}
 */
async function getCaptures(opts = {}) {
  _ensure();
  const { since, until, source, type } = opts;
  const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 1000, 10000));
  const where = [];
  const params = [];
  let i = 1;
  if (since)  { where.push(`ts >= $${i++}`); params.push(since); }
  if (until)  { where.push(`ts <= $${i++}`); params.push(until); }
  if (source) { where.push(`source = $${i++}`); params.push(source); }
  if (type)   { where.push(`type = $${i++}`); params.push(type); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // sqli-01: bind the LIMIT as a parameter rather than interpolate it. `limit` is
  // already coerced to an integer in [1, 10000] above, so this is defense-in-depth
  // (no live injection), but it keeps the query string free of any caller-derived
  // value — the standing pattern, and one less thing to re-verify on every edit.
  params.push(limit);
  const result = await _db.query(
    `SELECT id, source, type, ts, data FROM captures ${whereClause} ORDER BY ts DESC LIMIT $${params.length}`,
    params
  );
  return result.rows.map(r => ({
    id: String(r.id),
    source: r.source,
    type: r.type,
    ts: r.ts,
    data: r.data, // PGlite returns JSONB as a parsed object
  }));
}

/**
 * Delete captures matching the filter. Use with care — events are append-only
 * by convention; this exists for retention/pruning of older event noise.
 * @returns {Promise<number>} rows deleted
 */
async function deleteCaptures({ until, source, type } = {}) {
  _ensure();
  const where = [];
  const params = [];
  let i = 1;
  if (until)  { where.push(`ts <= $${i++}`); params.push(until); }
  if (source) { where.push(`source = $${i++}`); params.push(source); }
  if (type)   { where.push(`type = $${i++}`); params.push(type); }
  if (!where.length) {
    throw new Error('deleteCaptures: at least one filter (until/source/type) required to avoid wiping all captures');
  }
  const result = await _db.query(
    `DELETE FROM captures WHERE ${where.join(' AND ')}`,
    params
  );
  // Prune watermark (H2 forward-merge): when captures are pruned by TIME, advance a
  // high-water so a later forward-merge does NOT resurrect the event-noise the
  // keyholder deliberately pruned (for captures, "absent in live" usually means
  // "pruned on purpose", not "lost"). A source/type-only prune (no `until`) can't be
  // time-watermarked, so those captures may resurrect on merge — a documented edge,
  // not a silent-loss path. ISO-8601 stamps compare correctly as TEXT via GREATEST.
  if (until && (result.affectedRows || 0) > 0) {
    await _db.query(`
      INSERT INTO brain_meta (key, value) VALUES ('captures_prune_watermark', $1)
      ON CONFLICT(key) DO UPDATE SET value = GREATEST(brain_meta.value, EXCLUDED.value)
    `, [until]);
  }
  return result.affectedRows || 0;
}

// ── Spore seed ────────────────────────────────────────────────────────────

/**
 * Seed the brain from a Spore payload.
 * Idempotent — ON CONFLICT DO NOTHING on every insert. Pattern-layer data only.
 * @param {Object} sporeData - { state: [{key, value}], memories: [{filename, content}], steering: [...] }
 */
async function seedFromSpore(sporeData) {
  _ensure();
  const ts = _ts();
  let count = 0;

  if (sporeData.state) {
    for (const s of sporeData.state) {
      await _db.query(`
        INSERT INTO state (key, value, updated_by, updated_at, layer, anonymizable)
        VALUES ($1, $2, 'spore', $3, 'pattern', true)
        ON CONFLICT(key) DO NOTHING
      `, [s.key, s.value, ts]);
      count++;
    }
  }

  if (sporeData.memories) {
    for (const m of sporeData.memories) {
      await _db.query(`
        INSERT INTO memories (filename, content, updated_by, updated_at, layer, anonymizable)
        VALUES ($1, $2, 'spore', $3, 'pattern', true)
        ON CONFLICT(filename) DO NOTHING
      `, [m.filename, m.content, ts]);
      count++;
    }
  }

  if (sporeData.steering) {
    for (const s of sporeData.steering) {
      await _db.query(`
        INSERT INTO steering (id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, true, 'pattern', $7, $7)
        ON CONFLICT(id) DO NOTHING
      `, [s.id, s.name, s.content, s.mode || 'always', s.match_pattern || null, s.priority || 0, ts]);
      count++;
    }
  }

  await _db.query(`
    INSERT INTO brain_meta (key, value) VALUES ('spore_seeded_at', $1)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
  `, [ts]);

  _debug(`[brain] seeded ${count} items from Spore`);
  return count;
}

/** Check if this brain has been seeded from a Spore. Returns the timestamp or null. */
async function isSeeded() {
  _ensure();
  const result = await _db.query("SELECT value FROM brain_meta WHERE key = 'spore_seeded_at'");
  return result.rows[0] ? result.rows[0].value : null;
}

// ── YOINK / SUMMON (v0.2.0 — Elifantic protocol v0 portability) ───────────
//
// YOINK serializes the full bowl into a portable tarball per the protocol
// spec at elifantic/spec/elifantic-protocol-v0.md (section "YOINK/SUMMON
// wire format"). SUMMON is the inverse: accepts a tarball, merges into the
// current bowl with caller-chosen conflict policy.

const tar = require('./tar');
const crypto = require('crypto');

const PACKAGE_VERSION = require('../package.json').version;
const ALL_TABLES = ['state', 'memories', 'steering', 'review_lessons'];

// brain_meta keys that are safe to include in YOINK exports AND safe to
// apply on SUMMON import. Anything NOT in this set is treated as receiver-
// private and never leaves the bowl that owns it. Default-deny.
//
// substrate_identity is included in the manifest separately (at the top
// level, for audit visibility) but NOT applied on import — the receiver
// always keeps their own identity. signing_keypair_v1 is the bowl's
// Ed25519 private key and is NEVER exported or imported. Both omissions
// are deliberate; see bug_009 fix in v0.3.0-dev.3.
//
// Adding a new brain_meta key? Default is PRIVATE. Only add to this set
// after explicitly reviewing whether sender-to-receiver sharing is safe.
const BRAIN_META_EXPORTABLE = new Set([
  'brain_name',
  'spore_seeded_at',
]);

/** SHA-256 of a string or Buffer. Returns "sha256:" + lowercase hex digest. */
function _sha256(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

/** Get or lazily-generate a stable per-bowl substrate identity (UUID). */
async function _getSubstrateIdentity() {
  let r = await _db.query("SELECT value FROM brain_meta WHERE key = 'substrate_identity'");
  if (r.rows[0]) return r.rows[0].value;
  const id = crypto.randomUUID();
  await _db.query(
    "INSERT INTO brain_meta (key, value) VALUES ('substrate_identity', $1) ON CONFLICT(key) DO NOTHING",
    [id]
  );
  // Re-read in case of a race (some other writer beat us).
  r = await _db.query("SELECT value FROM brain_meta WHERE key = 'substrate_identity'");
  return r.rows[0].value;
}

/**
 * Get or lazily-generate the bowl's Ed25519 signing keypair. Used to sign
 * soul-manifest.json on YOINK (export) and verify on SUMMON (import) per
 * elifantic-soul-v0.2. Private key persists in brain_meta; public key is
 * embedded in every exported manifest for receivers to verify against.
 *
 * Returns { privateKey, publicKeyB64 } where privateKey is a node KeyObject
 * suitable for crypto.sign, and publicKeyB64 is the base64-encoded raw
 * public key bytes (suitable for embedding in soul-manifest.json).
 */
async function _getSigningKey() {
  let r = await _db.query("SELECT value FROM brain_meta WHERE key = 'signing_keypair_v1'");
  let stored = r.rows[0] && r.rows[0].value;
  if (!stored) {
    // First-run generation. Ed25519 keys are 32 bytes raw, but node's
    // crypto.generateKeyPairSync emits them as PEM/DER. We store as a JSON
    // blob with PEM-encoded private + raw-bytes-base64 public for portability.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' });
    // Strip the 12-byte SPKI prefix to get raw 32-byte key (Ed25519 public).
    const pubRawKey = pubRaw.subarray(pubRaw.length - 32);
    stored = JSON.stringify({
      algorithm: 'ed25519',
      private_pem: privPem.toString(),
      public_b64: pubRawKey.toString('base64'),
      created_at: new Date().toISOString(),
    });
    await _db.query(
      "INSERT INTO brain_meta (key, value) VALUES ('signing_keypair_v1', $1) ON CONFLICT(key) DO NOTHING",
      [stored]
    );
    r = await _db.query("SELECT value FROM brain_meta WHERE key = 'signing_keypair_v1'");
    stored = r.rows[0].value;
  }
  const parsed = JSON.parse(stored);
  const privateKey = crypto.createPrivateKey({ key: parsed.private_pem, format: 'pem' });
  return { privateKey, publicKeyB64: parsed.public_b64 };
}

// ── Keyholder key pinning (crypto-01 — TOFU trust anchor) ──────────────────
//
// A 'verified' signature only proves "signed by SOMEBODY" — the verify key is
// taken from the manifest itself, so an attacker can self-sign a poisoned soul
// and get 'verified'. To anchor trust, importBrain pins the Ed25519 public key
// first seen for each foreign substrate_identity (Trust-On-First-Use). A later
// soul claiming the same identity with a DIFFERENT key is impersonation (or an
// unconfirmed key rotation) and is rejected. See audit-2026-06-10 (crypto-01).

async function _lookupKeyholder(identity) {
  const r = await _db.query(
    'SELECT substrate_identity, public_key, display_name, trusted, first_seen, last_seen, last_exported_at, last_signature FROM keyholders WHERE substrate_identity = $1',
    [identity]
  );
  return r.rows[0] || null;
}

/** List known keyholders (pinned signing keys). Powers CONSENT/HEALTH surfaces. */
async function listKeyholders() {
  _ensure();
  const r = await _db.query(
    'SELECT substrate_identity, public_key, display_name, trusted, first_seen, last_seen, last_exported_at, last_signature FROM keyholders ORDER BY first_seen'
  );
  return r.rows;
}

/** Bless/unbless a known keyholder — the "I trust this keyholder" gesture. */
async function setKeyholderTrust(identity, trusted) {
  _ensure();
  await _db.query('UPDATE keyholders SET trusted = $1 WHERE substrate_identity = $2', [Boolean(trusted), identity]);
}

/** Un-pin a keyholder. A later import from them becomes first-contact again. */
async function forgetKeyholder(identity) {
  _ensure();
  await _db.query('DELETE FROM keyholders WHERE substrate_identity = $1', [identity]);
}

/**
 * Pin a keyholder's public key OUT-OF-BAND — the strongest trust establishment:
 * the keyholder vouches for a key received over a channel they trust (in person,
 * verified fingerprint, etc.) rather than trusting-on-first-use. After this, an
 * import claiming this identity with any other key is rejected as impersonation.
 */
async function pinKeyholder(identity, publicKey, { trusted = true, displayName = null } = {}) {
  _ensure();
  await _db.query(
    `INSERT INTO keyholders (substrate_identity, public_key, display_name, trusted, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT(substrate_identity) DO UPDATE SET
       public_key = EXCLUDED.public_key,
       display_name = EXCLUDED.display_name,
       trusted = EXCLUDED.trusted,
       last_seen = EXCLUDED.last_seen`,
    [identity, publicKey, displayName, Boolean(trusted), _ts()]
  );
}

/**
 * Canonical-form serialization of a manifest for signing. Drops the
 * `signature` field (since the signature signs the rest), sorts keys
 * recursively for determinism, and emits compact JSON without trailing
 * whitespace. Verifier reproduces this same canonicalization to verify.
 */
function _canonicalizeManifestForSigning(manifest) {
  const copy = { ...manifest };
  delete copy.signature;
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return Buffer.from(JSON.stringify(sortKeys(copy)), 'utf8');
}

function _jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

function _parseJsonl(buf) {
  const text = buf.toString('utf8');
  if (!text.trim()) return [];
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function _layerOk(row, layers) {
  if (!layers || layers.includes('any')) return true;
  return layers.includes(row.layer || 'instance');
}

/**
 * Export the entire bowl as a portable tarball.
 *
 * Wire format (per Elifantic protocol v0):
 *   soul-manifest.json     — required
 *   state.jsonl            — one row per line
 *   memories.jsonl         — one row per line
 *   steering.jsonl         — one row per line
 *   review_lessons.jsonl   — optional, one row per line
 *   brain_meta.json        — { brain_name, spore_seeded_at, substrate_identity, ... }
 *
 * @param {object} [options]
 * @param {'tar'} [options.format='tar']                       — v0 only supports tar
 * @param {object} [options.include]
 * @param {string[]} [options.include.tables]                  — subset of ALL_TABLES
 * @param {Array<'instance'|'pattern'|'any'>} [options.include.layers] — default ['any']
 * @param {object} [options.encrypt]                           — v0.3 (Thu); rejected today
 * @returns {Promise<{manifest: object, payload: Buffer, bytes: number}>}
 */
async function exportBrain(options = {}) {
  _ensure();
  const format = options.format || 'tar';
  if (format !== 'tar') {
    throw new Error(`exportBrain: format '${format}' not supported in v0.2.0 (use 'tar')`);
  }
  if (options.encrypt) {
    throw new Error('exportBrain: encrypted export not yet implemented in this version; tracked for a future v0.3+ release alongside the sync server');
  }

  const tables = (options.include && options.include.tables) || ALL_TABLES;
  const layers = (options.include && options.include.layers) || ['any'];

  // Pull rows from each requested table, filtered by layer.
  const rows = {};
  for (const t of tables) {
    let sql;
    switch (t) {
      case 'state':
        sql = 'SELECT key, value, updated_by, updated_at, layer, anonymizable, trust_tier FROM state ORDER BY key';
        break;
      case 'memories':
        sql = 'SELECT filename, content, updated_by, updated_at, layer, anonymizable, trust_tier FROM memories ORDER BY filename';
        break;
      case 'steering':
        sql = 'SELECT id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier FROM steering ORDER BY id';
        break;
      case 'review_lessons':
        sql = 'SELECT id, task_type, rule, source_item_id, layer, created_at FROM review_lessons ORDER BY id';
        break;
      default:
        throw new Error(`exportBrain: unknown table '${t}'`);
    }
    const r = await _db.query(sql);
    rows[t] = r.rows.filter((row) => _layerOk(row, layers));
  }

  // brain_meta — kv table. Only allowlisted keys (BRAIN_META_EXPORTABLE)
  // are included in the export. Private values like signing_keypair_v1
  // stay with the bowl that owns them. See bug_009 in audit doc.
  const metaRes = await _db.query('SELECT key, value FROM brain_meta');
  const brainMeta = {};
  for (const row of metaRes.rows) {
    if (BRAIN_META_EXPORTABLE.has(row.key)) {
      brainMeta[row.key] = row.value;
    }
  }

  const substrateId = await _getSubstrateIdentity();
  const displayName = await getName();

  // Build data-file contents BEFORE the manifest so we can hash them into
  // it. The signature covers the manifest including file_hashes, so any
  // tampering with .jsonl or brain_meta.json content after signing causes
  // signature verification to fail on the receiver. Closes bug_013, where
  // the v0.2 signature originally covered only manifest metadata, allowing
  // an attacker to swap payload rows of equal count while keeping the
  // signature green.
  const dataFiles = {};
  for (const t of tables) {
    dataFiles[`${t}.jsonl`] = _jsonl(rows[t]);
  }
  dataFiles['brain_meta.json'] = JSON.stringify(brainMeta, null, 2);

  const file_hashes = {};
  for (const [name, content] of Object.entries(dataFiles)) {
    file_hashes[name] = _sha256(content);
  }

  const manifest = {
    schema: 'elifantic-soul-v0.2',
    substrate_identity: substrateId,
    display_name: displayName,
    brain_version: PACKAGE_VERSION,
    exported_at: _ts(),
    table_counts: Object.fromEntries(
      Object.entries(rows).map(([t, r]) => [t, r.length])
    ),
    encryption: null,
    producer: {
      name: process.env.MEDIAGATO_ELIFANT_PRODUCER || 'mediagato-elifant',
      version: PACKAGE_VERSION,
      // Hostname is opt-in. By default it's redacted because the manifest may
      // travel to other keyholders' shared spaces, and many Windows / macOS
      // hostnames include the user's real name, employer, or device serial.
      // Set MEDIAGATO_ELIFANT_REVEAL_HOST exactly to '1' or 'true' to embed the
      // real os.hostname(). Or pass a chosen string in MEDIAGATO_ELIFANT_PRODUCER_HOST.
      // Strict comparison so '0' / 'false' / 'no' don't accidentally enable
      // disclosure via JS truthiness.
      host: (process.env.MEDIAGATO_ELIFANT_REVEAL_HOST === '1' || process.env.MEDIAGATO_ELIFANT_REVEAL_HOST === 'true')
        ? require('os').hostname()
        : (process.env.MEDIAGATO_ELIFANT_PRODUCER_HOST || 'redacted'),
    },
    filter: {
      tables,
      layers,
    },
    file_hashes,
  };

  // Sign the manifest with the bowl's Ed25519 key (elifantic-soul-v0.2).
  // The signature covers a canonicalized form of the manifest with the
  // signature field itself excluded, INCLUDING the file_hashes object. So
  // verifying the signature on the receiver also pins the payload bytes.
  if (!options.unsigned) {
    const { privateKey, publicKeyB64 } = await _getSigningKey();
    const signable = _canonicalizeManifestForSigning(manifest);
    const sig = crypto.sign(null, signable, privateKey);
    manifest.signature = {
      algorithm: 'ed25519',
      keyholder_public_key: publicKeyB64,
      signature: sig.toString('base64'),
    };
  }

  const files = [
    { name: 'soul-manifest.json', content: JSON.stringify(manifest, null, 2) },
  ];
  for (const [name, content] of Object.entries(dataFiles)) {
    files.push({ name, content });
  }

  const payload = tar.pack(files);
  _debug(`[brain] exportBrain: ${payload.length} bytes, ${tables.length} tables, ${Object.values(rows).reduce((s, r) => s + r.length, 0)} rows`);
  return { manifest, payload, bytes: payload.length };
}

/**
 * Import a YOINK tarball into this bowl. Inverse of exportBrain.
 *
 * Conflict policy (per primary-key row, where applicable):
 *   - 'skip'         — keep existing row, drop incoming
 *   - 'overwrite'    — replace existing row with incoming
 *   - 'newer-wins'   — compare updated_at, take whichever is newer (default)
 *
 * review_lessons has a serial id (no natural key) — every row imports as a
 * new insert. brain_meta is small kv — newer-wins applies if both bowls have
 * the same key. substrate_identity in brain_meta is NEVER overwritten —
 * the importing bowl keeps its own identity. The exported substrate_identity
 * is reported in the return manifest for audit.
 *
 * @param {object} input
 * @param {Buffer|string} input.payload                       — the tar bytes
 * @param {string} [input.passphrase]                         — v0.3 (Thu)
 * @param {'skip'|'overwrite'|'newer-wins'} [input.conflict='newer-wins']
 * @param {Array<'instance'|'pattern'|'any'>} [input.layer_filter] — default ['any']
 * @param {boolean} [input.allow_unsigned]   — opt in to importing an UNSIGNED soul
 * @param {boolean} [input.allow_replay]     — opt in to a strictly-older export from a known keyholder (anti-replay override)
 * @param {boolean} [input.trust_sender]     — bless a first-contact/known keyholder as trusted
 * @param {boolean} [input.accept_key_change]— accept a deliberate signing-key rotation for a pinned identity
 * @param {'demote'|'preserve'} [input.tier_policy='demote'] — decision-b: 'demote' floors a foreign soul's rows at tier-3 (observed-external); 'preserve' keeps their tiers (the attended "I trust this keyholder" import). A self round-trip always preserves.
 * @returns {Promise<{imported: object, skipped: number, conflicts: number, manifest: object}>}
 */
async function importBrain(input) {
  _ensure();
  if (!input || !input.payload) throw new Error('importBrain: payload required');
  if (input.passphrase) {
    throw new Error('importBrain: encrypted import not yet implemented in this version; tracked for a future v0.3+ release alongside the sync server');
  }
  const conflict = input.conflict || 'newer-wins';
  if (!['skip', 'overwrite', 'newer-wins'].includes(conflict)) {
    throw new Error(`importBrain: unknown conflict policy '${conflict}'`);
  }
  const layerFilter = input.layer_filter || ['any'];

  const payload = Buffer.isBuffer(input.payload) ? input.payload : Buffer.from(input.payload);
  const files = tar.unpack(payload);
  const byName = Object.fromEntries(files.map((f) => [f.name, f.content]));

  if (!byName['soul-manifest.json']) {
    throw new Error('importBrain: soul-manifest.json missing from archive');
  }
  const manifest = JSON.parse(byName['soul-manifest.json'].toString('utf8'));
  const KNOWN_SCHEMAS = ['elifantic-soul-v0', 'elifantic-soul-v0.2'];
  if (!KNOWN_SCHEMAS.includes(manifest.schema)) {
    throw new Error(`importBrain: unknown manifest schema '${manifest.schema}'`);
  }

  // v0.2 signature verification. Modes (enforcement gate is below, after the
  // payload-integrity check — see crypto-02):
  //   verify       — default: a VALID signature proceeds; an INVALID one hard-fails;
  //                  an UNSIGNED soul is rejected unless input.allow_unsigned is set
  //   require      — manifest MUST be signed and verifiable; reject otherwise
  //   skip         — don't verify even if signature present (migration / debug bypass;
  //                  implies allow_unsigned)
  const sigMode = input.signature_mode || 'verify';
  if (!['verify', 'require', 'skip'].includes(sigMode)) {
    throw new Error(`importBrain: unknown signature_mode '${sigMode}'`);
  }
  let signatureStatus = 'unsigned';
  if (manifest.signature) {
    if (sigMode === 'skip') {
      // Signed manifest, but caller explicitly chose not to verify. Distinct
      // from 'unsigned' so callers can tell "I didn't check" from "no
      // signature was attached." Closes bug_008.
      signatureStatus = 'skipped';
    } else {
      try {
        if (manifest.signature.algorithm !== 'ed25519') {
          throw new Error(`unsupported signature algorithm: ${manifest.signature.algorithm}`);
        }
        const pubKeyBytes = Buffer.from(manifest.signature.keyholder_public_key, 'base64');
        if (pubKeyBytes.length !== 32) {
          throw new Error(`malformed public key (length ${pubKeyBytes.length})`);
        }
        // Reconstruct PublicKey object from raw 32-byte Ed25519.
        // Node 18+ supports `format: 'raw'` for Ed25519 public keys via a constructed SPKI prefix:
        const spkiPrefix = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
        const spki = Buffer.concat([spkiPrefix, pubKeyBytes]);
        const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const signable = _canonicalizeManifestForSigning(manifest);
        const sigBytes = Buffer.from(manifest.signature.signature, 'base64');
        const ok = crypto.verify(null, signable, publicKey, sigBytes);
        signatureStatus = ok ? 'verified' : 'invalid';
        if (!ok) throw new Error('signature verification FAILED');
      } catch (e) {
        signatureStatus = 'invalid';
        if (sigMode === 'require') {
          throw new Error(`importBrain: ${e.message} (signature_mode=require)`);
        }
        _debug(`[brain] importBrain: signature check failed (${e.message}); continuing because signature_mode=${sigMode}`);
      }
    }
  } else if (sigMode === 'require') {
    throw new Error('importBrain: manifest is unsigned but signature_mode=require');
  }

  // Payload-integrity check (bug_013 fix). If the signature verified AND
  // the manifest carries file_hashes, every referenced file's SHA-256 must
  // match the manifest. Catches an attacker who swapped .jsonl bytes after
  // signing — without this, the manifest signature only proved the
  // metadata, not the payload.
  // crypto-02 (red-team hardened 2026-06-10) — the payload-integrity binding must
  // be EXHAUSTIVE, not allowlist-only. manifest.file_hashes is the ONLY thing the
  // signature binds to the row payloads, so two PoC bypasses of a partial/optional
  // binding had to be closed: (a) a verified manifest with NO file_hashes (the old
  // `&& manifest.file_hashes` made the whole check optional → arbitrary rows
  // imported as 'verified'); (b) a verified manifest listing a SUBSET, with an
  // extra unlisted *.jsonl the row loops still apply. Now: when verified, require
  // non-empty file_hashes, require every consumed data file present in the archive
  // to be covered by a signed hash, and require every listed hash to match. Any
  // failure is a hard reject.
  if (signatureStatus === 'verified') {
    const CONSUMED = ['state.jsonl', 'memories.jsonl', 'steering.jsonl', 'review_lessons.jsonl', 'brain_meta.json'];
    const hashes = manifest.file_hashes || {};
    if (Object.keys(hashes).length === 0) {
      throw new Error('importBrain: refusing to import — verified manifest carries no file_hashes (the signature binds nothing to the payload)');
    }
    // Every consumed data file PRESENT in the archive must be covered by a signed
    // hash — else an attacker appended unsigned rows past a partial manifest.
    for (const name of CONSUMED) {
      if (byName[name] !== undefined && !(name in hashes)) {
        throw new Error(`importBrain: refusing to import — archive contains '${name}' but it is not in the signed file_hashes (unsigned payload smuggled in)`);
      }
    }
    // Every listed hash must reference a present file whose bytes match.
    for (const [filename, expected] of Object.entries(hashes)) {
      const content = byName[filename];
      if (content === undefined) {
        throw new Error(`importBrain: refusing to import — manifest references '${filename}' but the archive does not contain it`);
      }
      if (_sha256(content) !== expected) {
        throw new Error(`importBrain: refusing to import — '${filename}' content hash mismatch (payload tampered)`);
      }
    }
  }

  // crypto-02 — enforce the verification outcome BEFORE applying any row.
  // Previously the row loops ran unconditionally and, under the default 'verify'
  // mode, the signature was advisory (an invalid or unsigned soul still imported).
  // Now: a present-but-INVALID signature or a payload-hash mismatch is NEVER
  // imported, in any mode — tampering always hard-fails. An UNSIGNED soul is
  // rejected by default; the keyholder opts in with allow_unsigned:true to import
  // a legacy v0 soul (or their own old export) on purpose. allow_unsigned does
  // NOT rescue an invalid signature. 'skip' stays the explicit migration/debug
  // bypass (it implies allow_unsigned). See audit-2026-06-10 (crypto-02/03, tar-02).
  const allowUnsigned = input.allow_unsigned === true || sigMode === 'skip';
  if (signatureStatus === 'invalid') {
    throw new Error('importBrain: refusing to import — signature or payload INVALID (tampered)');
  }
  if (signatureStatus === 'unsigned' && !allowUnsigned) {
    throw new Error('importBrain: refusing to import an UNSIGNED soul; pass allow_unsigned:true to import it deliberately');
  }

  // crypto-01 — trust anchor. A 'verified' signature is only internally
  // consistent; now check WHOSE key signed it. Pin the key per substrate_identity
  // (TOFU); a later soul claiming the same identity with a different key is
  // impersonation and is rejected unless the keyholder confirms a rotation.
  let senderTrust = null;
  const imported = { state: 0, memories: 0, steering: 0, review_lessons: 0 };
  let skipped = 0;
  let conflicts = 0;

  // F (0.14.0) — apply the trust-anchor writes + ALL row mutations atomically.
  // PGlite is a single connection, so BEGIN/COMMIT here makes the whole import
  // all-or-nothing: a malformed row, a constraint violation, a bad brain_meta blob
  // (parsed last), or a crash mid-apply can no longer leave a half-imported bowl
  // with the keyholder high-water already advanced. Any throw rolls back.
  await _db.query('BEGIN');
  let _committed = false;
  try {
  if (signatureStatus === 'verified') {
    const senderId = manifest.substrate_identity || null;
    const senderKey = (manifest.signature && manifest.signature.keyholder_public_key) || null;
    const senderSig = (manifest.signature && manifest.signature.signature) || null;
    const myId = await _getSubstrateIdentity();

    // D (0.14.0) — a verified soul MUST carry a well-formed exported_at. It anchors
    // the anti-replay high-water; a missing/garbage stamp used to make the replay
    // check fail OPEN. Parse to epoch ms (format-robust vs a lexical compare) and
    // reject NaN. E (0.14.0) — and reject a stamp implausibly far in the future, so
    // a hostile first soul can't seed a keyholder's high-water at year 9999 and lock
    // out their genuine later exports.
    const incomingMs = _parseStamp(manifest.exported_at);
    if (!Number.isFinite(incomingMs)) {
      throw new Error('importBrain: refusing to import — a verified soul must carry a well-formed exported_at timestamp');
    }
    if (incomingMs > Date.now() + REPLAY_FUTURE_SKEW_MS) {
      throw new Error('importBrain: refusing to import — soul exported_at is implausibly far in the future (clock-skew or corrupt stamp)');
    }

    if (senderId && senderId === myId) {
      // crypto-01 (red-team hardened 2026-06-10): substrate_identity is PUBLIC —
      // it ships in plaintext in every exported soul — so an identity match alone
      // is NOT a trust anchor. Only the signing key is secret. Require the soul to
      // be signed by THIS bowl's own key; an attacker who stamps our identity onto
      // a foreign-signed soul matches the id but not the key, and must be rejected
      // as an impersonation rather than granted the most-trusted 'self' tier.
      const { publicKeyB64: myKey } = await _getSigningKey();
      if (senderKey && senderKey === myKey) {
        senderTrust = 'self'; // genuinely my own export, re-imported (round-trip / snapshot)
      } else {
        throw new Error("importBrain: refusing to import — manifest claims THIS bowl's substrate_identity but is signed by a different key (identity spoof)");
      }
    } else if (!senderId) {
      // B (0.14.0) — a verified soul with NO substrate_identity can't be pinned or
      // replay-tracked. It used to take a free 'unknown-identity' pass that applied
      // its rows AND permanently escaped the high-water (infinite re-summon, and a
      // clean bypass of the future trust gate). No legitimate export omits it
      // (exportBrain always emits one), so reject it outright.
      throw new Error('importBrain: refusing to import — a verified soul must carry a substrate_identity (it cannot be pinned or replay-tracked without one)');
    } else {
      const known = await _lookupKeyholder(senderId);
      if (!known) {
        // First contact: pin the key (TOFU), accept-and-flag, seed the high-water +
        // the last-accepted signature. NOTE (red-team 2026-06-10): sender_trust is
        // currently ADVISORY — the row loops below apply regardless of trust. The
        // demotion/quarantine of a non-trusted sender's claims is the trust_tier work
        // in Phase A.1 (decision-b); until it lands, a caller MUST gate on
        // sender_trust itself — a first SUMMON of a hostile soul still writes its rows.
        await _db.query(
          `INSERT INTO keyholders (substrate_identity, public_key, display_name, trusted, first_seen, last_seen, last_exported_at, last_signature)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7) ON CONFLICT(substrate_identity) DO NOTHING`,
          [senderId, senderKey, manifest.display_name || null, input.trust_sender === true, _ts(), manifest.exported_at, senderSig]
        );
        senderTrust = input.trust_sender === true ? 'trusted-now' : 'first-contact';
      } else if (known.public_key === senderKey) {
        // Same pinned key — a genuine return visit. Anti-replay: exported_at is a
        // SIGNED field, so an attacker can't forge a newer stamp on an older soul.
        // Reject if EITHER (older) the stamp is strictly older than our high-water —
        // a captured old export — OR (A, 0.14.0) this is the EXACT soul we last
        // accepted (same signature). The latter closes the equal-stamp resurrection
        // hole: re-importing the newest soul after you've DELETED a row from it
        // re-inserts that row (no existing row → no newer-wins protection). A
        // genuinely different same-second sibling has a different signature and still
        // imports; a deliberate re-import opts in with allow_replay.
        const knownMs = _parseStamp(known.last_exported_at);
        const isOlder = Number.isFinite(knownMs) && incomingMs < knownMs;
        const isExactReconsume = senderSig && known.last_signature && senderSig === known.last_signature;
        if ((isOlder || isExactReconsume) && input.allow_replay !== true) {
          const detail = isExactReconsume
            ? 'the exact export already accepted'
            : `exported_at ${manifest.exported_at} is older than the high-water ${known.last_exported_at}`;
          throw new Error(`importBrain: refusing to import — this soul looks like a replay (${detail}) from keyholder ${senderId}. Pass allow_replay:true to import it deliberately.`);
        }
        await _db.query('UPDATE keyholders SET last_seen = $1 WHERE substrate_identity = $2', [_ts(), senderId]);
        // Advance the high-water + last-accepted signature to the newest soul we accept.
        if (!Number.isFinite(knownMs) || incomingMs > knownMs) {
          await _db.query('UPDATE keyholders SET last_exported_at = $1, last_signature = $2 WHERE substrate_identity = $3', [manifest.exported_at, senderSig, senderId]);
        }
        if (input.trust_sender === true && !known.trusted) {
          await _db.query('UPDATE keyholders SET trusted = true WHERE substrate_identity = $1', [senderId]);
        }
        senderTrust = (known.trusted || input.trust_sender === true) ? 'trusted' : 'known-untrusted';
      } else {
        // Same identity, DIFFERENT key — impersonation or an unconfirmed rotation.
        if (input.accept_key_change === true) {
          // A deliberate rotation re-pins the key + re-baselines the last-accepted
          // signature. C (0.14.0) — the high-water is MONOTONIC: keep max(old, incoming)
          // so a rotation can NEVER move the anti-replay watermark backward (the one
          // path that previously could). `trusted` is preserved by design — a rotation
          // is the keyholder vouching "same me, new key" (Steve, 2026-06-10).
          const knownMs = _parseStamp(known.last_exported_at);
          const keepStamp = (Number.isFinite(knownMs) && knownMs >= incomingMs) ? known.last_exported_at : manifest.exported_at;
          await _db.query(
            'UPDATE keyholders SET public_key = $1, last_seen = $2, last_exported_at = $3, last_signature = $4 WHERE substrate_identity = $5',
            [senderKey, _ts(), keepStamp, senderSig, senderId]
          );
          senderTrust = 'key-rotated';
        } else {
          throw new Error(`importBrain: refusing to import — substrate_identity ${senderId} presents a DIFFERENT signing key than the one pinned (possible impersonation). Pass accept_key_change:true to accept a deliberate key rotation.`);
        }
      }
    }
  }

  // trust_tier (decision-b): the tier policy for the rows about to be applied. A
  // self round-trip PRESERVES tiers (it's your own export coming home). Any foreign
  // or unsigned soul DEMOTES by default — its keyholder-direct is, from YOUR bowl,
  // observed-external (tier-3) — unless the keyholder passes tier_policy:'preserve'
  // ("I trust this keyholder, keep their tiers"). _resolveImportTier floors each row.
  // The READ/inject path honoring these tiers is slice 2; this only tags + carries.
  const tierPolicy = (senderTrust === 'self' || input.tier_policy === 'preserve') ? 'preserve' : 'demote';

  // ── state ────────────────────────────────────────────────────────────
  if (byName['state.jsonl']) {
    const rows = _parseJsonl(byName['state.jsonl']);
    for (const row of rows) {
      if (!_layerOk(row, layerFilter)) { skipped++; continue; }
      const existing = await _db.query('SELECT updated_at FROM state WHERE key = $1', [row.key]);
      if (existing.rows[0]) {
        conflicts++;
        if (conflict === 'skip') { skipped++; continue; }
        if (conflict === 'newer-wins' && existing.rows[0].updated_at >= row.updated_at) { skipped++; continue; }
      }
      await _db.query(`
        INSERT INTO state (key, value, updated_by, updated_at, layer, anonymizable, trust_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at,
          layer = EXCLUDED.layer,
          anonymizable = EXCLUDED.anonymizable,
          trust_tier = EXCLUDED.trust_tier
      `, [row.key, row.value, row.updated_by || 'import', row.updated_at || _ts(), row.layer || 'instance', row.anonymizable !== false, _resolveImportTier(row.trust_tier, tierPolicy)]);
      imported.state++;
    }
  }

  // ── memories ─────────────────────────────────────────────────────────
  if (byName['memories.jsonl']) {
    const rows = _parseJsonl(byName['memories.jsonl']);
    for (const row of rows) {
      if (!_layerOk(row, layerFilter)) { skipped++; continue; }
      const existing = await _db.query('SELECT updated_at FROM memories WHERE filename = $1', [row.filename]);
      if (existing.rows[0]) {
        conflicts++;
        if (conflict === 'skip') { skipped++; continue; }
        if (conflict === 'newer-wins' && existing.rows[0].updated_at >= row.updated_at) { skipped++; continue; }
      }
      await _db.query(`
        INSERT INTO memories (filename, content, updated_by, updated_at, layer, anonymizable, trust_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(filename) DO UPDATE SET
          content = EXCLUDED.content,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at,
          layer = EXCLUDED.layer,
          anonymizable = EXCLUDED.anonymizable,
          trust_tier = EXCLUDED.trust_tier
      `, [row.filename, row.content, row.updated_by || 'import', row.updated_at || _ts(), row.layer || 'instance', row.anonymizable !== false, _resolveImportTier(row.trust_tier, tierPolicy)]);
      imported.memories++;
    }
  }

  // ── steering ─────────────────────────────────────────────────────────
  if (byName['steering.jsonl']) {
    const rows = _parseJsonl(byName['steering.jsonl']);
    for (const row of rows) {
      if (!_layerOk(row, layerFilter)) { skipped++; continue; }
      const existing = await _db.query('SELECT updated_at FROM steering WHERE id = $1', [row.id]);
      if (existing.rows[0]) {
        conflicts++;
        if (conflict === 'skip') { skipped++; continue; }
        if (conflict === 'newer-wins' && existing.rows[0].updated_at >= row.updated_at) { skipped++; continue; }
      }
      await _db.query(`
        INSERT INTO steering (id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          content = EXCLUDED.content,
          mode = EXCLUDED.mode,
          match_pattern = EXCLUDED.match_pattern,
          priority = EXCLUDED.priority,
          enabled = EXCLUDED.enabled,
          layer = EXCLUDED.layer,
          updated_at = EXCLUDED.updated_at,
          trust_tier = EXCLUDED.trust_tier
      `, [row.id, row.name, row.content, row.mode || 'always', row.match_pattern || null, row.priority || 0, row.enabled !== false, row.layer || 'instance', row.created_at || _ts(), row.updated_at || _ts(), _resolveImportTier(row.trust_tier, tierPolicy)]);
      imported.steering++;
    }
  }

  // ── review_lessons (serial id, always append) ────────────────────────
  if (byName['review_lessons.jsonl']) {
    const rows = _parseJsonl(byName['review_lessons.jsonl']);
    for (const row of rows) {
      if (!_layerOk(row, layerFilter)) { skipped++; continue; }
      await _db.query(`
        INSERT INTO review_lessons (task_type, rule, source_item_id, layer, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [row.task_type, row.rule, row.source_item_id || null, row.layer || 'instance', row.created_at || _ts()]);
      imported.review_lessons++;
    }
  }

  // ── brain_meta (small kv; defense-in-depth allowlist) ────────────────
  // Only apply keys in BRAIN_META_EXPORTABLE. Even if a malicious or buggy
  // sender includes signing_keypair_v1, substrate_identity, or any other
  // private key in the brain_meta blob, the receiver never applies it.
  // substrate_identity is intentionally NOT in the allowlist — the receiver
  // always keeps their own identity. signing_keypair_v1 is private to
  // each bowl — the receiver always keeps their own signing key.
  if (byName['brain_meta.json']) {
    const incomingMeta = JSON.parse(byName['brain_meta.json'].toString('utf8'));
    for (const [k, v] of Object.entries(incomingMeta)) {
      if (!BRAIN_META_EXPORTABLE.has(k)) continue;
      await _db.query(`
        INSERT INTO brain_meta (key, value) VALUES ($1, $2)
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
      `, [k, v]);
    }
  }

    await _db.query('COMMIT');
    _committed = true;
  } finally {
    // Any throw above (validation, replay reject, bad row, malformed brain_meta,
    // constraint violation) leaves the import wholly un-applied — the high-water
    // never moves on a failed import. See F (0.14.0).
    if (!_committed) { try { await _db.query('ROLLBACK'); } catch { /* nothing to undo */ } }
  }

  _debug(`[brain] importBrain: imported ${JSON.stringify(imported)}, skipped ${skipped}, conflicts ${conflicts}`);
  return { imported, skipped, conflicts, manifest, signature_status: signatureStatus, sender_trust: senderTrust };
}

// ── SNAPSHOT / ROLLBACK / LIST_SNAPSHOTS / HEALTH (Elifantic protocol v0.1) ──
//
// Local-first restore points. A snapshot is a FILESYSTEM dumpDataDir copy of the
// whole PGlite store — NOT an exportBrain dump. exportBrain omits captures,
// embeddings, pinned/archived/trust_tier flags, keyholders, and the Nose meta
// (correct for YOINK federation, catastrophic for a local snapshot), so a snapshot
// built on it would silently lose data. dumpDataDir is full-fidelity by
// construction: every table, column, embedding, flag, and the substrate_identity
// round-trip byte-exact, at the snapshot's Nose version (no re-embed).
//
// Layout (SIBLINGS of brain/, so a dump of brain/ never swallows prior snapshots and
// a `replace` that swaps brain/ leaves restore points intact):
//   <dataDir>/snapshots/<id>.tar.gz   — the gzipped dumpDataDir blob
//   <dataDir>/snapshots/index.jsonl   — append-only, one SnapshotReceipt per line
//   <dataDir>/.rollback-journal.json  — present only mid-swap; drives crash recovery
//
// Snapshots are PLAINTEXT at rest in v0.16: the tarball holds signing_keypair_v1 +
// all data in clear. This is the SAME exposure as the live brain/ store, which
// already persists the keypair in plaintext on disk — not a new leak. Encrypted-at-
// rest (AES-256-GCM / PBKDF2 per the spec) is a tracked follow-on.

const SNAP_RETENTION = { recentDays: 7, dailyDays: 30, weeklyDays: 180, hardCap: 200 };
const SNAP_TABLES = ['state', 'memories', 'steering', 'review_lessons', 'captures', 'keyholders'];
const _DAY_MS = 86400000;

function _snapDir() { return path.join(path.dirname(_dbPath), 'snapshots'); }
function _rollbackJournalPath() { return path.join(path.dirname(_dbPath), '.rollback-journal.json'); }
function _compactTs() { return _ts().replace(/[:-]/g, '').replace('T', '-'); }
function _snapId() { return `snap_${_compactTs()}_${crypto.randomBytes(4).toString('hex')}`; }
function _tsAgo(ms) { return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// Numeric, tie-goes-to-live stamp comparison (format-robust vs lexical >=). Returns
// true when the LIVE row should win (live newer-or-equal) — the snapshot only wins
// when it is strictly newer.
function _liveWins(liveStamp, snapStamp) {
  const a = _parseStamp(liveStamp), b = _parseStamp(snapStamp);
  if (Number.isFinite(a) && Number.isFinite(b)) return a >= b;
  return String(liveStamp) >= String(snapStamp);
}

// Construct a PGlite. CRITICAL (PGlite 0.2.x): loadDataDir for an IN-MEMORY instance
// must use the OPTIONS-FIRST form `new PGlite({loadDataDir})`. `new PGlite(undefined,
// {loadDataDir})` silently drops the options (the constructor only reads options
// when arg 1 is a string), so the temp instance opens EMPTY — the bug that made the
// default forward-merge mode dead-on-arrival. A string path always takes options.
function _newPglite(dataDirOrOpts, opts) {
  const { PGlite } = require('@electric-sql/pglite');
  const { vector } = require('@electric-sql/pglite/vector');
  if (typeof dataDirOrOpts === 'string') return new PGlite(dataDirOrOpts, { extensions: { vector }, ...(opts || {}) });
  return new PGlite({ extensions: { vector }, ...(dataDirOrOpts || {}) });
}
function _blobFromBuffer(buf, name) { return new File([buf], name, { type: 'application/x-gzip' }); }

async function _tableCounts(db) {
  const counts = {};
  for (const t of SNAP_TABLES) {
    try { const r = await db.query(`SELECT count(*)::int AS n FROM ${t}`); counts[t] = r.rows[0].n; }
    catch { /* table absent on a very old loaded snapshot */ }
  }
  return counts;
}
async function _embedMetaOf(db) {
  const r = await db.query("SELECT key, value FROM brain_meta WHERE key IN ('embed_model','embed_dim','embed_version')");
  const m = {};
  for (const row of r.rows) m[row.key] = row.value;
  return { model: m.embed_model || null, dim: m.embed_dim || null, version: m.embed_version || null };
}
async function _tableExists(name) {
  try { const r = await _db.query('SELECT to_regclass($1) AS t', ['public.' + name]); return !!(r.rows[0] && r.rows[0].t); }
  catch { return false; }
}

// Mint a fresh Ed25519 signing keypair blob (same shape _getSigningKey persists).
// Used by fork: a fork is a new being and must never be able to sign as the parent.
function _generateSigningKeypairJson() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' });
  const pubRawKey = pubRaw.subarray(pubRaw.length - 32);
  return JSON.stringify({ algorithm: 'ed25519', private_pem: privPem.toString(), public_b64: pubRawKey.toString('base64'), created_at: new Date().toISOString() });
}

// Canonical, collision-free hash of a capture for forward-merge set-union dedup.
// Hash a JSON ARRAY (field boundaries can't collide), null-safe, sorted-key payload.
// NOTE: _ts() is second-precision, so two genuinely distinct identical-payload events
// in the same second collapse to one on a forward-merge — replace mode is the
// exact-recovery path; documented in the audit capture.
function _canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + _canonicalJson(v[k])).join(',') + '}';
}
function _captureHash(row) {
  const data = row.data == null ? null : (typeof row.data === 'string' ? row.data : _canonicalJson(row.data));
  return _sha256(JSON.stringify(['cap', row.source, row.type, row.ts, data]));
}

// Read the snapshot index, tolerant of a torn/corrupt line ANYWHERE (not just the
// trailing one), dedup by id (a retention-rewrite crash could dupe), and glob-fall-
// back to *.tar.gz on disk when the index is missing/empty so restore capability
// never silently vanishes.
function _readIndex() {
  const snapDir = _snapDir();
  const byId = new Map();
  let txt = '';
  try { txt = fs.readFileSync(path.join(snapDir, 'index.jsonl'), 'utf8'); } catch { txt = ''; }
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { const r = JSON.parse(s); if (r && r.snapshot_id && !byId.has(r.snapshot_id)) byId.set(r.snapshot_id, r); } catch { /* skip corrupt line */ }
  }
  try {
    for (const f of fs.readdirSync(snapDir)) {
      if (!f.endsWith('.tar.gz')) continue;
      const id = f.replace(/\.tar\.gz$/, '');
      if (!byId.has(id)) byId.set(id, { snapshot_id: id, reason: '(recovered; index entry missing)', trigger: 'keyholder-explicit', exported_at: '', table_counts: {}, bytes: 0, storage_uri: path.join(snapDir, f) });
    }
  } catch { /* snapshots dir not created yet */ }
  return [...byId.values()];
}

// Borg-style retention. NEVER reaps an exempt id (the rollback target + the just-
// written snapshot). Rewrites the index FIRST (atomic temp+rename) THEN deletes
// tarballs — a vanished index is a broken promise, an orphan tarball is harmless.
function _applyRetention(exemptIds = []) {
  const snapDir = _snapDir();
  const receipts = _readIndex();
  if (!receipts.length) return;
  const exempt = new Set(exemptIds);
  const now = Date.now();
  receipts.sort((a, b) => (_parseStamp(b.exported_at) || 0) - (_parseStamp(a.exported_at) || 0)); // newest first
  const keep = [];
  const seen = new Set();
  for (const r of receipts) {
    if (exempt.has(r.snapshot_id)) { keep.push(r); continue; }
    const ms = _parseStamp(r.exported_at);
    const ageDays = Number.isFinite(ms) ? (now - ms) / _DAY_MS : 0;
    if (ageDays <= SNAP_RETENTION.recentDays) { keep.push(r); continue; }
    let bucket;
    if (ageDays <= SNAP_RETENTION.dailyDays) bucket = 'D' + Math.floor(ms / _DAY_MS);
    else if (ageDays <= SNAP_RETENTION.weeklyDays) bucket = 'W' + Math.floor(ms / (_DAY_MS * 7));
    else { const d = new Date(ms); bucket = 'M' + (d.getUTCFullYear() * 12 + d.getUTCMonth()); }
    if (!seen.has(bucket)) { seen.add(bucket); keep.push(r); }
  }
  if (keep.length > SNAP_RETENTION.hardCap) {
    let over = keep.length - SNAP_RETENTION.hardCap;
    const capped = [];
    for (let i = keep.length - 1; i >= 0; i--) { // drop oldest non-exempt first
      if (over > 0 && !exempt.has(keep[i].snapshot_id)) { over--; continue; }
      capped.push(keep[i]);
    }
    capped.reverse();
    keep.length = 0; keep.push(...capped);
  }
  const keepIds = new Set(keep.map(r => r.snapshot_id));
  if (keepIds.size === receipts.length) return; // nothing reaped
  const indexPath = path.join(snapDir, 'index.jsonl');
  const tmpIdx = indexPath + '.tmp';
  fs.writeFileSync(tmpIdx, keep.length ? keep.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
  fs.renameSync(tmpIdx, indexPath);
  for (const r of receipts) {
    if (!keepIds.has(r.snapshot_id)) { try { fs.unlinkSync(path.join(snapDir, `${r.snapshot_id}.tar.gz`)); } catch { /* already gone */ } }
  }
}

// Real (non-busy) blocking sleep for the rare sync retry path (recovery runs before
// the event loop is usable). Atomics.wait parks the thread without burning a core.
function _sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable: skip */ }
}
function _rmDir(dir) {
  // Windows can hold a directory handle briefly after PGlite.close(); retry w/ backoff.
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (i === 4) throw e; _sleepSync(150); }
  }
}
function _writeJournal(obj) { fs.writeFileSync(_rollbackJournalPath(), JSON.stringify(obj)); }
function _clearJournal() { try { fs.unlinkSync(_rollbackJournalPath()); } catch { /* already gone */ } }

// Synchronous crash-recovery for an interrupted replace-rollback directory swap.
// Called from init() BEFORE the brain dir is opened. A replace does: write journal
// -> rename brain->brain.old -> rename brain.new->brain -> clear journal -> rm
// brain.old. A crash anywhere must NEVER let init() bootstrap a fresh empty brain
// (that would strand the keyholder's data in brain.old — a silent total wipe).
function _recoverInterruptedSwap(dataDir) {
  const journalPath = path.join(dataDir, '.rollback-journal.json');
  let journal = null;
  try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { journal = null; }
  const brainDir = path.join(dataDir, 'brain');
  const oldDir = brainDir + '.old';
  const newDir = brainDir + '.new';
  const valid = (d) => { try { return fs.existsSync(path.join(d, 'PG_VERSION')); } catch { return false; } };
  const rm = (d) => { try { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
  if (!journal) {
    if (valid(brainDir)) { rm(newDir); rm(oldDir); } // tidy strays from a completed swap
    return;
  }
  if (valid(brainDir)) { // rename#2 done; crash before cleanup
    rm(oldDir); rm(newDir); try { fs.unlinkSync(journalPath); } catch {}
    return;
  }
  if (valid(newDir)) { // rename#1 done, rename#2 not — complete forward to the snapshot
    rm(brainDir); fs.renameSync(newDir, brainDir); rm(oldDir); try { fs.unlinkSync(journalPath); } catch {}
    return;
  }
  if (valid(oldDir)) { // brain.new never made it — revert to the pre-rollback store
    rm(brainDir); fs.renameSync(oldDir, brainDir); rm(newDir); try { fs.unlinkSync(journalPath); } catch {}
    return;
  }
  throw new Error(`elifant: interrupted rollback detected and no valid brain/, brain.new, or brain.old to recover (journal=${JSON.stringify(journal)}). Refusing to bootstrap an empty brain; manual recovery needed.`);
}

/**
 * Capture a portable restore point: a full-fidelity dumpDataDir copy of the store.
 * @param {string} reason - "daily auto" / "before X" / "keyholder: ..."
 * @param {object} [options]
 * @param {'keyholder-explicit'|'schedule'|'pre-action'|'anomaly-triggered'|'capture-burst'} [options.trigger]
 * @returns {Promise<object>} SnapshotReceipt {snapshot_id, reason, trigger, exported_at, table_counts, bytes, sha256, storage_uri, brain_version, substrate_identity}
 */
async function snapshot(reason, options = {}) {
  _ensure();
  const trigger = options.trigger || 'keyholder-explicit';
  const snapDir = _snapDir();
  fs.mkdirSync(snapDir, { recursive: true });
  const id = _snapId();
  // ms-precision (still valid ISO-8601 UTC) so two snapshots in the same second order
  // deterministically newest-first; the rest of the kernel keeps second-precision _ts().
  const exported_at = new Date().toISOString();

  // dumpDataDir is a SYNCHRONOUS tar walk (no awaits → can't interleave with a WASM
  // query), so a concurrent single-statement write lands fully before or after, never
  // torn (multi-statement writes use transaction() exclusivity). CHECKPOINT first is
  // belt-and-braces: flush the WAL so the dump reflects a checkpointed store.
  try { await _db.exec('CHECKPOINT'); } catch { /* non-fatal */ }

  const table_counts = await _tableCounts(_db);
  const substrate_identity = await _getSubstrateIdentity();
  const file = await _db.dumpDataDir('gzip');
  const buf = Buffer.from(await file.arrayBuffer());
  const sha256 = _sha256(buf);

  // Durable write: tmp -> fsync -> rename, so a crash/disk-full mid-write never leaves
  // a truncated tarball at the real path (discovered only at restore).
  const finalPath = path.join(snapDir, `${id}.tar.gz`);
  const tmpPath = finalPath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmpPath, finalPath);

  const receipt = { snapshot_id: id, reason: reason || 'snapshot', trigger, exported_at, table_counts, bytes: buf.length, sha256, storage_uri: finalPath, brain_version: PACKAGE_VERSION, substrate_identity };
  fs.appendFileSync(path.join(snapDir, 'index.jsonl'), JSON.stringify(receipt) + '\n');

  // Retention — but a pre-action (safety) snapshot SKIPS it, so a rollback's safety
  // net can never reap the very target being restored.
  if (trigger !== 'pre-action') {
    try { _applyRetention([id]); } catch (e) { _debug(`[brain] retention: ${e.message}`); }
  }
  _debug(`[brain] snapshot ${id}: ${buf.length} bytes, ${JSON.stringify(table_counts)}`);
  return receipt;
}

function _loadSnapshotBuffer(receipt) {
  const p = receipt.storage_uri || path.join(_snapDir(), `${receipt.snapshot_id}.tar.gz`);
  const buf = fs.readFileSync(p); // throws clearly if the tarball is gone
  if (receipt.sha256) {
    const got = _sha256(buf);
    if (got !== receipt.sha256) throw new Error(`rollback: snapshot ${receipt.snapshot_id} failed integrity check (expected ${receipt.sha256}, got ${got}) — aborting, live untouched`);
  }
  return buf;
}

/**
 * Restore from a snapshot. Three modes (spec RollbackResult shape):
 *   - 'replace'        destroy current state, load snapshot fully (requires options.confirm===true)
 *   - 'forward-merge'  keep current, merge snapshot newer-wins + resurrect-and-flag (default, safest)
 *   - 'fork'           materialize a sibling bowl with a fresh identity, keep both
 * @param {string} snapshotId
 * @param {'replace'|'forward-merge'|'fork'} [mode='forward-merge']
 * @param {object} [options] - {confirm} required true for 'replace'
 * @returns {Promise<object>} RollbackResult {snapshot_id, mode, imported, skipped, conflicts, fork_bowl_id?, ...}
 */
async function rollback(snapshotId, mode = 'forward-merge', options = {}) {
  _ensure();
  if (!['replace', 'forward-merge', 'fork'].includes(mode)) throw new Error(`rollback: unknown mode '${mode}'`);
  const receipt = _readIndex().find(r => r.snapshot_id === snapshotId);
  if (!receipt) throw new Error(`rollback: no snapshot '${snapshotId}'`);
  // Read + integrity-verify the target FULLY into memory FIRST — before any safety
  // snapshot or destructive step — so retention/IO can never strand the target.
  const buf = _loadSnapshotBuffer(receipt);
  if (mode === 'replace') {
    if (options.confirm !== true) throw new Error("rollback: mode 'replace' destroys current state and requires options.confirm===true (keyholder confirmation gesture)");
    return _rollbackReplace(receipt, buf);
  }
  if (mode === 'fork') return _rollbackFork(receipt, buf);
  return _rollbackForwardMerge(receipt, buf);
}

async function _rollbackReplace(receipt, buf) {
  const brainDir = _dbPath;
  const newDir = brainDir + '.new';
  const oldDir = brainDir + '.old';
  const safety = await snapshot(`pre-rollback-replace safety net (before ${receipt.snapshot_id})`, { trigger: 'pre-action' });

  if (fs.existsSync(newDir)) _rmDir(newDir); // stale from a prior crashed replace (loadDataDir refuses a populated dir)
  if (fs.existsSync(oldDir)) _rmDir(oldDir);

  // Load into brain.new + VERIFY (counts + vector probe) BEFORE touching live. A bad
  // blob fails here with live untouched.
  const verify = _newPglite(newDir, { loadDataDir: _blobFromBuffer(buf, `${receipt.snapshot_id}.tar.gz`) });
  await verify.query('SELECT 1');
  await _applySchema(verify);
  const restored_counts = await _tableCounts(verify);
  try { await verify.query('SELECT embedding::text FROM memories WHERE embedding IS NOT NULL LIMIT 1'); }
  catch (e) { await verify.close(); _rmDir(newDir); throw new Error(`rollback replace: vector probe failed on snapshot — aborting, live untouched (${e.message})`); }
  await verify.close();

  // Journaled directory swap. _recoverInterruptedSwap completes/reverts on next init.
  _writeJournal({ phase: 'swapping', snapshot_id: receipt.snapshot_id, safety_snapshot_id: safety.snapshot_id, at: _ts() });
  _ready = false;
  await close(); // close live _db so the rename can't hit an open handle (Windows EPERM)
  fs.renameSync(brainDir, oldDir);
  fs.renameSync(newDir, brainDir);
  _clearJournal(); // brain/ is the restored store; past the no-empty-bootstrap risk

  _db = _newPglite(brainDir);
  await _applySchema(_db);
  _ready = true;
  _rmDir(oldDir);
  return { snapshot_id: receipt.snapshot_id, mode: 'replace', imported: restored_counts, skipped: 0, conflicts: 0, safety_snapshot_id: safety.snapshot_id };
}

async function _rollbackFork(receipt, buf) {
  const forkId = `fork_${_compactTs()}_${crypto.randomBytes(4).toString('hex')}`;
  const forkBrain = path.join(path.dirname(_dbPath), 'forks', forkId, 'brain');
  fs.mkdirSync(path.dirname(forkBrain), { recursive: true });
  const forkDb = _newPglite(forkBrain, { loadDataDir: _blobFromBuffer(buf, `${receipt.snapshot_id}.tar.gz`) });
  await forkDb.query('SELECT 1');
  await _applySchema(forkDb);
  // A fork is a NEW being: fresh substrate_identity + fresh signing keypair (must
  // never sign as the parent). The forking bowl's own identity is untouched.
  const newIdentity = crypto.randomUUID();
  await forkDb.query("INSERT INTO brain_meta (key, value) VALUES ('substrate_identity', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value", [newIdentity]);
  await forkDb.query("INSERT INTO brain_meta (key, value) VALUES ('signing_keypair_v1', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value", [_generateSigningKeypairJson()]);
  const counts = await _tableCounts(forkDb);
  await forkDb.close();
  return { snapshot_id: receipt.snapshot_id, mode: 'fork', imported: counts, skipped: 0, conflicts: 0, fork_bowl_id: newIdentity, fork_path: path.dirname(forkBrain) };
}

async function _rollbackForwardMerge(receipt, buf) {
  // Mandatory pre-merge safety snapshot (kernel-ethics #11; also the undo for the
  // merge itself, so even a surprising merge is rollback-able).
  const safety = await snapshot(`pre-forward-merge safety net (before ${receipt.snapshot_id})`, { trigger: 'pre-action' });

  // IN-MEMORY temp instance — options-first form is REQUIRED (see _newPglite).
  const tmp = _newPglite({ loadDataDir: _blobFromBuffer(buf, `${receipt.snapshot_id}.tar.gz`) });
  await tmp.query('SELECT 1');
  await _applySchema(tmp); // backfill columns a pre-migration snapshot predates

  // Nose compatibility: carry a snapshot Scent only if the live Nose matches; else
  // insert NULL so the resurrected row lands in the re-embed backfill queue (never a
  // stale/poisoned embedding).
  const liveNose = await _embedMetaOf(_db);
  const snapNose = await _embedMetaOf(tmp);
  const noseMatch = liveNose.model === snapNose.model && liveNose.dim === snapNose.dim && liveNose.version === snapNose.version;

  const wmRow = await _db.query("SELECT value FROM brain_meta WHERE key = 'captures_prune_watermark'");
  const pruneWatermark = wmRow.rows[0] ? wmRow.rows[0].value : null;

  const imported = { state: 0, memories: 0, steering: 0, review_lessons: 0, captures: 0 };
  let skipped = 0, conflicts = 0;
  const resurrected = { state: [], memories: [], steering: [], review_lessons: 0, captures: 0 };
  const sid = receipt.snapshot_id;
  let auditId = null;

  // The WHOLE merge runs under transaction() exclusivity. A raw BEGIN only holds the
  // PGlite mutex per-statement, so a concurrent daemon write could land inside the txn
  // and be destroyed by a rollback-on-throw — silent loss in a durability feature.
  // transaction() queues concurrent queries instead (_runExclusiveTransaction).
  await _db.transaction(async (tx) => {
    // state — full-column writes (a partial column list silently resets flags)
    for (const row of (await tmp.query('SELECT key, value, updated_by, updated_at, layer, anonymizable, trust_tier FROM state')).rows) {
      const ex = await tx.query('SELECT updated_at FROM state WHERE key = $1', [row.key]);
      if (ex.rows[0]) {
        conflicts++;
        if (_liveWins(ex.rows[0].updated_at, row.updated_at)) { skipped++; continue; }
        await tx.query(`INSERT INTO state (key,value,updated_by,updated_at,layer,anonymizable,trust_tier) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at, layer=EXCLUDED.layer, anonymizable=EXCLUDED.anonymizable, trust_tier=EXCLUDED.trust_tier`,
          [row.key, row.value, row.updated_by, row.updated_at, row.layer, row.anonymizable, row.trust_tier]);
        imported.state++;
      } else {
        await tx.query(`INSERT INTO state (key,value,updated_by,updated_at,layer,anonymizable,trust_tier,restored_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.key, row.value, row.updated_by, row.updated_at, row.layer, row.anonymizable, row.trust_tier, sid]);
        imported.state++; resurrected.state.push(row.key);
      }
    }
    // memories — embedding gated on noseMatch (NULL → re-embed queue)
    for (const row of (await tmp.query('SELECT filename, content, updated_by, updated_at, layer, anonymizable, embedding::text AS embedding, pinned, archived, trust_tier FROM memories')).rows) {
      const emb = noseMatch ? row.embedding : null;
      const ex = await tx.query('SELECT updated_at FROM memories WHERE filename = $1', [row.filename]);
      if (ex.rows[0]) {
        conflicts++;
        if (_liveWins(ex.rows[0].updated_at, row.updated_at)) { skipped++; continue; }
        await tx.query(`INSERT INTO memories (filename,content,updated_by,updated_at,layer,anonymizable,embedding,pinned,archived,trust_tier) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10)
          ON CONFLICT(filename) DO UPDATE SET content=EXCLUDED.content, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at, layer=EXCLUDED.layer, anonymizable=EXCLUDED.anonymizable, embedding=EXCLUDED.embedding, pinned=EXCLUDED.pinned, archived=EXCLUDED.archived, trust_tier=EXCLUDED.trust_tier`,
          [row.filename, row.content, row.updated_by, row.updated_at, row.layer, row.anonymizable, emb, row.pinned, row.archived, row.trust_tier]);
        imported.memories++;
      } else {
        await tx.query(`INSERT INTO memories (filename,content,updated_by,updated_at,layer,anonymizable,embedding,pinned,archived,trust_tier,restored_from) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,$11)`,
          [row.filename, row.content, row.updated_by, row.updated_at, row.layer, row.anonymizable, emb, row.pinned, row.archived, row.trust_tier, sid]);
        imported.memories++; resurrected.memories.push(row.filename);
      }
    }
    // steering — RESURRECTED rows come back DISABLED (they steer behavior; the
    // keyholder re-enables deliberately). A snapshot-wins UPDATE keeps the snapshot's
    // enabled flag (it's a content update, not a resurrection).
    for (const row of (await tmp.query('SELECT id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier FROM steering')).rows) {
      const ex = await tx.query('SELECT updated_at FROM steering WHERE id = $1', [row.id]);
      if (ex.rows[0]) {
        conflicts++;
        if (_liveWins(ex.rows[0].updated_at, row.updated_at)) { skipped++; continue; }
        await tx.query(`INSERT INTO steering (id,name,content,mode,match_pattern,priority,enabled,layer,created_at,updated_at,trust_tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, content=EXCLUDED.content, mode=EXCLUDED.mode, match_pattern=EXCLUDED.match_pattern, priority=EXCLUDED.priority, enabled=EXCLUDED.enabled, layer=EXCLUDED.layer, updated_at=EXCLUDED.updated_at, trust_tier=EXCLUDED.trust_tier`,
          [row.id, row.name, row.content, row.mode, row.match_pattern, row.priority, row.enabled, row.layer, row.created_at, row.updated_at, row.trust_tier]);
        imported.steering++;
      } else {
        await tx.query(`INSERT INTO steering (id,name,content,mode,match_pattern,priority,enabled,layer,created_at,updated_at,trust_tier,restored_from) VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11)`,
          [row.id, row.name, row.content, row.mode, row.match_pattern, row.priority, row.layer, row.created_at, row.updated_at, row.trust_tier, sid]);
        imported.steering++; resurrected.steering.push(row.id);
      }
    }
    // review_lessons — no natural key; dedup by (task_type, rule) (fixes importBrain's
    // blind-append duplication on the snapshot path)
    for (const row of (await tmp.query('SELECT task_type, rule, source_item_id, layer, created_at FROM review_lessons')).rows) {
      const ex = await tx.query('SELECT 1 FROM review_lessons WHERE task_type = $1 AND rule = $2 LIMIT 1', [row.task_type, row.rule]);
      if (ex.rows[0]) { skipped++; continue; }
      await tx.query(`INSERT INTO review_lessons (task_type, rule, source_item_id, layer, created_at, restored_from) VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.task_type, row.rule, row.source_item_id, row.layer, row.created_at, sid]);
      imported.review_lessons++; resurrected.review_lessons++;
    }
    // captures — set-union dedup by content-hash; skip those at/under the prune
    // watermark (deliberately time-pruned noise must not resurrect — Steve's call)
    const liveHashes = new Set((await tx.query('SELECT source, type, ts, data FROM captures')).rows.map(_captureHash));
    for (const row of (await tmp.query('SELECT source, type, ts, data FROM captures')).rows) {
      if (pruneWatermark && row.ts && row.ts <= pruneWatermark) { skipped++; continue; }
      const h = _captureHash(row);
      if (liveHashes.has(h)) { skipped++; continue; }
      liveHashes.add(h);
      await tx.query('INSERT INTO captures (source, type, ts, data) VALUES ($1,$2,$3,$4)', [row.source, row.type, row.ts, row.data == null ? null : JSON.stringify(row.data)]);
      imported.captures++; resurrected.captures++;
    }
    // brain_meta + identity + keyholders are intentionally NOT merged: same bowl, so
    // identity + signing key + Nose match live's; merging keyholders would resurrect
    // forgotten trust anchors and could roll the anti-replay high-water BACKWARD.
    // (replace mode inherently restores old keyholders + high-water — by design.)

    // audit capture — one row listing exactly what came back, atomic with the merge
    const auditData = { snapshot_id: sid, safety_snapshot_id: safety.snapshot_id, nose_match: noseMatch, note: 'forward-merge resurrect-and-flag; re-z86 anything you meant to delete. same-second identical captures may collapse (replace mode is exact-recovery).', resurrected };
    const ar = await tx.query("INSERT INTO captures (source, type, ts, data) VALUES ('snapshot-restore','forward-merge',$1,$2) RETURNING id", [_ts(), JSON.stringify(auditData)]);
    auditId = String(ar.rows[0].id);
  });
  await tmp.close();
  return { snapshot_id: sid, mode: 'forward-merge', imported, skipped, conflicts, safety_snapshot_id: safety.snapshot_id, resurrected_counts: { state: resurrected.state.length, memories: resurrected.memories.length, steering: resurrected.steering.length, review_lessons: resurrected.review_lessons, captures: resurrected.captures }, audit_capture_id: auditId };
}

/**
 * Enumerate available restore points. Metadata only (SnapshotManifest), newest-first.
 * @param {object} [filter] {since_ts, until_ts, trigger, reason_match, limit}
 * @returns {Promise<Array<object>>}
 */
async function listSnapshots(filter = {}) {
  _ensure();
  let receipts = _readIndex();
  if (filter.since_ts) { const s = _parseStamp(filter.since_ts); receipts = receipts.filter(r => _parseStamp(r.exported_at) >= s); }
  if (filter.until_ts) { const u = _parseStamp(filter.until_ts); receipts = receipts.filter(r => _parseStamp(r.exported_at) <= u); }
  if (filter.trigger) receipts = receipts.filter(r => r.trigger === filter.trigger);
  if (filter.reason_match) receipts = receipts.filter(r => (r.reason || '').includes(filter.reason_match));
  receipts.sort((a, b) => (_parseStamp(b.exported_at) || 0) - (_parseStamp(a.exported_at) || 0));
  if (filter.limit) receipts = receipts.slice(0, filter.limit);
  return receipts.map(r => ({ snapshot_id: r.snapshot_id, reason: r.reason, trigger: r.trigger, exported_at: r.exported_at, table_counts: r.table_counts || {}, bytes: r.bytes || 0 }));
}

/**
 * Substrate self-diagnostic (HealthReport per elifantic-protocol-v0.1). NEVER throws
 * for a known question; an unanswerable facet emits an explicit "not available"
 * observation rather than silently omitting (spec MUST; kernel-ethics #12 — MAY
 * refuse but MUST acknowledge the question was asked).
 * @param {'overview'|'director-changes'|'pattern-additions'|'recall-shift'|'capture-volume'|'unknown-sources'} [question='overview']
 * @returns {Promise<object>} HealthReport {question, baseline_window, observations, proposals?}
 */
async function health(question = 'overview') {
  _ensure();
  const KNOWN = ['overview', 'director-changes', 'pattern-additions', 'recall-shift', 'capture-volume', 'unknown-sources'];
  const observations = [];
  const na = (dimension, note) => ({ dimension, baseline: 'n/a', current: 'not available', delta: 0, significance: 'normal', note });
  let asked = question;
  if (!KNOWN.includes(question)) {
    observations.push({ dimension: 'question', baseline: 'n/a', current: String(question), delta: 0, significance: 'normal', note: 'unrecognized question; returning overview' });
    question = 'overview';
  }
  const want = (q) => question === 'overview' || question === q;

  if (want('capture-volume')) {
    try {
      const last24 = (await _db.query('SELECT count(*)::int n FROM captures WHERE ts >= $1', [_tsAgo(_DAY_MS)])).rows[0].n;
      const last7 = (await _db.query('SELECT count(*)::int n FROM captures WHERE ts >= $1', [_tsAgo(7 * _DAY_MS)])).rows[0].n;
      const dailyAvg = last7 / 7;
      let significance = 'normal';
      if (dailyAvg > 0) { const ratio = last24 / dailyAvg; if (ratio >= 5) significance = 'anomalous'; else if (ratio >= 2.5) significance = 'notable'; }
      observations.push({ dimension: 'capture volume — last 24h vs trailing-7d daily average', baseline: Number(dailyAvg.toFixed(2)), current: last24, delta: dailyAvg > 0 ? Number((last24 - dailyAvg).toFixed(2)) : last24, significance });
    } catch (e) { observations.push(na('capture volume', 'query failed: ' + e.message)); }
  }
  if (want('overview')) {
    try {
      const counts = await _tableCounts(_db);
      observations.push({ dimension: 'table row counts', baseline: 'n/a', current: JSON.stringify(counts), delta: 0, significance: 'normal' });
    } catch (e) { observations.push(na('table row counts', e.message)); }
    try {
      const snaps = _readIndex();
      const stamps = snaps.map(s => _parseStamp(s.exported_at)).filter(Number.isFinite);
      observations.push({ dimension: 'snapshots (restore points) available', baseline: 'n/a', current: snaps.length, delta: 0, significance: snaps.length === 0 ? 'notable' : 'normal', note: snaps.length === 0 ? 'no restore points yet — a snapshot is recommended' : `latest ${stamps.length ? new Date(Math.max(...stamps)).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'unknown'}` });
    } catch (e) { observations.push(na('snapshots', e.message)); }
    try {
      const k = (await _db.query("SELECT count(*)::int total, count(*) FILTER (WHERE trusted)::int trusted FROM keyholders")).rows[0];
      observations.push({ dimension: 'pinned keyholders (trust anchors)', baseline: 'n/a', current: `${k.total} (${k.trusted} trusted)`, delta: 0, significance: 'normal' });
    } catch (e) { observations.push(na('keyholders', e.message)); }
    try {
      const t = (await _db.query("SELECT count(*) FILTER (WHERE trust_tier='tier-3-observed-external')::int t3, count(*) FILTER (WHERE trust_tier='tier-4-raw-exhaust')::int t4 FROM memories")).rows[0];
      observations.push({ dimension: 'memories by trust tier (observed/raw)', baseline: 'n/a', current: `tier-3: ${t.t3}, tier-4: ${t.t4}`, delta: 0, significance: 'normal' });
    } catch (e) { observations.push(na('trust tiers', e.message)); }
  }
  if (want('pattern-additions')) {
    try {
      const n = (await _db.query("SELECT count(*)::int n FROM memories WHERE layer='pattern'")).rows[0].n;
      observations.push({ dimension: 'pattern-layer memories (template/seeded)', baseline: 'n/a', current: n, delta: 0, significance: 'normal' });
    } catch (e) { observations.push(na('pattern additions', e.message)); }
  }
  if (want('unknown-sources')) {
    if (await _tableExists('consent')) {
      try { const n = (await _db.query("SELECT count(*)::int n FROM consent WHERE status='unknown-flagged'")).rows[0].n; observations.push({ dimension: 'unknown-flagged capture sources', baseline: 'n/a', current: n, delta: 0, significance: n > 0 ? 'notable' : 'normal' }); }
      catch (e) { observations.push(na('unknown capture sources', e.message)); }
    } else {
      observations.push(na('unknown capture sources', 'consent projection not present until H3 — cannot enumerate unknown-flagged sources'));
    }
  }
  if (want('director-changes')) observations.push(na('director (router) changes', 'director-change history not retained in this build'));
  if (want('recall-shift')) observations.push(na('recall distribution shift', 'recall history not retained in this build'));

  const proposals = [];
  if (observations.some(o => o.significance === 'notable' || o.significance === 'anomalous')) {
    proposals.push({ kind: 'snapshot', reason: 'one or more observations are above baseline — a snapshot now preserves a clean restore point before anything drifts further' });
  }
  return { question: asked, baseline_window: 'trailing 7 days', observations, proposals: proposals.length ? proposals : undefined };
}

// -- Sync (skeleton; full implementation lands alongside the sync server) --
//
// syncUp: encrypt exportBrain output, POST to a sync server.
// syncDown: GET from a sync server, decrypt, importBrain merge.
//
// Current versions: skeletons only. Real implementation lands in a future
// release alongside the sync server.

/**
 * Push the bowl up to a sync server, encrypted under the keyholder's passphrase.
 *
 * @param {object} options
 * @param {string} options.passphrase - keyholder secret; never sent in plaintext
 * @param {string} options.endpoint - sync server base URL (no default; caller must supply)
 * @param {string} options.keyholderId - opaque per-keyholder identifier
 * @returns {Promise<{stored_at: string, version: string, bytes: number}>}
 */
async function syncUp(options) {
  _ensure();
  throw new Error('syncUp: not yet implemented in this version; tracked for a future v0.3+ release alongside the sync server');
}

/**
 * Pull the latest bowl down from the sync server, decrypt, and merge.
 *
 * @param {object} options
 * @param {string} options.passphrase
 * @param {string} options.endpoint - sync server base URL (no default)
 * @param {string} options.keyholderId
 * @param {'skip'|'overwrite'|'newer-wins'} [options.conflict='newer-wins']
 * @returns {Promise<{imported: object, version: string}>}
 */
async function syncDown(options) {
  _ensure();
  throw new Error('syncDown: not yet implemented in this version; tracked for a future v0.3+ release alongside the sync server');
}

// ── Cleanup ───────────────────────────────────────────────────────────────

async function close() {
  if (_db) {
    await _db.close();
    _db = null;
    _ready = false;
    _debug('[brain] closed');
  }
}

module.exports = {
  init,
  dbPath,
  getName,
  setName,
  getEmbedMeta,
  setEmbedMeta,
  migrateEmbedDim,
  getState,
  setState,
  getAllState,
  deleteState,
  getMemory,
  setMemory,
  setMemoryEmbedding,
  getMemoriesNeedingEmbedding,
  searchMemories,
  deleteMemory,
  getAllMemories,
  // v0.6.0 — memory curation (pin + archive)
  setMemoryPin,
  setMemoryArchive,
  // v0.5.0-dev — captures (event stream / projection sink)
  addCapture,
  getCaptures,
  deleteCaptures,
  seedFromSpore,
  isSeeded,
  // v0.2.0 — Elifantic protocol v0 (skeletons; throw NotImplementedError until Tue/Thu)
  exportBrain,
  importBrain,
  // crypto-01 — keyholder key pinning (TOFU trust anchor)
  listKeyholders,
  setKeyholderTrust,
  forgetKeyholder,
  pinKeyholder,
  // v0.3.0-dev — Elifantic protocol v0.1 (skeletons; throw NotImplementedError until a future release)
  snapshot,
  rollback,
  listSnapshots,
  health,
  // sync (v0.2.0-dev skeleton, full impl lands alongside the sync server in a future release)
  syncUp,
  syncDown,
  close,
  // v0.10.0 — polyglot-skills layer (read + carry over the host-map registry)
  skills,
};
