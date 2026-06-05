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
  fs.mkdirSync(_dbPath, { recursive: true });

  _db = new PGlite(_dbPath, { extensions: { vector } });

  // pgvector must be enabled before any vector(N) columns are declared.
  await _db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      layer TEXT DEFAULT 'instance',
      anonymizable BOOLEAN DEFAULT true
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
      archived BOOLEAN DEFAULT false
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
      updated_at TEXT NOT NULL
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
  `);

  // Migration: add embedding column if upgrading from a 0.3.x database that
  // pre-dates pgvector. Idempotent.
  await _db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(384);`);

  // Migration: add curation flags (pinned, archived) for databases that
  // pre-date v0.6.0. Idempotent.
  await _db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;`);
  await _db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false;`);

  // v0.7.0 — record the Nose (embedder) identity so a brain knows which model
  // produced its Scents. Seeds the historical MiniLM/384 Nose ONLY if absent,
  // so existing brains stay byte-identical. A future Nose swap bumps these via
  // setEmbedMeta() and re-embeds every memory against the new model.
  await _db.exec(`
    INSERT INTO brain_meta (key, value) VALUES
      ('embed_model', 'Xenova/all-MiniLM-L6-v2'),
      ('embed_dim', '384'),
      ('embed_version', '1')
    ON CONFLICT (key) DO NOTHING;
  `);

  _ready = true;
  // _debug writes to stderr (never stdout) so MCP servers using stdio transport
  // don't get "[brain] ..." lines in their JSON-RPC channel. With
  // MEDIAGATO_ELIFANT_DEBUG unset (default), _debug is a no-op for all consumers.
  _debug(`[brain] PGlite initialized at ${_dbPath}`);
  return _db;
}

function _ts() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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
    'SELECT content, layer, updated_at FROM memories WHERE filename = $1', [filename]
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
    SELECT filename, layer, updated_at, updated_by, pinned, archived
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
  await _db.query(
    'UPDATE memories SET pinned = $1 WHERE filename = $2',
    [Boolean(pinned), filename]
  );
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
    ? 'filename, content, layer, updated_at, pinned, (embedding <=> $1::vector) AS distance'
    : 'filename, content, layer, updated_at, (embedding <=> $1::vector) AS distance';
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
    distance: Number(r.distance),
  }));

  if (!doRerank) {
    // Base mode: identical shape + order to pre-0.7.0 (no pinned, no rerank_score).
    return rows.map((r) => ({
      filename: r.filename,
      content: r.content,
      layer: r.layer,
      updated_at: r.updated_at,
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
  const result = await _db.query(
    `SELECT id, source, type, ts, data FROM captures ${whereClause} ORDER BY ts DESC LIMIT ${limit}`,
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
        sql = 'SELECT key, value, updated_by, updated_at, layer, anonymizable FROM state ORDER BY key';
        break;
      case 'memories':
        sql = 'SELECT filename, content, updated_by, updated_at, layer, anonymizable FROM memories ORDER BY filename';
        break;
      case 'steering':
        sql = 'SELECT id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at FROM steering ORDER BY id';
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

  // v0.2 signature verification. Modes:
  //   verify       — default: if manifest has signature, verify it; if missing, allow (legacy v0)
  //   require      — manifest MUST be signed and verifiable; reject otherwise
  //   skip         — don't verify even if signature present (only for migration / debug)
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
  if (signatureStatus === 'verified' && manifest.file_hashes) {
    for (const [filename, expected] of Object.entries(manifest.file_hashes)) {
      const content = byName[filename];
      if (content === undefined) {
        signatureStatus = 'invalid';
        if (sigMode === 'require') {
          throw new Error(`importBrain: manifest references '${filename}' but archive does not contain it (signature_mode=require)`);
        }
        _debug(`[brain] importBrain: file '${filename}' missing from archive`);
        break;
      }
      const actual = _sha256(content);
      if (actual !== expected) {
        signatureStatus = 'invalid';
        if (sigMode === 'require') {
          throw new Error(`importBrain: file '${filename}' content hash mismatch — payload tampered (signature_mode=require)`);
        }
        _debug(`[brain] importBrain: file '${filename}' content tampered (expected ${expected}, got ${actual})`);
        break;
      }
    }
  }

  const imported = { state: 0, memories: 0, steering: 0, review_lessons: 0 };
  let skipped = 0;
  let conflicts = 0;

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
        INSERT INTO state (key, value, updated_by, updated_at, layer, anonymizable)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at,
          layer = EXCLUDED.layer,
          anonymizable = EXCLUDED.anonymizable
      `, [row.key, row.value, row.updated_by || 'import', row.updated_at || _ts(), row.layer || 'instance', row.anonymizable !== false]);
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
        INSERT INTO memories (filename, content, updated_by, updated_at, layer, anonymizable)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(filename) DO UPDATE SET
          content = EXCLUDED.content,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at,
          layer = EXCLUDED.layer,
          anonymizable = EXCLUDED.anonymizable
      `, [row.filename, row.content, row.updated_by || 'import', row.updated_at || _ts(), row.layer || 'instance', row.anonymizable !== false]);
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
        INSERT INTO steering (id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          content = EXCLUDED.content,
          mode = EXCLUDED.mode,
          match_pattern = EXCLUDED.match_pattern,
          priority = EXCLUDED.priority,
          enabled = EXCLUDED.enabled,
          layer = EXCLUDED.layer,
          updated_at = EXCLUDED.updated_at
      `, [row.id, row.name, row.content, row.mode || 'always', row.match_pattern || null, row.priority || 0, row.enabled !== false, row.layer || 'instance', row.created_at || _ts(), row.updated_at || _ts()]);
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

  _debug(`[brain] importBrain: imported ${JSON.stringify(imported)}, skipped ${skipped}, conflicts ${conflicts}`);
  return { imported, skipped, conflicts, manifest, signature_status: signatureStatus };
}

// ── SNAPSHOT / ROLLBACK / LIST_SNAPSHOTS / HEALTH (v0.3 — Elifantic protocol v0.1) ──
//
// Mount points added in protocol v0.1 amendment. These are skeletons in v0.3.0-dev;
// real implementation lands in a future release. See the Elifantic protocol
// v0.1 spec for the full contracts.
//
// Triggers for snapshot per the spec:
//   - 'keyholder-explicit'   ("Bob, snapshot now")
//   - 'schedule'             (daily auto at quiet hour, typically 4am local)
//   - 'pre-action'           (before spore re-seed, federation join, large SUMMON, kernel upgrade)
//   - 'anomaly-triggered'    (HEALTH surface detected drift exceeding baseline)
//   - 'capture-burst'        (single capture source dumped unusually large payload)
//
// Storage: encrypted-at-rest blobs in `<dataDir>/brain/snapshots/<snapshot_id>.tar`
// (or wherever the implementation chooses). Retention: Borg-style cap (N recent +
// N daily + N weekly + N monthly).

/**
 * Capture a portable restore point. Sugar over exportBrain with retention discipline.
 *
 * @param {string} reason - human-readable; "daily auto" / "before X" / "keyholder: ..."
 * @param {object} [options]
 * @param {'keyholder-explicit'|'schedule'|'pre-action'|'anomaly-triggered'|'capture-burst'} [options.trigger]
 * @param {object} [options.scope]
 * @returns {Promise<object>} SnapshotReceipt
 */
async function snapshot(reason, options = {}) {
  _ensure();
  throw new Error('snapshot: not yet implemented in this version (skeleton in v0.3.0-dev; full impl ships with protocol v0.1 amendment)');
}

/**
 * Restore from a snapshot. Three modes:
 *   - 'replace'        destroy current state, load snapshot fully (requires explicit keyholder confirmation)
 *   - 'forward-merge'  keep current, merge snapshot using newer-wins (default, safest)
 *   - 'fork'           load snapshot into a sibling bowl instance, keep both
 *
 * @param {string} snapshotId
 * @param {'replace'|'forward-merge'|'fork'} [mode='forward-merge']
 * @returns {Promise<object>} RollbackResult
 */
async function rollback(snapshotId, mode = 'forward-merge') {
  _ensure();
  throw new Error('rollback: not yet implemented in this version (skeleton in v0.3.0-dev; full impl ships with protocol v0.1 amendment)');
}

/**
 * Enumerate available restore points. Metadata only — keyholder picks an id, then calls rollback().
 *
 * @param {object} [filter]
 * @param {string} [filter.since_ts]      ISO-8601 UTC
 * @param {string} [filter.until_ts]
 * @param {string} [filter.trigger]
 * @param {string} [filter.reason_match]  substring match on reason field
 * @param {number} [filter.limit]
 * @returns {Promise<Array<object>>} SnapshotManifest list
 */
async function listSnapshots(filter = {}) {
  _ensure();
  throw new Error('listSnapshots: not yet implemented in this version (skeleton in v0.3.0-dev; full impl ships with protocol v0.1 amendment)');
}

/**
 * Substrate self-diagnostic. The "is something off?" health-check gesture. Returns a
 * baseline-delta report covering capture volume, director changes, pattern-layer
 * additions from unknown sources, recall-distribution shifts, etc.
 *
 * Kernel-ethics #12: implementations MAY refuse to answer a specific question
 * but MUST acknowledge it was asked. This skeleton returns "not yet implemented"
 * (the substrate's most-honest current state for v0.3.0-dev).
 *
 * @param {'overview'|'director-changes'|'pattern-additions'|'recall-shift'|'capture-volume'|'unknown-sources'} [question='overview']
 * @returns {Promise<object>} HealthReport
 */
async function health(question = 'overview') {
  _ensure();
  throw new Error('health: not yet implemented in this version (skeleton in v0.3.0-dev; full impl ships with protocol v0.1 amendment)');
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
  // v0.3.0-dev — Elifantic protocol v0.1 (skeletons; throw NotImplementedError until a future release)
  snapshot,
  rollback,
  listSnapshots,
  health,
  // sync (v0.2.0-dev skeleton, full impl lands alongside the sync server in a future release)
  syncUp,
  syncDown,
  close,
};
