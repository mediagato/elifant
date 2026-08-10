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
// Cached local device identity (= this bowl's substrate_identity) used as the
// version-vector key on local writes. Reset on close() so a re-init on a different
// dir picks up that bowl's id. Lazily filled by _localDeviceId().
let _deviceIdCache = null;
// True only during a replace-rollback directory swap. While set, _ensure() rejects
// external writes/reads so a concurrent write can't land in live brain/ mid-swap and
// be silently lost when brain/ is renamed to brain.old and deleted.
let _swapInProgress = false;
// crypto-04 — signing key at rest. When a keyholder passphrase is configured (init
// option keyPassphrase / ELIFANT_KEY_PASSPHRASE), the Ed25519 signing private key is
// AES-256-GCM sealed under a PBKDF2-derived KEK and NEVER persisted in clear. Null =
// no passphrase configured → legacy plaintext-at-rest behavior (unchanged, honestly
// reported by health). Set once by init(); read by _getSigningKey().
let _keyPassphrase = null;
// Unwrapped signing key cached for the session so we PBKDF2 (~0.5s) at most once per
// process, not on every sign/export. Same in-memory trust boundary as the key has
// always had while in use. Cleared on close().
let _signingKeyCache = null;

// ── instance armor (capture-flood postmortem, 2026-07-28) ─────────────────────
// PGlite runs all of Postgres inside one WASM instance with finite linear
// memory. Reproduced against a real keyholder brain: a single query that
// materializes a multi-MB result set has TWO failure modes, and both make the
// brain lie rather than fail. (a) The instance traps 'memory access out of
// bounds' and every later query returns that same error forever — a zombie
// writer that still answers health checks. (b) Subtler: the instance survives
// but every subsequent query silently returns ZERO rows with no error — a brain
// that reports itself empty while the data sits intact on disk. The armor is
// three invariants, not per-case patches:
//   1. bounded I/O — no unbounded materialization (getCaptures' byte-budgeted
//      reader; addCapture's size cap + consecutive-duplicate suppression);
//   2. no zombie — a WASM-death error closes and reopens the instance, and the
//      failed call retries once (never inside an explicit transaction);
//   3. no lying — an empty SELECT runs a 'SELECT 1' canary; if the canary also
//      returns nothing the instance is broken: reopen and retry instead of
//      reporting false emptiness.
let _PGliteCtor = null;   // captured at init so _reopen() can construct a replacement
let _vectorExt = null;
let _reopenPromise = null; // single-flight latch: concurrent failures share one reopen
let _rawTxnDepth = 0;      // raw BEGIN/COMMIT depth seen through the guard — no auto-retry inside

function _isWasmDeath(e) {
  const m = (e && e.message) || '';
  return /memory access out of bounds|table index is out of bounds|null function or function signature mismatch|unreachable|Aborted\(/i.test(m)
    || (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError);
}

function _armPGlite(db) {
  const rawQuery = db.query.bind(db);
  const rawExec = db.exec.bind(db);
  db.__rawQuery = rawQuery;
  db.__rawExec = rawExec;
  db.query = (...args) => _guardedCall(rawQuery, 'query', args);
  db.exec = (...args) => _guardedCall(rawExec, 'exec', args);
  return db;
}

async function _reopen(reason) {
  if (!_reopenPromise) {
    _reopenPromise = (async () => {
      // console.error, not _debug: an unhealthy storage instance must be loud in
      // every host's logs, debug flag or not.
      try { console.error(`[brain] PGlite instance unhealthy (${reason}) — reopening ${_dbPath}`); } catch { /* host has no stderr */ }
      // close() on a trapped instance can hang; give it 2s then abandon it.
      try {
        await Promise.race([
          _db.close(),
          new Promise((r) => { const t = setTimeout(r, 2000); if (t.unref) t.unref(); }),
        ]);
      } catch { /* dead instances often cannot close */ }
      _db = _armPGlite(new _PGliteCtor(_dbPath, { extensions: { vector: _vectorExt } }));
      // Apply schema through the RAW handles: routing it through the guard could
      // re-enter _reopen while _reopenPromise is still this very promise — a
      // self-await deadlock. _applySchema only uses query/exec.
      await _applySchema({ query: _db.__rawQuery, exec: _db.__rawExec });
      _rawTxnDepth = 0;
    })().finally(() => { _reopenPromise = null; });
  }
  return _reopenPromise;
}

// Test-only failure injection: makes the next `count` guarded calls observe a
// WASM death ('wasm-death') or an empty result ('silent-empty') at the raw
// layer, so the recovery paths are testable end-to-end. Never set in production.
let _simulate = null;
function _simulateFailure(mode, count = 1) { _simulate = { mode, remaining: count }; }

async function _guardedCall(rawFn, kind, args) {
  const effFn = async (...a) => {
    if (_simulate && _simulate.remaining > 0) {
      _simulate.remaining--;
      if (_simulate.mode === 'wasm-death') throw new Error('memory access out of bounds (simulated)');
      return { rows: [], affectedRows: 0 };
    }
    return rawFn(...a);
  };
  const sql = typeof args[0] === 'string' ? args[0] : '';
  const isBegin = /^\s*BEGIN\b/i.test(sql);
  const isEnd = /^\s*(COMMIT|ROLLBACK)\b/i.test(sql);
  try {
    const result = await effFn(...args);
    if (isBegin) _rawTxnDepth++;
    else if (isEnd) _rawTxnDepth = Math.max(0, _rawTxnDepth - 1);
    if (kind === 'query' && result && Array.isArray(result.rows) && result.rows.length === 0
        && /^\s*(SELECT|WITH)\b/i.test(sql)) {
      let alive = false;
      try { const c = await effFn('SELECT 1 AS __canary'); alive = !!(c && c.rows && c.rows.length === 1); } catch { alive = false; }
      if (!alive) {
        await _reopen('silent-empty canary: SELECT 1 returned no rows');
        if (_rawTxnDepth === 0) return await _db.__rawQuery(...args);
        _rawTxnDepth = 0;
        throw new Error('brain instance was broken mid-transaction (silent-empty canary); instance reopened — retry the operation');
      }
    }
    return result;
  } catch (e) {
    if (_isWasmDeath(e)) {
      const inTxn = _rawTxnDepth > 0;
      await _reopen(`WASM death: ${e.message}`);
      if (!inTxn && !isBegin && !isEnd) {
        return kind === 'query' ? await _db.__rawQuery(...args) : await _db.__rawExec(...args);
      }
    }
    throw e;
  }
}

/**
 * Initialize the brain.
 * @param {string} dataDir - directory under which a 'brain/' subdir will be created
 * @param {object} [options]
 * @param {string} [options.keyPassphrase] - crypto-04: if set (or via env
 *   ELIFANT_KEY_PASSPHRASE), the Ed25519 signing private key is encrypted at rest
 *   (AES-256-GCM under a PBKDF2-600k-derived KEK). An existing plaintext key is
 *   migrated to encrypted on first use. Omit for legacy plaintext-at-rest behavior.
 * @returns {Promise<PGlite>} the underlying PGlite instance (advanced use only)
 */
async function init(dataDir, options = {}) {
  const { PGlite } = require('@electric-sql/pglite');
  const { vector } = require('@electric-sql/pglite/vector');

  // Resolve the key passphrase. An explicit option wins; a non-string or empty
  // string is a HARD error (never silently downgrade to plaintext — that footgun
  // would leave a caller who thinks they configured encryption unencrypted). An
  // absent option falls back to the env var, where empty/unset means "no
  // passphrase" per env convention.
  if (options && Object.prototype.hasOwnProperty.call(options, 'keyPassphrase')) {
    if (typeof options.keyPassphrase !== 'string' || options.keyPassphrase.length === 0) {
      throw new Error('init: keyPassphrase must be a non-empty string when provided');
    }
    _keyPassphrase = options.keyPassphrase;
  } else {
    _keyPassphrase = process.env.ELIFANT_KEY_PASSPHRASE || null;
  }
  _signingKeyCache = null;
  _dbPath = path.join(dataDir, 'brain');
  // crash-safety: finish or revert an interrupted replace-rollback directory swap
  // BEFORE we open the brain dir — otherwise a missing brain/ (mid-swap crash) gets
  // bootstrapped fresh+empty, stranding the keyholder's data in brain.old. See #2.
  _recoverInterruptedSwap(dataDir);
  fs.mkdirSync(_dbPath, { recursive: true });

  _PGliteCtor = PGlite;
  _vectorExt = vector;
  _db = _armPGlite(new PGlite(_dbPath, { extensions: { vector } }));

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

  // 0.16.1: index the forward-merge dedup key so the per-row (task_type, rule) lookup
  // isn't a sequential scan on a large lessons table inside the exclusive merge txn.
  await db.exec(`CREATE INDEX IF NOT EXISTS review_lessons_dedup_idx ON review_lessons (task_type, rule);`);

  // Migration (0.19.0 — continuity fix, multi-device-sync foundation): per-row
  // causal version_vector + content_hash + soft-delete tombstone (deleted_at). Let
  // the merge path replace silent wall-clock last-write-wins (updated_at >=) with
  // CAUSAL domination: concurrent edits surface as conflict-copies instead of one
  // silently eating the other, and a delete propagates as a tombstone instead of a
  // stale present-row silently resurrecting it. All idempotent. version_vector
  // defaults to '{}' (= "no recorded history yet") so existing rows backfill as the
  // earliest lineage — the first local write after upgrade stamps them; deleted_at
  // NULL = live. The three importable/recall-surfaced tables only (review_lessons is
  // append-dedup'd by (task_type, rule); captures is a prune-watermarked event stream).
  for (const t of ['memories', 'state', 'steering']) {
    await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS version_vector TEXT DEFAULT '{}';`);
    await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS content_hash TEXT;`);
    await db.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deleted_at TEXT;`);
  }

  // Migration (0.22.0 — the Keeper, elifant#1/#2/#3). Three additions:
  //   synthesized_via  — names the producer of a derived row ('keeper/shelving-v1'),
  //                      the unwired protocol-v0.1 hook finally getting its writer.
  //   neighbours_at    — per-row Keeper watermark, mirroring the embedding-backfill
  //                      idiom: NULL = "neighbours never computed (or stale)". Set
  //                      when a row's edges land; NULLed by any content/vector
  //                      change. Device-local derived bookkeeping (not exported —
  //                      an imported soul arrives NULL and gets met by the Keeper).
  //   memory_edges     — the neighbour graph: canonical (a<b) pairs with cosine
  //                      distance. Derived, recomputable, device-local.
  // All idempotent.
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS synthesized_via TEXT;`);
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS neighbours_at TEXT;`);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      a_filename TEXT NOT NULL,
      b_filename TEXT NOT NULL,
      distance REAL NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (a_filename, b_filename)
    );
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS memory_edges_b_idx ON memory_edges (b_filename);`);

  // Migration (elifant#11 — steering provenance + the grant floor; lands after
  // the 0.24.0 publish, version left for whoever cuts the release).
  // The steering table is the MANNER slot: rows here change how the brain
  // behaves, not what it knows. Four columns make "who turned this on" a
  // first-class fact instead of an afterthought:
  //   origin       — 'shell-seeded' | 'keyholder' | 'learned'. NULL means the
  //                  row pre-dates this migration, was spore-seeded, or arrived
  //                  from another bowl: provenance genuinely unknown, and never
  //                  invented (K-CARBON-4).
  //   granted_by   — the identity that turned it on. NULL = not granted.
  //   granted_at   — when. Together with granted_by: "traced to who and when".
  //   proposal_id  — the proposal a learned rule came from, so an enabled
  //                  manner rule can be walked back to the evidence that
  //                  suggested it.
  // All idempotent. Deliberately NOT added to the YOINK wire format: a grant is
  // a LOCAL act by the LOCAL keyholder over LOCAL text, so it does not travel.
  await db.exec(`ALTER TABLE steering ADD COLUMN IF NOT EXISTS origin TEXT;`);
  await db.exec(`ALTER TABLE steering ADD COLUMN IF NOT EXISTS granted_by TEXT;`);
  await db.exec(`ALTER TABLE steering ADD COLUMN IF NOT EXISTS granted_at TEXT;`);
  await db.exec(`ALTER TABLE steering ADD COLUMN IF NOT EXISTS proposal_id TEXT;`);

  // The grant floor, at the STORAGE layer rather than the API layer — so it
  // holds against raw SQL, the _internal.query escape hatch, and any future
  // writer that forgets. An enabled steering row must carry a grant.
  //
  // The `origin IS NULL` escape is a DELIBERATE, DOCUMENTED grandfather clause,
  // not an oversight. Adding the constraint without it would fail outright on
  // any existing brain (every spore-seeded row is enabled and ungranted), and
  // would abort YOINK/SUMMON imports of perfectly ordinary peer souls. So the
  // floor binds exactly the rows whose provenance has been declared — which is
  // every row the propose/grant API has ever touched — and leaves pre-
  // provenance rows as they were found. The import paths write origin=NULL
  // explicitly (see importBrain / _mergeWriteSteering) precisely so a foreign
  // row can never land in a half-attributed state.
  //
  // elifant#15's three decisions, made:
  //
  //   1. importBrain / _mergeWriteSteering now force enabled=false on every
  //      foreign row, unconditionally — closing the gap #11 left open. A
  //      foreign soul's steering may NEVER be active through import, in any
  //      conflict mode; it lands exactly where resurrection already lands
  //      (disabled) and needs its own local grant to do anything.
  //   2. Legacy (pre-#11) rows are NOT backfilled with an invented origin, and
  //      the `origin IS NULL` escape stays OPEN — on purpose, not as an
  //      oversight. Backfilling origin on an already-enabled, already-
  //      ungranted row is not representable without either (a) fabricating a
  //      grantor, which is the exact promotion this whole API exists to
  //      forbid (K-CARBON-4: never invent provenance), or (b) silently
  //      disabling behaviour a keyholder has been relying on since before this
  //      migration existed — itself an unrequested personality change, the
  //      same failure mode elifant#15 is about. Neither is a MECHANICAL
  //      migration may perform on its own. So: legacy rows keep whatever
  //      enabled/disabled state they already had, forever ineligible for the
  //      grant floor (their provenance is genuinely unknown, not merely
  //      undeclared) — the escape is not a placeholder for "someday", it is
  //      the honest permanent answer for data this API was never present to
  //      attribute. seedFromSpore (below) is the same case going FORWARD: a
  //      shell's default persona ships enabled with origin=NULL, unchanged,
  //      for the identical reason — inventing 'shell-seeded' provenance on
  //      write would immediately need a grant it has no keyholder to supply.
  //   3. Whether a foreign soul's steering may be enabled at all: NO — see (1).
  //      A keyholder reviews an imported proposal like any other disabled row
  //      (getAllSteering({enabled:false})) and grants it explicitly if wanted.
  //
  // Net effect: an ungranted ENABLED steering row is impossible through the
  // public API for any row whose provenance is declared, AND unreachable going
  // forward through import (every import path now hard-disables). Only a
  // pre-existing, already-enabled legacy row — never touched by proposeSteering
  // and never re-enabled by import — can still show enabled=true with no
  // grant, and only because its provenance predates the concept of one.
  //
  // No `ADD CONSTRAINT IF NOT EXISTS` exists in Postgres, hence the
  // pg_constraint lookup — this runs on every init and must be idempotent.
  const _grantFloor = await db.query(
    "SELECT 1 FROM pg_constraint WHERE conname = 'steering_enabled_requires_grant'"
  );
  if (!_grantFloor.rows[0]) {
    await db.exec(`
      ALTER TABLE steering ADD CONSTRAINT steering_enabled_requires_grant
        CHECK (origin IS NULL OR enabled = false OR (granted_by IS NOT NULL AND granted_at IS NOT NULL));
    `);
  }

  // Migration (elifant#9 — decay: give archival a REASON). Before this, the
  // `archived` boolean quietly meant three different things: the keyholder
  // archiving a row by hand (app/api.js, the mrmags host), the Mind retiring
  // its own knowledge row (mind.js's _retire — already shipped, 0.23.0), and
  // now decay itself. A boolean cannot carry that distinction, and the
  // distinction is load-bearing: mind.js's SOURCE_WHERE decides whether an
  // archived row still counts as EVIDENCE for a pattern, and a decay-archived
  // row must (it was never retracted — nobody said it was wrong, it just went
  // quiet) while a keyholder-archived or Mind-retired row must not (exactly
  // today's behavior). archived_reason is that flag: NULL when not archived,
  // one of ARCHIVE_REASON's three values when it is.
  //
  // Deliberately NOT required on every archive: setMemoryArchive(fn, true) with
  // no third argument still works exactly as it did before this migration —
  // reason lands NULL, same grandfather clause as steering's `origin IS NULL`
  // above (every pre-existing call site — keeper.js's shelf-dissolve archive,
  // every test that predates this issue — keeps working unmodified, and an
  // unattributed archive simply isn't decay, so it is excluded from the Mind's
  // decay-tolerant evidence clause exactly like a keyholder archive would be).
  // Un-archiving always clears the reason (setMemoryArchive's own code, not
  // this constraint) — "why archived" cannot survive not being archived.
  await db.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived_reason TEXT;`);
  const _archiveReasonFloor = await db.query(
    "SELECT 1 FROM pg_constraint WHERE conname = 'memories_archived_reason_valid'"
  );
  if (!_archiveReasonFloor.rows[0]) {
    await db.exec(`
      ALTER TABLE memories ADD CONSTRAINT memories_archived_reason_valid
        CHECK (archived_reason IS NULL OR archived_reason IN ('keyholder', 'mind-retirement', 'decay'));
    `);
  }

  // Migration (elifant#8 — reinforcement: the recall counter). searchMemories
  // was a pure read: retrieving a memory had no effect on its future
  // retrievability, so a note that kept proving useful was no easier to find on
  // the hundredth recall than on the first. Two storage shapes were possible and
  // only one of them is right:
  //
  //   - the counters live in their OWN narrow table, NOT as columns on
  //     `memories`. A recall is a READ, and a read that rewrites rows in the fat
  //     table (content + a 384-dim Scent) manufactures an MVCC dead tuple per
  //     hit per query — write amplification on exactly the table whose
  //     materialization ceiling the capture-flood postmortem taught us to
  //     respect. A ~60-byte row here costs a fraction of that.
  //   - and they are DEVICE-LOCAL derived bookkeeping, like memory_edges and
  //     neighbours_at: your attention is yours. memory_access is not in
  //     ALL_TABLES, so a YOINK never carries it and a SUMMONed soul arrives
  //     un-reinforced — importing a foreign keyholder's usage history would let
  //     their habits silently re-order YOUR recall.
  //
  // Keyed by filename and deliberately NOT a foreign key: memories are
  // soft-deleted, and a tombstone must keep its history in case the row is
  // resurrected. pruneTombstones reaps the orphans once a row is genuinely gone.
  // KNOWN EDGE: a filename re-used for entirely different content inherits the
  // old slot's count — the same thing a content edit already does. The count is
  // about the slot's usefulness; no reader treats it as provenance.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_access (
      filename TEXT PRIMARY KEY,
      access_count INTEGER NOT NULL DEFAULT 0,
      first_accessed TEXT NOT NULL,
      last_accessed TEXT NOT NULL
    );
  `);

  // Migration (elifant#10 — the recall log). health('recall-shift') answered a
  // flat 'not available' because nothing retained what had been recalled; a mind
  // that cannot be asked how its own attention moved is missing a sense, not a
  // feature.
  //
  // Deliberately a DIFFERENT shape from memory_access above, and the reason
  // elifant#8 and #10 are co-travellers rather than a chain: a durable per-row
  // strength score cannot be derived from a log that is designed to be evicted.
  // The counters must survive indefinitely; this log must not, so it carries its
  // own ceiling (_trimRecallLog) instead of growing with use.
  //
  // What is retained is deliberately thin. query_fp is a FINGERPRINT of the
  // query's content terms, never the words — an ever-growing record of
  // everything the keyholder ever asked is a disclosure surface the kernel has
  // no business creating, and a fingerprint answers "is this the same question
  // again?" without it. `hits` is the capped list of what actually counted as
  // recalled, with distances, which is what a distribution-shift question needs.
  // Device-local for the same reason as memory_access: not in ALL_TABLES.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recall_log (
      id BIGSERIAL PRIMARY KEY,
      ts TEXT NOT NULL,
      origin TEXT NOT NULL,
      query_fp TEXT NOT NULL,
      hit_count INTEGER NOT NULL,
      counted_count INTEGER NOT NULL,
      top_distance REAL,
      hits JSONB
    );
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS recall_log_ts_idx ON recall_log (ts DESC);`);

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

// ── archived_reason (elifant#9) ────────────────────────────────────────────
// The THIRD thing that can set `archived = true`, and the reason the boolean
// alone stopped being enough. 'keyholder' — a human archiving a row by hand
// (app/api.js on the mrmags host). 'mind-retirement' — the Mind's own _retire()
// walking a hardened pattern's knowledge row back down the ladder (mind.js,
// elifant#5). 'decay' — nobody touched anything; the row just went quiet long
// enough (src/decay.js, this issue). Every OTHER surface in the kernel that
// filters on `archived = false` (getAllMemories, searchMemories, the Keeper's
// own SOURCE_WHERE) is unchanged by this — it still means "hidden," full stop,
// regardless of why. The ONE place the reason is load-bearing is mind.js's
// SOURCE_WHERE, which must tell "went quiet" apart from "was retracted."
const ARCHIVE_REASON = {
  KEYHOLDER: 'keyholder',
  MIND_RETIREMENT: 'mind-retirement',
  DECAY: 'decay',
};

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
  if (_swapInProgress) throw new Error('Brain is mid-rollback swap; retry shortly.');
}

/** Get the database directory path. */
function dbPath() { return _dbPath; }

/** Get this brain's display name. The kernel ships persona-agnostic: a stored
 *  name wins, else ELIFANT_DEFAULT_NAME (a shell can inject its own default),
 *  else a neutral 'your brain'. Shells name the brain (e.g. Ed, Roz); the
 *  elifant kernel itself owns no persona. */
async function getName() {
  _ensure();
  const result = await _db.query("SELECT value FROM brain_meta WHERE key = 'brain_name'");
  return result.rows[0] ? result.rows[0].value : (process.env.ELIFANT_DEFAULT_NAME || 'your brain');
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
  // ATOMIC (v0.19.1): the DROP + re-ADD + Nose-meta write must all commit together
  // or not at all. A crash between them used to leave a TORN migration — the
  // embedding column re-added at the new dim while brain_meta.embed_dim still named
  // the old one, or the column dropped with no meta update — recoverable only from
  // the pre-Nose backup. PGlite is a single connection (cf. the import path), so a
  // raw BEGIN/COMMIT wraps the whole sequence including setEmbedMeta's writes; any
  // failure rolls the lot back to the prior dim, leaving the brain consistent and
  // the migration safely re-runnable.
  await _db.query('BEGIN');
  try {
    await _db.exec('ALTER TABLE memories DROP COLUMN IF EXISTS embedding;');
    await _db.exec(`ALTER TABLE memories ADD COLUMN embedding vector(${newDim});`);
    await setEmbedMeta({ model, dim: newDim, version });
    await _db.query('COMMIT');
  } catch (e) {
    try { await _db.query('ROLLBACK'); } catch { /* nothing to undo */ }
    throw e;
  }
  const r = await _db.query('SELECT COUNT(*)::int AS n FROM memories WHERE deleted_at IS NULL');
  return r.rows[0] ? r.rows[0].n : 0;
}

// ── State operations ──────────────────────────────────────────────────────

async function getState(key) {
  _ensure();
  const result = await _db.query(
    'SELECT value, layer, updated_at FROM state WHERE key = $1 AND deleted_at IS NULL', [key]
  );
  return result.rows[0] || null;
}

// This bowl's stable version-vector key (= its substrate_identity, which is unique
// per install and never overwritten on import). Cached after first read.
async function _localDeviceId() {
  if (_deviceIdCache) return _deviceIdCache;
  _deviceIdCache = await _getSubstrateIdentity();
  return _deviceIdCache;
}

// Compute the {version_vector, content_hash} to persist for a LOCAL content write.
// Bumps THIS device's counter only when the content actually changed — an identical
// re-save must NOT advance causal history (that would manufacture phantom conflicts
// and break sync convergence). A brand-new row inherits the existing row's vector if
// one is present (e.g. overwriting a tombstone) else starts from '{}' (genesis).
// updated_at is left as the caller's wall-clock (demoted to a display tiebreak).
async function _stampWrite(table, keyCol, keyVal, content) {
  const deviceId = await _localDeviceId();
  const newHash = _sha256(content);
  const ex = await _db.query(`SELECT version_vector, content_hash, deleted_at FROM ${table} WHERE ${keyCol} = $1`, [keyVal]);
  const cur = ex.rows[0];
  const wasTombstoned = !!(cur && cur.deleted_at);
  // A live row re-saved with identical content is a no-op for causal history. But
  // resurrecting a tombstone (deleted_at set) is a NEW event that must dominate the
  // delete — so it always advances, even if the content matches what was deleted.
  if (cur && cur.content_hash === newHash && !wasTombstoned) {
    return { vv: _vvStringify(cur.version_vector), hash: newHash };
  }
  return { vv: _vvStringify(_vvBump(cur && cur.version_vector, deviceId)), hash: newHash };
}

async function setState(key, value, updatedBy = 'brain') {
  _ensure();
  const { vv, hash } = await _stampWrite('state', 'key', key, value);
  await _db.query(`
    INSERT INTO state (key, value, updated_by, updated_at, version_vector, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at,
      version_vector = EXCLUDED.version_vector,
      content_hash = EXCLUDED.content_hash,
      deleted_at = NULL
  `, [key, value, updatedBy, _ts(), vv, hash]);
}

async function getAllState() {
  _ensure();
  const result = await _db.query('SELECT key, value, layer, updated_at FROM state WHERE deleted_at IS NULL ORDER BY key');
  return result.rows;
}

async function deleteState(key) {
  _ensure();
  // Soft-delete: a tombstone (deleted_at set + version-vector bumped) so the delete
  // propagates as a causal event and dominates a stale present-row on another device,
  // instead of a hard DELETE that the next merge silently resurrects. Idempotent: a
  // missing key or an existing tombstone is left alone (no double-bump).
  const deviceId = await _localDeviceId();
  const ex = await _db.query('SELECT version_vector, deleted_at FROM state WHERE key = $1', [key]);
  if (!ex.rows[0] || ex.rows[0].deleted_at) return;
  const vv = _vvStringify(_vvBump(ex.rows[0].version_vector, deviceId));
  await _db.query('UPDATE state SET deleted_at = $1, version_vector = $2 WHERE key = $3', [_ts(), vv, key]);
}

// ── Memory operations ─────────────────────────────────────────────────────

async function getMemory(filename) {
  _ensure();
  const result = await _db.query(
    'SELECT content, layer, updated_at, trust_tier, restored_from FROM memories WHERE filename = $1 AND deleted_at IS NULL', [filename]
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

// ── Near-duplicate guard (the mrmags "remembers things, sometimes doubles
// and injects them" bug) ──────────────────────────────────────────────────
// Two surfaces of one problem: (1) no capture-time semantic dedup existed
// anywhere, so the same fact restated in different words minutes or days
// apart became two independent tier-1 rows forever; (2) loose-tier search
// had no result-set collapse, so both rows could ride into one injected
// context block together. Fixed centrally, here, so setMemoryEmbedding and
// searchMemories share ONE threshold and ONE query shape instead of copies
// that drift apart — the same lesson RELEVANCE_FLOORS already teaches for
// query-to-memory relevance, applied to memory-to-memory closeness instead.
// (setMemory's own synchronous-embedding branch deliberately does NOT call
// into this guard — see the comment on that branch for why: no production
// caller reaches it, and this repo's test suite reaches it constantly with
// one placeholder vector reused across deliberately-unrelated rows, which a
// guard cannot tell apart from a real duplicate.)
//
// THRESHOLD: keeper.js's own SHELF_EDGE_FLOOR (0.12), read via its module
// export (module-cached — this is NOT a second, independently-tunable copy,
// it is the exact same number the Keeper's own shelving pass uses), NOT
// RELEVANCE_FLOORS (0.33/0.40). Those are calibrated for query-to-memory
// relevance — a looser question ("is this close enough to what was ASKED")
// than memory-to-memory sameness ("do these two say the SAME THING").
// keeper.js's header measured the two independently on the first real
// corpus: genuinely-same-subject memory PAIRS land at 0.01-0.10, unrelated
// pairs at 0.13-0.15+, while query-to-memory relevance only compresses that
// tightly around 0.27-0.45. Reusing 0.33/0.40 here would either miss real
// duplicates or — worse — fold distinct memories together. Conservative on
// purpose: a false-positive collapse (hiding a real, distinct memory) is a
// worse failure than an occasional missed duplicate.
const { FLOORS: _NEARDUP_FLOORS } = require('./keeper');
const NEAR_DUP_FLOOR = _NEARDUP_FLOORS.SHELF_EDGE_FLOOR;

// Closest LIVE tier-1 keyholder-direct memory to `embedding`, other than
// `excludeFilename` itself, WITHIN THE SAME layer. Same SOURCE_WHERE
// predicate keeper.js uses for its own neighbour graph (deleted_at IS NULL,
// archived = false, synthesized_via IS NULL, trust_tier = keyholder-direct)
// — so a fresh capture is only ever folded into another KEYHOLDER'S source,
// never into a machine-synthesized shelf/knowledge/confirmed-dup row (those
// are summaries BY CONSTRUCTION close to their own members, which would
// otherwise make near-dup detection fire on the Keeper's and Mind's own
// output).
//
// The layer filter is NOT in keeper.js's SOURCE_WHERE (the Keeper doesn't
// scope its neighbour graph by layer either) but belongs here: 'instance'
// (user-created) and 'pattern' (template-seeded) rows are different
// PURPOSES that can legitimately share near-identical content — a seeded
// pattern describing the same general fact a keyholder later captures
// themselves is not a duplicate CAPTURE, and collapsing across that
// boundary was caught empirically (searchMemories filters-by-layer test)
// silently discarding one layer's row in favor of the other's. Returns null
// if nothing clears NEAR_DUP_FLOOR.
async function _findNearDuplicate(embedding, excludeFilename, layer) {
  const vec = _vectorLiteral(embedding);
  const r = await _db.query(
    `SELECT filename, (embedding <=> $1::vector) AS distance FROM memories
     WHERE embedding IS NOT NULL AND filename != $2 AND deleted_at IS NULL
       AND archived = false AND synthesized_via IS NULL AND trust_tier = $3
       AND layer = $4
     ORDER BY embedding <=> $1::vector LIMIT 1`,
    [vec, excludeFilename, TRUST_TIER.KEYHOLDER_DIRECT, layer]
  );
  const hit = r.rows[0];
  if (!hit) return null;
  const distance = Number(hit.distance);
  return distance < NEAR_DUP_FLOOR ? { filename: hit.filename, distance } : null;
}

// Reinforce one memory exactly like a real recall would (elifant#8's own
// upsert), factored out so BOTH a real search recall (_recordRecall, below)
// and a capture-time near-dup hit can reinforce a row the same way. A dup
// hit is not a query, so there is no hits[]/queryText/recall-log shape to
// feed _recordRecall directly — this is the narrow primitive underneath it.
// access_count + last_accessed ONLY — same invariant _recordRecall already
// documents: never updated_at/version_vector/content_hash, because
// reinforcement is not an edit and must not manufacture a sync conflict or
// hand the recency leg a second, hidden channel.
async function _bumpAccess(filename, ts) {
  await _db.query(`
    INSERT INTO memory_access (filename, access_count, first_accessed, last_accessed)
    VALUES ($1, 1, $2, $2)
    ON CONFLICT(filename) DO UPDATE SET
      access_count = memory_access.access_count + 1,
      last_accessed = EXCLUDED.last_accessed
  `, [filename, ts]);
}

// Pairwise near-dup adjacency among a bounded set of filenames (a search
// candidate pool), using the SAME pgvector `<=>` operator keeper.js uses for
// its own neighbour graph and the SAME NEAR_DUP_FLOOR as the capture-time
// guard above — one threshold, read once, never hand-copied. Returns
// Map<filename, Set<filename>>: "which OTHER candidates in this pool are
// near-dup to this one" (absent/empty for a filename with no near-dup
// partner in the pool). Bounded — the caller's pool is already capped
// (searchMemories' hybrid mode caps it at max(k*5, 30)), so this is at most
// one small self-join, never an unbounded scan (armor invariant 1).
//
// `a.layer = b.layer` for the same reason _findNearDuplicate is layer-scoped
// (see its own comment): 'instance' and 'pattern' rows are different
// purposes, not duplicate captures of each other, even when they land close
// in embedding space. A caller that already filtered the pool to one layer
// (searchMemories' own {layer} option) sees no change from this — every
// filename in the pool already shares a layer — it only matters for an
// unfiltered, cross-layer search.
async function _nearDupEdges(filenames) {
  const adj = new Map();
  if (filenames.length < 2) return adj;
  const r = await _db.query(
    `SELECT a.filename AS a, b.filename AS b FROM memories a
     JOIN memories b ON a.filename < b.filename
     WHERE a.filename = ANY($1::text[]) AND b.filename = ANY($1::text[])
       AND a.layer = b.layer
       AND (a.embedding <=> b.embedding) < $2`,
    [filenames, NEAR_DUP_FLOOR]
  );
  for (const { a, b } of r.rows) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  }
  return adj;
}

async function setMemory(filename, content, updatedBy = 'brain', layer = 'instance', embedding = null) {
  _ensure();
  const { vv, hash } = await _stampWrite('memories', 'filename', filename, content);
  if (embedding == null) {
    // No new vector supplied. If the CONTENT changed, the old vector must go
    // with it — otherwise the row stays semantically findable by its previous
    // meaning and invisible under its current one. Nulling (not keeping)
    // degrades to "not yet searchable", and getMemoriesNeedingEmbedding picks
    // it up on the next backfill. The CASE compares the stored hash against
    // the incoming one inside the same UPDATE, so an unchanged re-save (or a
    // tombstone resurrected with identical content) keeps its vector and
    // never round-trips through the embedder. neighbours_at (the Keeper's
    // per-row watermark) follows the same rule: changed content = stale
    // neighbours, so the row re-enters the neighbour queue.
    await _db.query(`
      INSERT INTO memories (filename, content, updated_by, updated_at, layer, version_vector, content_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(filename) DO UPDATE SET
        content = EXCLUDED.content,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at,
        layer = EXCLUDED.layer,
        version_vector = EXCLUDED.version_vector,
        embedding = CASE WHEN memories.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                         THEN NULL ELSE memories.embedding END,
        neighbours_at = CASE WHEN memories.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                             THEN NULL ELSE memories.neighbours_at END,
        content_hash = EXCLUDED.content_hash,
        deleted_at = NULL
    `, [filename, content, updatedBy, _ts(), layer, vv, hash]);
    return;
  }
  // NOT guarded here on purpose (see the near-dup guard section above
  // setMemory, and setMemoryEmbedding below, for the actual guard). Two
  // things pushed the check off this branch specifically:
  //   1. No real caller reaches it. The one production writer
  //      (mrmags/app/api.js handleSaveMemory) always calls setMemory with
  //      embedding=null and attaches the real vector afterward via
  //      setMemoryEmbedding — confirmed by grepping every setMemory call
  //      site in both repos, not assumed. setMemoryEmbedding carries the
  //      equivalent guard, so the real capture path is fully covered.
  //   2. This branch IS reached constantly by tests, which routinely reuse
  //      one placeholder vector across several deliberately-unrelated rows
  //      as a convenience (a layer-filter test, a prefix-filter test, a
  //      pin-precedence test — none of them about semantic content). A
  //      guard here can't distinguish that convention from a real
  //      duplicate, and measured against this repo's own suite it did not
  //      just flag a few false positives — it silently dropped inserts a
  //      handful of tests depended on. A synchronous-embedding caller that
  //      genuinely wants the guard can always route through
  //      setMemory(embedding=null) + setMemoryEmbedding instead.
  // A fresh vector always invalidates the neighbour set — the edges were
  // computed against the vector this one replaces.
  const vec = _vectorLiteral(embedding);
  await _db.query(`
    INSERT INTO memories (filename, content, updated_by, updated_at, layer, embedding, version_vector, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
    ON CONFLICT(filename) DO UPDATE SET
      content = EXCLUDED.content,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at,
      layer = EXCLUDED.layer,
      embedding = EXCLUDED.embedding,
      neighbours_at = NULL,
      version_vector = EXCLUDED.version_vector,
      content_hash = EXCLUDED.content_hash,
      deleted_at = NULL
  `, [filename, content, updatedBy, _ts(), layer, vec, vv, hash]);
}

// Stamped write for a DERIVED row (the Keeper's shelves; future producers).
// Same causal discipline as setMemory (version vector, content hash, tombstone
// resurrection) plus the two columns that make a derived row honest: an
// explicit trust tier (tier-2-synthesized — never the tier-1 default, K-CARBON-4)
// and synthesized_via naming the producer. Kernel-internal: shells never mint
// synthesized rows directly.
async function _setMemoryDerived(filename, content, { updatedBy = 'keeper', layer = 'instance', embedding = null, trustTier, synthesizedVia, pinned = false } = {}) {
  _ensure();
  if (!trustTier || !synthesizedVia) {
    throw new Error('_setMemoryDerived: trustTier and synthesizedVia are required — an unmarked derived row is a silent promotion');
  }
  const { vv, hash } = await _stampWrite('memories', 'filename', filename, content);
  const vec = embedding == null ? null : _vectorLiteral(embedding);
  await _db.query(`
    INSERT INTO memories (filename, content, updated_by, updated_at, layer, embedding, trust_tier, synthesized_via, version_vector, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10)
    ON CONFLICT(filename) DO UPDATE SET
      content = EXCLUDED.content,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at,
      layer = EXCLUDED.layer,
      embedding = EXCLUDED.embedding,
      trust_tier = EXCLUDED.trust_tier,
      synthesized_via = EXCLUDED.synthesized_via,
      version_vector = EXCLUDED.version_vector,
      content_hash = EXCLUDED.content_hash,
      archived = false,
      deleted_at = NULL
  `, [filename, content, updatedBy, _ts(), layer, vec, trustTier, synthesizedVia, vv, hash]);
  // Pin WITHOUT the tier re-tag: setMemoryPin is the keyholder's tier-1 vouch
  // (decision-a) and a machine-derived row must never take that path — a mind
  // knowledge row is pinned AND tier-2-synthesized, honestly both. Pin-only
  // (never unpins): a keyholder's manual pin on a derived row survives the
  // producer's rewrites.
  if (pinned) {
    await _db.query('UPDATE memories SET pinned = true WHERE filename = $1', [filename]);
  }
}

// Update only the embedding for an existing memory. Used by callers that
// embed asynchronously (after save) or by backfill workers running over
// memories that pre-date the embedding column. Silently no-ops if the
// memory doesn't exist.
//
// Near-dup guard (see the section above setMemory) lives HERE, not in
// setMemory itself — this is where a REAL capture's vector first exists.
// handleSaveMemory (mrmags/app/api.js) always calls setMemory with
// embedding=null and attaches the real vector fire-and-forget, right after
// the row is already inserted (confirmed by grepping every setMemory call
// site in both repos — this is the only production writer). By the time we
// get here the row already exists; there is no "skip the insert" left to
// do, so instead: reinforce the matched original's recall strength, and
// still write the embedding regardless of a hit. Leaving it un-embedded
// would dodge today's collapse but only by creating a row stuck permanently
// outside getMemoriesNeedingEmbedding's contract (NULL forever, re-offered
// to the backfill queue every sweep) for no real benefit — searchMemories'
// own collapse (the other half of this fix) is what keeps a reinforced pair
// from surfacing together, regardless of which path supplied the vector.
async function setMemoryEmbedding(filename, embedding) {
  _ensure();
  const vec = _vectorLiteral(embedding);
  const self = await _db.query('SELECT trust_tier, layer FROM memories WHERE filename = $1', [filename]);
  // Only guard a plain tier-1 keyholder-direct row's OWN embed. Without this,
  // backfilling a synthesized shelf/knowledge row (getMemoriesNeedingEmbedding
  // has no tier filter, so one CAN reach here un-embedded) would "detect" a
  // near-dup against one of its own tier-1 members — true by construction (a
  // shelf's embedding is the mean of its members' vectors) but not a real
  // duplicate-capture event, and reinforcing a member every time its shelf
  // gets re-embedded would be reinforcement noise, not signal.
  if (self.rows[0] && self.rows[0].trust_tier === TRUST_TIER.KEYHOLDER_DIRECT) {
    const dup = await _findNearDuplicate(embedding, filename, self.rows[0].layer);
    if (dup) {
      await _bumpAccess(dup.filename, _ts());
      _debug(`[brain] setMemoryEmbedding: "${filename}" (distance ${dup.distance.toFixed(4)} from "${dup.filename}") reinforced the existing memory on embed`);
    }
  }
  // A replaced vector stales the neighbour set too — the Keeper's per-row
  // watermark resets so the row re-enters the neighbour queue.
  await _db.query(
    'UPDATE memories SET embedding = $1::vector, neighbours_at = NULL WHERE filename = $2',
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
    'SELECT filename, content FROM memories WHERE embedding IS NULL AND deleted_at IS NULL ORDER BY updated_at ASC LIMIT $1',
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
  const where = ['deleted_at IS NULL'];
  if (onlyArchived) {
    where.push('archived = true');
  } else if (!includeArchived) {
    where.push('archived = false');
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const result = await _db.query(`
    SELECT filename, layer, updated_at, updated_by, pinned, archived, archived_reason, trust_tier, restored_from
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
//
// `reason` (elifant#9) names WHY, from ARCHIVE_REASON — optional and NULL by
// default, so every call site that pre-dates this issue (keeper.js's own
// shelf-dissolve archive, every test written before archived_reason existed)
// keeps working unmodified: an archive with no declared reason simply isn't
// decay, and reads as evidence loss in mind.js exactly as it always has.
// Un-archiving always clears the reason regardless of what's passed — "why
// archived" cannot survive not being archived, so a later re-archive for a
// DIFFERENT reason can never silently inherit a stale explanation.
async function setMemoryArchive(filename, archived, reason = null) {
  _ensure();
  const isArchived = Boolean(archived);
  if (isArchived && reason != null && !Object.values(ARCHIVE_REASON).includes(reason)) {
    throw new Error(`setMemoryArchive: unknown archive reason "${reason}" (want ${Object.values(ARCHIVE_REASON).join('|')}, or omit it for an unattributed archive)`);
  }
  await _db.query(
    'UPDATE memories SET archived = $1, archived_reason = $2 WHERE filename = $3',
    [isArchived, isArchived ? reason : null, filename]
  );
}

// elifant#6 follow-up — the keyholder's own resolution of a near-dup Bell ask:
// "yes, these two say the same thing." Writes ONE new tier-2-synthesized row
// naming both members (synthesized_via CONFIRMED_DUP_VIA, distinct from the
// Keeper's own auto-detection tag) so the Mind's evidence-weight override
// (src/mind.js's CONFIRMED_VIA branch) can treat a direct vouch as complete
// evidence instead of waiting on statistical recurrence. Sources are NEVER
// touched (K-CARBON-4) — both originals stay fully recoverable regardless of
// whatever happens to this row afterward.
//
// This is a general "declare these two the same fact" primitive, not coupled
// to any shell's Bell/needs-decision convention — the kernel doesn't know
// what asked the question, only that the keyholder answered it.
const CONFIRMED_DUP_VIA = 'keeper/confirmed-dup-v1'; // kept in sync by hand with mind.js's CONFIRMED_VIA
async function confirmDuplicate(aFilename, bFilename) {
  _ensure();
  if (!aFilename || !bFilename || typeof aFilename !== 'string' || typeof bFilename !== 'string' || aFilename === bFilename) {
    throw new Error('confirmDuplicate: two distinct filenames (string) required');
  }
  const rows = (await _db.query(
    `SELECT filename, content, updated_at, embedding::text AS vec FROM memories
     WHERE filename = ANY($1::text[]) AND deleted_at IS NULL AND archived = false
       AND synthesized_via IS NULL AND trust_tier = $2`,
    [[aFilename, bFilename], TRUST_TIER.KEYHOLDER_DIRECT]
  )).rows;
  const byName = new Map(rows.map((r) => [r.filename, r]));
  const a = byName.get(aFilename);
  const b = byName.get(bFilename);
  if (!a || !b) {
    throw new Error('confirmDuplicate: both memories must be live, tier-1 (keyholder-direct) rows');
  }
  // elifant#17: the same shelving override applies here — crisis-lexicon
  // content is refused outright, never even written as an observation.
  if (_guardModule.crisisMatch(a.content) || _guardModule.crisisMatch(b.content)) {
    throw new Error('confirmDuplicate: refused — crisis-lexicon content never becomes a derived row');
  }
  const thirdParty = _guardModule.thirdPartyCluster([a.content, b.content]);
  const members = [a, b].map((r) => ({ filename: r.filename, day: String(r.updated_at).slice(0, 10) }));
  const content = _keeperModule.renderConfirmedDup(members, { thirdParty });
  let vec = null;
  if (a.vec && b.vec) {
    vec = _keeperModule.meanVector([_keeperModule.parseVec(a.vec), _keeperModule.parseVec(b.vec)]);
  }
  const target = _keeperModule.confirmedDupSlug(aFilename, bFilename);
  await _setMemoryDerived(target, content, {
    updatedBy: 'keyholder-confirmed', layer: 'instance', embedding: vec,
    trustTier: TRUST_TIER.SYNTHESIZED, synthesizedVia: CONFIRMED_DUP_VIA,
  });
  return { filename: target };
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

// ── Reinforcement: the strength leg (elifant#8) ──────────────────────────────
// A recall is evidence. Not evidence that a memory is TRUE — evidence that it
// keeps being the one that answers. The fusion gets a fourth leg built from
// that, and the whole design question is how loud it is allowed to be.
//
//   strength = ln(1 + recalls) * 2^(-days_since_last_recall / HALF_LIFE)
//
//   - LOG, not linear: the 50th recall must not be worth fifty times the first,
//     or one hot week permanently deforms the ranking.
//   - DECAYED, because the issue asks for strength AND recency-of-use, not a
//     lifetime tally. A note recalled twenty times last spring and never since
//     should sink back toward the rows that were never recalled at all — it is
//     no longer what you are working on. The half-life is 30 days: long enough
//     that a monthly rhythm survives it, short enough that a finished project
//     stops crowding the top within a season.
//   - a never-recalled row scores exactly 0, and every never-recalled row scores
//     the SAME 0, so they share one dense rank and are never ordered against
//     each other by noise.
const RECALL_HALF_LIFE_DAYS = 30;
function _strengthOf(accessCount, lastAccessed) {
  const n = Number(accessCount) || 0;
  if (n <= 0) return 0;
  return Math.log1p(n) * Math.pow(2, -_ageDays(lastAccessed) / RECALL_HALF_LIFE_DAYS);
}

// Reciprocal Rank Fusion of cosine + lexical + (pin-aware) recency + (pin-aware)
// strength. Higher = better. recencyWeight keeps recency a light tie-breaker;
// strengthWeight keeps reinforcement lighter still.
//
// WEIGHTED, NOT DOMINANT — with the arithmetic, because "we weighted it" is not
// a guarantee. Every leg contributes 1/(K0 + rank), so across a pool of n rows a
// leg's ENTIRE swing (best rank to worst) is w * (1/K0 - 1/(K0+n-1)). At the
// defaults (K0=60, n=30 candidates, strengthWeight=0.25) that is 0.00136, while
// climbing r places on the cosine leg is worth 1/K0 - 1/(K0+r). Setting those
// equal gives r ~ 5.3: an infinitely-recalled row can buy at most about five
// cosine places in a full pool, and can never arrive at the top from the bottom.
// Raise strengthWeight and that bound moves — it is a dial with a number
// attached, which is the only honest kind.
//
// Pinned rows take POSITIVE_INFINITY on BOTH discretionary legs. The recency leg
// has always done this so it can only ever HELP a pin; the strength leg must
// match, or a loudly-recalled unpinned row could out-score a memory the
// keyholder vouched for by hand and simply never searched for.
function _fuseRerank(rows, queryText, recencyWeight, strengthWeight) {
  const K0 = 60;
  const ids = rows.map((r) => r.filename);
  const distOf = Object.create(null), recOf = Object.create(null), strOf = Object.create(null);
  for (const r of rows) {
    distOf[r.filename] = r.distance;
    recOf[r.filename] = r.pinned ? Number.POSITIVE_INFINITY : -_ageDays(r.updated_at);
    strOf[r.filename] = r.pinned ? Number.POSITIVE_INFINITY : (r.strength || 0);
  }
  const bm = _bm25(queryText, rows.map((r) => ({ id: r.filename, text: r.content })));
  const cosRank = _denseRankMap(ids, (id) => distOf[id], 'asc');
  const lexRank = _denseRankMap(ids, (id) => (bm[id] || 0), 'desc');
  const recRank = _denseRankMap(ids, (id) => recOf[id], 'desc');
  const strRank = _denseRankMap(ids, (id) => strOf[id], 'desc');
  const score = Object.create(null);
  for (const id of ids) {
    score[id] = 1 / (K0 + cosRank[id]) + 1 / (K0 + lexRank[id])
      + recencyWeight * (1 / (K0 + recRank[id]))
      + strengthWeight * (1 / (K0 + strRank[id]));
  }
  return score;
}

// ── Relevance floors (the single source of "close enough") ───────────────────
// searchMemories returns the raw cosine `distance` per row, but "how close is
// close enough to act on?" is a policy every surface used to re-answer on its
// own — and the copies DRIFTED (an auto-inject shell sat at 0.33 while an
// exploration shell sat at 0.40, with no shared anchor). These constants are
// the ONE canonical answer; shells name a tier instead of hardcoding a number.
//
// MEASURED on the live nomic-embed-text Nose (2026-06-16): genuine matches land
// ~0.27-0.33; ambient / off-topic noise compresses to ~0.45+; the clean gap
// sits ~0.40. Two named tiers, because precision-vs-recall is a real per-surface
// trade, not a global constant:
//   - strict (0.33): ambient / auto-injected surfaces. Silent unless confident —
//     "better silence than the wrong book." Recall is sacrificed for precision.
//   - loose  (0.40): user-initiated exploration (related rails, manual search).
//     The keyholder asked, so a weak-but-present link still earns its place.
// Smaller distance = more similar, so a hit is relevant when distance < floor.
// When the embedder changes the numbers move — change them HERE, once.
const RELEVANCE_FLOORS = Object.freeze({ strict: 0.33, loose: 0.40 });

// Is a search hit relevant enough at the given tier? A hit with no numeric
// distance (e.g. an exact-id fetch that was never ranked) is always relevant.
function isRelevant(hit, tier = 'strict') {
  const floor = RELEVANCE_FLOORS[tier];
  if (floor == null) throw new Error(`isRelevant: unknown relevance tier "${tier}" (want strict|loose)`);
  const d = hit && hit.distance;
  return typeof d !== 'number' || d < floor;
}

// Filter a hit list to those relevant at the given tier (order preserved).
function filterRelevant(hits, tier = 'strict') {
  return (hits || []).filter((h) => isRelevant(h, tier));
}

// ── What counts as a recall (elifant#8 + elifant#10) ─────────────────────────
// Counters are only worth something if they count REAL recalls. From the inside
// the kernel cannot tell a keyholder asking a question from a shell sweeping its
// own bookkeeping — both arrive as a vector and a k — so the CALLER must say.
// Fail closed: an unattributed search (the default) counts nothing and logs
// nothing, which means the feature stays dead until a caller opts in on purpose.
// That is the correct trade. A counter that quietly counts the wrong thing is
// worse than no counter, because the ranking then encodes it and nobody can see
// why.
//
// The kernel's OWN consumers are excluded STRUCTURALLY rather than by this flag:
// the Keeper (src/keeper.js) and the Mind (src/mind.js) never call
// searchMemories at all — they read `memories` over raw SQL, so no amount of
// idle-time consolidation can touch a counter. This gate exists for the SHELL
// side, where a near-dup checker, a "related notes" rail, an export audit or a
// re-embed sweep all legitimately use the search surface and would otherwise
// teach the fusion that the kernel's housekeeping is what the keyholder cares
// about.
//
// Recognized origins, and whether each counts:
//   keyholder    — they searched, deliberately. COUNTS.
//   inject       — context assembly surfaced it into a live conversation.
//                  COUNTS. This is the other half of the inject_event loop,
//                  which already records query + filename + distance per
//                  injection and until now was read by nothing.
//   housekeeping — a shell's own bookkeeping sweep. Never counts.
//   keeper       — idle-time consolidation reaching through the search surface
//                  (a shell-side Keeper; the kernel's own does not). Never counts.
//   audit        — a diagnostic / report / health read. Never counts.
// An UNRECOGNIZED origin throws, exactly as isRelevant throws on an unknown
// tier: a typo that silently stopped counting would present as a feature that
// mysteriously does nothing, and that is a bug you find three months later.
const RECALL_ORIGINS = Object.freeze({
  keyholder: true,
  inject: true,
  housekeeping: false,
  keeper: false,
  audit: false,
});

function _recallCounts(origin) {
  if (origin == null || origin === false) return false;
  if (!Object.prototype.hasOwnProperty.call(RECALL_ORIGINS, origin)) {
    throw new Error(`searchMemories: unknown recall origin "${origin}" (want ${Object.keys(RECALL_ORIGINS).join('|')}, or omit it for an unattributed read that counts nothing)`);
  }
  return RECALL_ORIGINS[origin];
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
// recency + pin-aware strength (elifant#8) before the top-K cut. The raw cosine
// `distance` is PRESERVED on every row (downstream relevance floors read its
// absolute value); the fused order is exposed as `rerank_score`. Pass
// {rerank:false} to force base mode. Before the top-K cut, near-duplicate
// hits (pairwise cosine distance under keeper.js's SHELF_EDGE_FLOOR — see the
// near-dup guard section above setMemory) COLLAPSE to the single
// best-ranked member of each cluster, so two near-identical memories never
// both ride in one returned result set; this can return fewer than k rows
// when the candidate pool has fewer than k genuinely-distinct members. Base
// mode does not collapse (see its own note below).
//
// {recall} says WHO is asking (see RECALL_ORIGINS). A real recall advances the
// access counter of every hit that cleared the LOOSE relevance floor and appends
// one row to the recall log; anything else — including the default of saying
// nothing — leaves no trace at all. Accounting runs in BOTH modes; only the
// strength LEG is hybrid-only.
//
// Returns base mode:  [{ filename, content, layer, updated_at, distance }]
//         hybrid mode: [{ ..., distance (raw cosine, unchanged), rerank_score, pinned, strength }]
//   - distance is the raw pgvector cosine distance (0 = identical, 2 = opposite).
//     Score-as-similarity = 1 - distance/2.
//   - strength is the row's EARNED reinforcement score (0 = never recalled), not
//     the +Infinity a pinned row is given inside the fusion.
async function searchMemories({ queryEmbedding, queryText = null, k = 5, layer = null, prefix = null, includeArchived = false, rerank = true, recencyWeight = 0.5, strengthWeight = 0.25, recall = null } = {}) {
  _ensure();
  if (!queryEmbedding) throw new Error('searchMemories: queryEmbedding is required');
  // Validate the origin BEFORE touching the store, so a typo'd origin fails the
  // same way on an empty brain as on a full one.
  const counts = _recallCounts(recall);
  const vec = _vectorLiteral(queryEmbedding);

  const doRerank = rerank && typeof queryText === 'string' && queryText.trim().length > 0;

  const where = ['embedding IS NOT NULL', 'deleted_at IS NULL'];
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

  let out;
  if (!doRerank) {
    // Base mode: pre-0.7.0 shape + the additive trust_tier (slice 2's inject path
    // reads it; existing callers ignore it). Order/distance unchanged. The
    // strength LEG is hybrid-only (there is no fusion here to add a leg to), but
    // recall ACCOUNTING still happens below — a recall is a recall regardless of
    // how the caller asked for it, and only counting hybrid ones would make the
    // counters a measure of caller style rather than of usefulness.
    //
    // Deliberately NOT near-dup collapsed, unlike hybrid mode below: this
    // docstring promises byte-identical-to-pre-0.7.0 output, base mode's SQL
    // LIMIT is already exactly k (no wider pool to backfill a dropped slot
    // from, unlike hybrid's over-fetch), and no real caller needs it — the
    // extension's manual inject pill and the MCP memory_search tool both
    // always send a text query, which routes them into the hybrid branch.
    out = rows.map((r) => ({
      filename: r.filename,
      content: r.content,
      layer: r.layer,
      updated_at: r.updated_at,
      trust_tier: r.trust_tier,
      distance: r.distance,
    }));
  } else {
    // Reinforcement (elifant#8): pull the recall counters for the candidate pool
    // in ONE narrow query rather than joining memory_access into the vector scan
    // — the `ORDER BY embedding <=> ...` plan is the hot path and is left exactly
    // as it was. Integers and stamps only, so the result stays tiny however fat
    // the candidate rows are (armor invariant 1: bounded I/O).
    const acc = await _db.query(
      'SELECT filename, access_count, last_accessed FROM memory_access WHERE filename = ANY($1::text[])',
      [rows.map((r) => r.filename)]
    );
    const strengthBy = Object.create(null);
    for (const a of acc.rows) strengthBy[a.filename] = _strengthOf(a.access_count, a.last_accessed);
    for (const r of rows) r.strength = strengthBy[r.filename] || 0;

    // Hybrid mode: fuse + re-order, PRESERVING the raw cosine distance per row.
    const score = _fuseRerank(rows, queryText, recencyWeight, strengthWeight);
    const ranked = rows
      .map((r) => ({ ...r, rerank_score: score[r.filename] }))
      .sort((a, b) => (b.rerank_score - a.rerank_score) || ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)));

    // Loose-tier result collapse (the mrmags "doubles and injects" bug) — two
    // near-identical memories (same NEAR_DUP_FLOOR as the capture-time guard
    // in the section above setMemory) must never both ride in one returned
    // result set: a keyholder (or an injected context block) seeing one
    // restated fact twice reads it as the kernel repeating itself, not as two
    // corroborating memories. Collapsed BEFORE the top-k cut, over the WIDE
    // candidate pool (up to max(k*5,30) rows) that already exists for
    // reranking — dropping a duplicate here lets a genuinely different,
    // lower-ranked candidate backfill the freed slot instead of silently
    // shrinking the result below k.
    //
    // Greedy top-down over the already-scored order: walk best-to-worst,
    // keep a row unless it is within NEAR_DUP_FLOOR of a row ALREADY kept.
    // The best-ranked member of any near-dup cluster always survives (it is
    // evaluated first, before anything could have disqualified it), so a pin
    // — which _fuseRerank already ranks above an unpinned twin — is never
    // collapsed away BY that twin; only the reverse can happen. When there
    // are no near-dup edges in the pool (the overwhelmingly common case)
    // this is a byte-for-byte no-op: every row is kept, in the same order,
    // and the loop stops at k exactly like the plain .slice(0, k) it
    // replaces.
    //
    // Base mode (below) is untouched on purpose: its own docstring promises
    // output byte-identical to pre-0.7.0, and neither real caller (the
    // extension's manual inject pill, the MCP memory_search tool) ever
    // reaches base mode — both always send a text query, which activates
    // this rerank branch via doRerank.
    const dupEdges = await _nearDupEdges(ranked.map((r) => r.filename));
    const kept = [];
    const keptSet = new Set();
    for (const r of ranked) {
      const dupsOfR = dupEdges.get(r.filename);
      if (dupsOfR && [...dupsOfR].some((f) => keptSet.has(f))) continue;
      kept.push(r);
      keptSet.add(r.filename);
      if (kept.length >= k) break;
    }

    out = kept.map((r) => ({
      filename: r.filename,
      content: r.content,
      layer: r.layer,
      updated_at: r.updated_at,
      distance: r.distance,        // raw cosine — UNCHANGED (relevance floors depend on it)
      rerank_score: r.rerank_score,
      pinned: r.pinned,
      trust_tier: r.trust_tier,
      strength: r.strength,        // the EARNED score, not the pinned +Infinity the fusion used
    }));
  }

  if (counts) {
    // Best-effort: bookkeeping must never turn a successful recall into a failed
    // one — the keyholder asked a question and the answer is already computed.
    // It is loud in the debug channel, and it is not silent at the surface
    // either: a log that stops being written shows up in health('recall-shift')
    // as zero recalls, which reads as "nothing was recalled", not as health.
    try { await _recordRecall(recall, out, queryText, queryEmbedding); }
    catch (e) { _debug(`[brain] recall bookkeeping failed: ${e.message}`); }
  }
  return out;
}

// ── Recall accounting (elifant#8 write path + elifant#10 log) ────────────────
//
// One gate, two consumers, deliberately: a query that does not count as a recall
// did not happen as far as the mind's own history is concerned either. Logging
// housekeeping sweeps would pollute recall-shift with exactly the traffic the
// counters already refuse to be moved by.

// Cap on how many hits ride inside one log row. `k` is caller-chosen and
// unbounded; a log row must not be.
const RECALL_LOG_MAX_HITS = 20;

// Fingerprint, never the words. Content terms are deduped and SORTED, so
// "grateful dead setlists" and "setlists grateful dead" collapse to one
// fingerprint — the same question asked twice is the thing a shift reader wants
// to see. 16 hex chars distinguishes questions comfortably and is far too short
// to be worth attacking; there is nothing to recover from it anyway, since the
// pre-image is a bag of stemless tokens the keyholder already holds.
function _queryFingerprint(queryText, queryEmbedding) {
  const toks = _rerankToks(queryText);
  const basis = toks.length
    ? 'q:' + [...new Set(toks)].sort().join(' ')
    // No query text (base mode). Fingerprint the query Scent instead, rounded to
    // 3dp so floating-point noise in an otherwise identical query doesn't split
    // the group into two questions.
    : 'v:' + queryEmbedding.map((x) => x.toFixed(3)).join(',');
  return _sha256(basis).slice(7, 23);
}

async function _recordRecall(origin, hits, queryText, queryEmbedding) {
  // Only what actually cleared the LOOSE floor counts as recalled. searchMemories
  // returns top-k unconditionally and top-k is NOT a relevance judgement: on a
  // thin brain the k-th hit can be pure noise, and reinforcing it would teach the
  // fusion that noise is useful — the exact failure that makes access counters
  // worthless elsewhere. `loose` rather than `strict` because these are hits a
  // keyholder-initiated or injected read actually surfaced, which is the call
  // RELEVANCE_FLOORS already makes for exploration surfaces.
  const counted = hits.filter((h) => isRelevant(h, 'loose'));
  const ts = _ts();
  // access_count only. NOT updated_at, NOT version_vector, NOT content_hash —
  // a read is not an edit. Bumping the row's causal history on recall would
  // manufacture a sync conflict on every search, and bumping updated_at would
  // feed the recency leg a second, hidden reinforcement channel. (_bumpAccess
  // is the same upsert the near-dup guard reuses for a capture-time hit —
  // ONE reinforcement primitive, not two copies.)
  for (const h of counted) await _bumpAccess(h.filename, ts);

  const dists = hits.map((h) => h.distance).filter((d) => Number.isFinite(d));
  const payload = counted.slice(0, RECALL_LOG_MAX_HITS).map((h) => ({
    f: h.filename,
    d: Number.isFinite(h.distance) ? Number(h.distance.toFixed(4)) : null,
  }));
  const r = await _db.query(`
    INSERT INTO recall_log (ts, origin, query_fp, hit_count, counted_count, top_distance, hits)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [
    ts, origin, _queryFingerprint(queryText, queryEmbedding), hits.length, counted.length,
    // The CLOSEST thing the query found, whatever the fusion then did with the
    // order — "are my questions still finding good answers?" is a different
    // question from "what surfaced first", and this column answers the first one.
    dists.length ? Number(Math.min(...dists).toFixed(4)) : null,
    JSON.stringify(payload),
  ]);

  // Amortized trim. Doing it on every write would put a DELETE + subquery on the
  // read path; doing it never would make "bounded" a lie. The trigger is the
  // BIGSERIAL id, NOT an in-process counter — a host that restarts between every
  // recall would reset an in-memory counter to zero forever and the log would
  // grow without limit while the code claimed a ceiling.
  const id = Number(r.rows[0].id);
  const max = _recallLogMax();
  if (Number.isSafeInteger(id) && id % _recallTrimEvery(max) === 0) await _trimRecallLog(max);
}

// Runtime-evaluated (never module-load), so a host can set the cap after
// require() — the lesson _debug learned the hard way in 0.3.0-dev.2. Floor of 10
// so a pathological config can't turn the log into a single-row table that
// answers nothing.
function _recallLogMax() {
  const n = parseInt(process.env.ELIFANT_RECALL_LOG_MAX, 10);
  return Math.max(10, Number.isFinite(n) && n > 0 ? n : 5000);
}
function _recallTrimEvery(max) { return Math.max(1, Math.min(64, Math.floor(max / 10))); }

/**
 * The hard ceiling on retained recall-log rows: the cap plus the amortization
 * slack (at most one trim interval of overshoot). Exposed because a bound nobody
 * can read is a bound nobody can check.
 */
function recallLogCeiling() { const m = _recallLogMax(); return m + _recallTrimEvery(m) - 1; }

// Keep the newest `max` rows, drop everything older. Cutting by id (monotonic)
// rather than by ts (second-precision, so a whole burst can share one stamp)
// means the boundary is exact instead of taking a whole second with it.
async function _trimRecallLog(max) {
  const cut = await _db.query('SELECT id FROM recall_log ORDER BY id DESC OFFSET $1 LIMIT 1', [max]);
  if (!cut.rows[0]) return 0;
  const r = await _db.query('DELETE FROM recall_log WHERE id <= $1', [cut.rows[0].id]);
  return r.affectedRows || 0;
}

/**
 * Read the recall counters (elifant#8) — how often each memory has actually
 * proved to be the answer, and when it last did. Ordered most-recalled first.
 * `strength` is recomputed at read time from the same function the fusion uses,
 * so a caller sees the number the ranker would see, not a stale stored copy.
 * Device-local: these never travel in a YOINK.
 */
async function getRecallCounts({ filenames = null, limit = 1000 } = {}) {
  _ensure();
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 1000, 10000));
  const cols = 'filename, access_count, first_accessed, last_accessed';
  const r = filenames
    ? await _db.query(`SELECT ${cols} FROM memory_access WHERE filename = ANY($1::text[]) ORDER BY access_count DESC, filename LIMIT $2`, [filenames, lim])
    : await _db.query(`SELECT ${cols} FROM memory_access ORDER BY access_count DESC, filename LIMIT $1`, [lim]);
  return r.rows.map((row) => ({ ...row, strength: _strengthOf(row.access_count, row.last_accessed) }));
}

/**
 * Read the recall log (elifant#10), newest first. Feeds health('recall-shift')
 * and is the substrate a Keeper noticing detector would read — NOTE the honest
 * gap: no detector reads it yet, the kernel's Keeper does not consult it, and
 * wiring one is deliberate follow-on work rather than something to infer here.
 * @param {object} [filter] {since, until, origin, limit}
 */
async function getRecallLog({ since = null, until = null, origin = null, limit = 200 } = {}) {
  _ensure();
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 10000));
  const where = [];
  const params = [];
  let i = 1;
  if (since) { where.push(`ts >= $${i++}`); params.push(since); }
  if (until) { where.push(`ts <= $${i++}`); params.push(until); }
  if (origin) { where.push(`origin = $${i++}`); params.push(origin); }
  params.push(lim);
  const r = await _db.query(`
    SELECT id, ts, origin, query_fp, hit_count, counted_count, top_distance, hits
    FROM recall_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC
    LIMIT $${i}
  `, params);
  return r.rows.map((row) => ({
    ...row,
    id: String(row.id),
    top_distance: row.top_distance == null ? null : Number(row.top_distance),
    hits: row.hits || [],
  }));
}

/**
 * Prune the recall log deliberately, by time (`olderThan`) and/or by count
 * (`keep` newest rows). One of the two is required — the log is ALREADY bounded
 * automatically (see recallLogCeiling), so this is the keyholder's gesture, not
 * the safety net, and an unfiltered call is far more likely to be a mistake than
 * an intent. Mirrors deleteCaptures' refusal to wipe on no filter.
 * @returns {Promise<number>} rows deleted
 */
async function pruneRecallLog({ olderThan = null, keep = null } = {}) {
  _ensure();
  if (!olderThan && keep == null) {
    throw new Error('pruneRecallLog: one of olderThan (ISO-8601 cutoff) or keep (newest-N to retain) is required');
  }
  let n = 0;
  if (olderThan) {
    const r = await _db.query('DELETE FROM recall_log WHERE ts <= $1', [olderThan]);
    n += r.affectedRows || 0;
  }
  if (keep != null) {
    const k = Math.max(0, parseInt(keep, 10) || 0);
    n += await _trimRecallLog(k);
  }
  return n;
}

async function deleteMemory(filename) {
  _ensure();
  // Soft-delete: a tombstone (deleted_at set + version-vector bumped) so the delete
  // propagates as a causal event and dominates a stale present-row on another device,
  // instead of a hard DELETE that the next merge silently resurrects. Content is
  // retained (filtered from every read) until tombstone GC. Idempotent: a missing
  // file or an existing tombstone is left alone (no double-bump).
  const deviceId = await _localDeviceId();
  const ex = await _db.query('SELECT version_vector, deleted_at FROM memories WHERE filename = $1', [filename]);
  if (!ex.rows[0] || ex.rows[0].deleted_at) return;
  const vv = _vvStringify(_vvBump(ex.rows[0].version_vector, deviceId));
  await _db.query('UPDATE memories SET deleted_at = $1, version_vector = $2 WHERE filename = $3', [_ts(), vv, filename]);
}

/**
 * Garbage-collect tombstones: hard-DELETE soft-deleted memories + state whose
 * deleted_at is at/older than the cutoff. A tombstone can only be SAFELY reaped
 * once EVERY device has seen the delete — otherwise a lagging device's stale
 * present-row resurrects it on the next merge. Phase 0 has no sync cursor to prove
 * "everyone has synced", so this is deliberately NOT auto-invoked and has no
 * default cutoff: the caller must pass an `olderThan` it is confident every device
 * has synced past. The relay phase makes the watermark precise (reap once the
 * minimum device cursor passes it). Advances `tombstone_prune_watermark` (mirrors
 * `captures_prune_watermark`) so a later merge won't resurrect a reaped tombstone's
 * pre-delete row. ISO-8601 stamps compare correctly as TEXT.
 * @param {object} opts
 * @param {string} opts.olderThan - ISO-8601 cutoff (required; reap deleted_at <= this)
 * @returns {Promise<number>} tombstones reaped
 */
async function pruneTombstones({ olderThan } = {}) {
  _ensure();
  if (!olderThan || typeof olderThan !== 'string') {
    throw new Error('pruneTombstones: an explicit olderThan (ISO-8601) cutoff is required — there is no safe default without a sync cursor');
  }
  let reaped = 0;
  for (const t of ['memories', 'state']) {
    const r = await _db.query(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at <= $1`, [olderThan]);
    reaped += r.affectedRows || 0;
  }
  // elifant#8 — the access counters are keyed by filename with no foreign key,
  // because a tombstone must keep its history in case the row is resurrected.
  // Once the row is genuinely gone the counter is an orphan, and THIS is the one
  // place a memory is ever hard-deleted. Mirrors the Keeper's NOT EXISTS sweep
  // over memory_edges. Unconditional (not gated on reaped > 0): a previous
  // partial reap or a hand-deleted row would otherwise strand a counter forever.
  await _db.query('DELETE FROM memory_access a WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.filename = a.filename)');
  if (reaped > 0) {
    await _db.query(`
      INSERT INTO brain_meta (key, value) VALUES ('tombstone_prune_watermark', $1)
      ON CONFLICT(key) DO UPDATE SET value = GREATEST(brain_meta.value, EXCLUDED.value)
    `, [olderThan]);
  }
  return reaped;
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
 *
 * Feeder armor (capture-flood postmortem, 2026-07-28): the event stream must
 * survive a misbehaving producer. A real feeder once POSTed the same ~358 KB
 * payload every minute for an hour — 96 rows, 11 distinct payloads — until
 * reads crossed the WASM materialization ceiling and the whole brain read as
 * empty. Two guards, both here at the sink so EVERY producer is covered:
 *   - size cap: a single capture's serialized data may not exceed
 *     ELIFANT_MAX_CAPTURE_BYTES (default 1 MiB) — rejected loudly, never
 *     truncated silently;
 *   - consecutive-duplicate suppression: if the newest capture for the same
 *     (source, type) carries a byte-identical payload, the write is skipped and
 *     the existing row is returned with deduped: true. Only CONSECUTIVE
 *     duplicates collapse — an A→B→A sequence stores all three rows, because a
 *     re-appearing payload after something else happened is a real event.
 *     Producers that genuinely mean the repeat (heartbeats) pass
 *     allowDuplicate: true.
 *
 * @param {Object} cap
 * @param {string} cap.source - producer identifier ('extension', 'daemon', 'cli', ...)
 * @param {string} [cap.type] - source-specific event type ('conversation_visit', 'job_started', ...)
 * @param {Object} [cap.data] - structured payload, JSON-serializable
 * @param {string} [cap.ts] - ISO 8601 timestamp; defaults to now
 * @param {boolean} [cap.allowDuplicate=false] - store even if byte-identical to the newest (source, type) capture
 * @returns {Promise<{id: string, ts: string, deduped?: true}>} deduped is present (true) only when the write was suppressed
 */
async function addCapture({ source, type = null, data = null, ts = null, allowDuplicate = false } = {}) {
  _ensure();
  if (!source || typeof source !== 'string') {
    throw new Error('addCapture: source (string) required');
  }
  const timestamp = ts || _ts();
  const payload = data == null ? null : JSON.stringify(data);

  const maxBytes = Math.max(1024, parseInt(process.env.ELIFANT_MAX_CAPTURE_BYTES, 10) || 1024 * 1024);
  if (payload != null) {
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > maxBytes) {
      const err = new Error(`addCapture: data too large (${bytes} bytes > ${maxBytes}-byte cap) — split the payload or raise ELIFANT_MAX_CAPTURE_BYTES`);
      err.code = 'ECAPTURETOOLARGE';
      throw err;
    }
  }

  if (!allowDuplicate) {
    // Compare against the NEWEST row for this (source, type) only. jsonb::text is
    // Postgres' own normalized rendering on both sides, so key order / whitespace
    // differences in the incoming JSON can't defeat the comparison.
    const prev = await _db.query(
      `SELECT id, ts, (data::text IS NOT DISTINCT FROM $3::jsonb::text) AS same
       FROM captures
       WHERE source = $1 AND type IS NOT DISTINCT FROM $2
       ORDER BY ts DESC, id DESC LIMIT 1`,
      [source, type, payload]
    );
    if (prev.rows[0] && prev.rows[0].same === true) {
      return { id: String(prev.rows[0].id), ts: prev.rows[0].ts, deduped: true };
    }
  }

  const result = await _db.query(
    `INSERT INTO captures (source, type, ts, data) VALUES ($1, $2, $3, $4) RETURNING id, ts`,
    [source, type, timestamp, payload]
  );
  return { id: String(result.rows[0].id), ts: result.rows[0].ts };
}

// Greedy-pack rows into id batches whose summed payload size stays under
// budgetBytes (always at least one row per batch, so a single oversized row
// still fetches — alone). Pure; exported via __internals for the test suite.
function _batchByBudget(rows /* [{id, len}] in desired order */, budgetBytes) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const r of rows) {
    const len = Number(r.len) || 0;
    if (cur.length > 0 && curBytes + len > budgetBytes) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(r.id);
    curBytes += len;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

// Bounded-materialization capture reader (armor invariant 1). One unbounded
// `SELECT ... data FROM captures` materializing a multi-MB result inside
// PGlite's WASM memory is exactly what broke a real brain — so no caller gets
// to do that anymore. Two phases: (A) fetch only (id, octet_length(data)) —
// integers, tiny result regardless of table size; (B) fetch full rows in id
// batches packed so each query's summed payload stays under the byte budget.
// Works against any query function (the live guarded _db, or a tx/tmp instance
// inside rollback/merge). Order is ts DESC, id DESC throughout — the id
// tiebreak also makes same-second events deterministic, which the old
// ORDER BY ts DESC alone was not.
async function _readCapturesBudgeted(queryFn, { whereClause = '', params = [], limit = null, columns = 'id, source, type, ts, data' } = {}) {
  const budget = Math.max(65536, parseInt(process.env.ELIFANT_READ_BUDGET_BYTES, 10) || 4 * 1024 * 1024);
  const scanParams = params.slice();
  let scanSql = `SELECT id, COALESCE(octet_length(data::text), 0) AS len FROM captures ${whereClause} ORDER BY ts DESC, id DESC`;
  if (limit != null) {
    scanParams.push(limit);
    scanSql += ` LIMIT $${scanParams.length}`;
  }
  const scan = await queryFn(scanSql, scanParams);
  if (scan.rows.length === 0) return [];
  const out = [];
  for (const ids of _batchByBudget(scan.rows, budget)) {
    // ids come from the server's own bigserial column this same transaction —
    // integers by construction; Number() them anyway so nothing non-numeric can
    // ever reach the interpolated list.
    const idList = ids.map((v) => {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new Error(`_readCapturesBudgeted: non-integer capture id ${v}`);
      return n;
    }).join(',');
    const batch = await queryFn(
      `SELECT ${columns} FROM captures WHERE id IN (${idList}) ORDER BY ts DESC, id DESC`
    );
    out.push(...batch.rows);
  }
  return out;
}

/**
 * Read captures, newest first.
 *
 * Reads are byte-budgeted internally (ELIFANT_READ_BUDGET_BYTES, default 4 MiB
 * per underlying query): a large result set is fetched in multiple bounded
 * queries and concatenated, so no call can push the storage instance past its
 * WASM memory ceiling no matter how fat the stored events are.
 *
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
  const rows = await _readCapturesBudgeted((sql, p) => _db.query(sql, p), { whereClause, params, limit });
  return rows.map(r => ({
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
  // Prune watermark (H2 forward-merge): ONLY a pure-time prune (until, with no source/type)
  // advances the high-water, so a later forward-merge won't resurrect event-noise the
  // keyholder time-pruned ("absent in live" usually means "pruned on purpose"). A SCOPED
  // prune (until+source/type, or source/type-only) must NOT advance it — doing so would
  // wrongly block UNRELATED sources' captures from being recovered on merge (silent
  // non-restore in the default mode). Scoped-prune captures may resurrect on merge — a
  // documented edge, not a loss path. ISO-8601 stamps compare correctly as TEXT via GREATEST.
  if (until && !source && !type && (result.affectedRows || 0) > 0) {
    await _db.query(`
      INSERT INTO brain_meta (key, value) VALUES ('captures_prune_watermark', $1)
      ON CONFLICT(key) DO UPDATE SET value = GREATEST(brain_meta.value, EXCLUDED.value)
    `, [until]);
  }
  return result.affectedRows || 0;
}

// ── Steering: the manner slot (elifant#11) ────────────────────────────────
//
// Both steering and review_lessons have existed in the schema — created,
// exported, imported, snapshot-merged — with NO accessor on the public
// surface. A consumer had to reach through _internal.query or raw PGlite, and
// review_lessons could not even be seeded. This is that API.
//
// The two tables are deliberately NOT symmetric, because they hold different
// kinds of thing:
//
//   review_lessons  is WHAT SHE KNOWS — 'auto-generated rules from prior
//                   tasks', the learned-from-experience heuristics slot. A
//                   producer may append to it freely; that is what learning
//                   is. Dedup'd by (task_type, rule), matching the forward-
//                   merge's own dedup key.
//
//   steering        is WHO SHE IS — mode / match_pattern / priority / enabled.
//                   A row here changes behaviour, so it may NOT be written
//                   freely. Learning changes what she knows, never who she is.
//
// So steering gets a two-door API and there is no third door:
//
//   proposeSteering()  can never turn a rule ON. It takes no `enabled`
//                      argument; the flag it writes is either literal false or
//                      the flag the row already held under a still-valid grant
//                      (rule 1 below), so no value a caller can pass produces
//                      an active rule. Anything may propose — a shell, the
//                      keyholder, the Mind.
//   grantSteering()    is the ONLY function in this module that writes
//                      enabled=true, and it REQUIRES grantedBy. The enable
//                      and the attribution are set in one UPDATE, so there is
//                      no window — not even a transient one — where a row is
//                      enabled without a recorded grant.
//   revokeSteering()   turns it back off and clears the grant.
//
// A boolean setter would have made the un-granted enabled row merely
// discouraged. Splitting the doors makes it unrepresentable. The storage-layer
// CHECK constraint (see _applySchema) carries the same rule down past the API
// so raw SQL cannot express it either, for any row with declared provenance.
//
// Three further rules, each of which exists because a manner rule is not data:
//
//   1. A grant is bound to the TEXT it was granted over. Re-proposing an entry
//      with different content/mode/match_pattern/priority clears the grant and
//      drops it to disabled — otherwise a caller could swap the body out from
//      under a grant and inherit its authority. An identical re-propose is a
//      no-op for the grant, so an idempotent shell re-seed at every boot does
//      not silently switch the keyholder's rules off.
//   2. A grant is bowl-LOCAL. It is not in the YOINK wire format, and the
//      import paths clear origin/grant on write: a foreign row's text is not
//      the text this keyholder granted.
//   3. Resurrected steering comes back DISABLED (the pre-existing rollback
//      rule, preserved verbatim below in _rollbackForwardMerge) — and now the
//      grant is cleared with it, so "disabled" and "ungranted" cannot drift
//      apart.

/** Where a steering entry came from. Three origins, one vocabulary; a caller
 *  must name one, because an unmarked manner rule is a silent promotion. */
const STEERING_ORIGIN = Object.freeze({
  /** Shipped by the shell/spore that installed this brain. */
  SHELL_SEEDED: 'shell-seeded',
  /** Written by the keyholder, directly. */
  KEYHOLDER: 'keyholder',
  /** Derived from the brain's own experience — a PROPOSAL until granted. */
  LEARNED: 'learned',
});
const STEERING_ORIGINS = new Set(Object.values(STEERING_ORIGIN));

// The steering `mode` vocabulary (schema default 'always'): apply unconditionally,
// apply when match_pattern hits, or apply only when a caller asks by name.
const STEERING_MODES = new Set(['always', 'matched', 'manual']);

// Origin fixes the trust tier — the caller does not get to choose it. A learned
// rule is tier-2-synthesized even after a keyholder grants it: the grant says
// "you may act on this", not "a human wrote it" (K-CARBON-4 — the promotion a
// grant performs is to ENABLED, never to keyholder-direct).
const STEERING_ORIGIN_TIER = {
  'shell-seeded': TRUST_TIER.KEYHOLDER_DIRECT,
  keyholder: TRUST_TIER.KEYHOLDER_DIRECT,
  learned: TRUST_TIER.SYNTHESIZED,
};

// Columns every steering read returns. One list so the shapes never drift.
const STEERING_COLS = 'id, name, content, mode, match_pattern, priority, enabled, layer, origin, granted_by, granted_at, proposal_id, trust_tier, created_at, updated_at, restored_from';

// Grant/revoke receipt into the captures stream, so the ledger of "who turned
// what on, when" is queryable as events and not only as the current row state.
// Best-effort, exactly like _surfaceConflict: the durable record is the row's
// own granted_by/granted_at, so a capture failure must never abort the grant.
async function _steeringReceipt(type, data) {
  try {
    await _db.query("INSERT INTO captures (source, type, ts, data) VALUES ('steering',$1,$2,$3)",
      [type, _ts(), JSON.stringify(data)]);
  } catch (e) { _debug(`[brain] steering ${type} receipt failed: ${e.message}`); }
}

/** One steering entry by id, or null. Tombstoned entries read as absent. */
async function getSteering(id) {
  _ensure();
  const r = await _db.query(`SELECT ${STEERING_COLS} FROM steering WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rows[0] || null;
}

/**
 * List steering entries, highest priority first (then id, so the order is
 * total and stable). Tombstones are excluded.
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] omit for ALL entries; true = only active
 *   rules (what an inject surface wants); false = only proposals/disabled
 *   entries (what a review surface wants).
 * @param {string} [opts.mode]  filter by mode ('always'|'matched'|'manual')
 * @param {string} [opts.layer] filter by layer ('instance'|'pattern')
 * @param {string} [opts.origin] filter by origin (see STEERING_ORIGIN)
 */
async function getAllSteering({ enabled, mode, layer, origin } = {}) {
  _ensure();
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (enabled !== undefined && enabled !== null) { params.push(!!enabled); where.push(`enabled = $${params.length}`); }
  if (mode) { params.push(mode); where.push(`mode = $${params.length}`); }
  if (layer) { params.push(layer); where.push(`layer = $${params.length}`); }
  if (origin) { params.push(origin); where.push(`origin = $${params.length}`); }
  const r = await _db.query(
    `SELECT ${STEERING_COLS} FROM steering WHERE ${where.join(' AND ')} ORDER BY priority DESC, id ASC`, params);
  return r.rows;
}

/**
 * Write a steering entry as a PROPOSAL — always disabled, never active.
 *
 * This function cannot TURN ON a rule. It takes no `enabled` argument; the
 * flag it writes is either literal false or the flag the row already carried
 * under a still-valid grant — never a value derived from anything the caller
 * passed. Enabling is grantSteering()'s job, and grantSteering() requires
 * attribution.
 *
 * Re-proposing an existing entry with any behavioural field changed
 * (content / mode / match_pattern / priority) REVOKES an existing grant — the
 * grant covered the old text. An identical re-propose leaves the grant intact
 * so a shell can re-seed on every boot without disabling the keyholder's rules;
 * the display `name` is a label, not behaviour, so a rename alone is safe.
 *
 * @param {object} entry
 * @param {string} entry.id            stable key (also the sync/merge key)
 * @param {string} entry.name          display label (steering.name is NOT NULL)
 * @param {string} entry.content       the rule text itself
 * @param {'always'|'matched'|'manual'} [entry.mode='always']
 * @param {string|null} [entry.matchPattern=null]
 * @param {number} [entry.priority=0]  higher sorts first
 * @param {'instance'|'pattern'} [entry.layer='instance']
 * @param {string} entry.origin        REQUIRED — see STEERING_ORIGIN
 * @param {string|null} [entry.proposalId=null] the evidence/proposal this came from
 * @returns {Promise<{id:string, enabled:boolean, revoked_grant:boolean}>}
 *   `revoked_grant` is true when this call turned an active rule back into a
 *   proposal — the caller is told, never surprised.
 */
async function proposeSteering(entry = {}) {
  _ensure();
  const { id, name, content, mode = 'always', matchPattern = null, priority = 0, layer = 'instance', origin, proposalId = null } = entry;
  if (typeof id !== 'string' || !id) throw new Error('proposeSteering: id (non-empty string) is required');
  if (typeof name !== 'string' || !name) throw new Error('proposeSteering: name (non-empty string) is required — steering.name is NOT NULL');
  if (typeof content !== 'string' || !content) throw new Error('proposeSteering: content (non-empty string) is required');
  if (!STEERING_ORIGINS.has(origin)) {
    throw new Error(`proposeSteering: origin must be one of ${[...STEERING_ORIGINS].join(' | ')} — a manner rule with no recorded origin is a silent promotion`);
  }
  if (!STEERING_MODES.has(mode)) {
    throw new Error(`proposeSteering: mode must be one of ${[...STEERING_MODES].join(' | ')}`);
  }
  if (!Number.isInteger(priority)) throw new Error('proposeSteering: priority must be an integer');

  // Read the current row (including tombstones — overwriting a tombstone is a
  // resurrection, and a resurrected rule is emphatically not still granted).
  const ex = (await _db.query(
    'SELECT content, mode, match_pattern, priority, enabled, granted_by, granted_at, deleted_at FROM steering WHERE id = $1', [id]
  )).rows[0] || null;
  const live = ex && !ex.deleted_at;
  const behaviourChanged = !live
    || ex.content !== content
    || ex.mode !== mode
    || (ex.match_pattern || null) !== (matchPattern || null)
    || Number(ex.priority || 0) !== Number(priority);
  // A grant can only be carried forward if there IS one. A pre-provenance row
  // (spore-seeded, imported, or older than this migration) can be enabled with
  // no granted_by — and the moment this call stamps an origin on it, the
  // storage floor binds it, so "enabled and ungranted" stops being a state it
  // may occupy. Dropping it to a proposal is the only honest move: we do not
  // know who turned it on, and inventing an answer is the failure this whole
  // API exists to prevent. It is reported (revoked_grant), never silent.
  const grantIntact = !!(live && ex.granted_by && ex.granted_at);
  const keepGrant = live && !behaviourChanged && grantIntact;
  const enabled = keepGrant ? !!ex.enabled : false;
  const grantedBy = keepGrant ? ex.granted_by : null;
  const grantedAt = keepGrant ? ex.granted_at : null;

  const { vv, hash } = await _stampWrite('steering', 'id', id, content);
  const ts = _ts();
  await _db.query(`
    INSERT INTO steering (id, name, content, mode, match_pattern, priority, enabled, layer, origin, granted_by, granted_at, proposal_id, trust_tier, created_at, updated_at, version_vector, content_hash, deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,NULL)
    ON CONFLICT(id) DO UPDATE SET
      name = EXCLUDED.name,
      content = EXCLUDED.content,
      mode = EXCLUDED.mode,
      match_pattern = EXCLUDED.match_pattern,
      priority = EXCLUDED.priority,
      enabled = EXCLUDED.enabled,
      layer = EXCLUDED.layer,
      origin = EXCLUDED.origin,
      granted_by = EXCLUDED.granted_by,
      granted_at = EXCLUDED.granted_at,
      proposal_id = EXCLUDED.proposal_id,
      trust_tier = EXCLUDED.trust_tier,
      updated_at = EXCLUDED.updated_at,
      version_vector = EXCLUDED.version_vector,
      content_hash = EXCLUDED.content_hash,
      deleted_at = NULL
  `, [id, name, content, mode, matchPattern || null, priority, enabled, layer, origin, grantedBy, grantedAt, proposalId, STEERING_ORIGIN_TIER[origin], ts, vv, hash]);

  const revoked = !!(live && ex.enabled && !keepGrant);
  if (revoked) {
    await _steeringReceipt('revoke', {
      id,
      reason: behaviourChanged ? 'content changed under an active grant' : 'active rule had no recorded grant to carry forward',
      prior_granted_by: ex.granted_by || null,
      prior_granted_at: ex.granted_at || null,
    });
  }
  return { id, enabled, revoked_grant: revoked };
}

/**
 * Turn a steering entry ON. The ONLY code path in this module that writes
 * enabled=true — and it cannot run without `grantedBy`.
 *
 * enabled, granted_by and granted_at are written by a SINGLE UPDATE, so the
 * row is never observably enabled-without-a-grant, not even mid-transaction.
 * The storage CHECK constraint refuses the pair coming apart afterwards.
 *
 * @param {string} id
 * @param {object} grant
 * @param {string} grant.grantedBy  REQUIRED — the identity turning it on
 * @param {string|null} [grant.proposalId] the proposal being granted; when
 *   omitted the entry keeps whatever proposal_id it was proposed with
 * @param {string|null} [grant.note] free-text reason, receipted only
 * @throws if grantedBy is missing/blank, or the entry does not exist
 */
async function grantSteering(id, grant = {}) {
  _ensure();
  const { grantedBy, proposalId = null, note = null } = grant;
  if (typeof id !== 'string' || !id) throw new Error('grantSteering: id (non-empty string) is required');
  if (typeof grantedBy !== 'string' || !grantedBy.trim()) {
    throw new Error('grantSteering: grantedBy is required — an enabled steering entry with no recorded grant is exactly what this API exists to make impossible');
  }
  const ex = (await _db.query('SELECT id, content, enabled, origin, version_vector FROM steering WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
  if (!ex) throw new Error(`grantSteering: no steering entry '${id}' — propose it first (a grant cannot conjure the rule it grants)`);

  const at = _ts();
  // A grant changes BEHAVIOUR without changing content, so _stampWrite (which
  // is content-hash-keyed and would decline to bump) is not the right tool: bump
  // the vector directly so another device sees the enable as a causal event
  // rather than as an invisible no-op.
  const vv = _vvStringify(_vvBump(ex.version_vector, await _localDeviceId()));
  await _db.query(
    `UPDATE steering SET enabled = true, granted_by = $1, granted_at = $2,
       proposal_id = COALESCE($3, proposal_id), updated_at = $2, version_vector = $4
     WHERE id = $5`,
    [grantedBy, at, proposalId, vv, id]);
  await _steeringReceipt('grant', { id, granted_by: grantedBy, granted_at: at, origin: ex.origin || null, proposal_id: proposalId, note });
  return { id, enabled: true, granted_by: grantedBy, granted_at: at };
}

/**
 * Turn a steering entry OFF and clear its grant. Idempotent: a missing,
 * tombstoned, or already-disabled-and-ungranted entry is a no-op reporting
 * `changed:false`. Revocation is the SAFE direction, so `revokedBy` is
 * recorded when given but never required — nothing should stand between a
 * keyholder and switching a behaviour off.
 */
async function revokeSteering(id, { revokedBy = null, note = null } = {}) {
  _ensure();
  if (typeof id !== 'string' || !id) throw new Error('revokeSteering: id (non-empty string) is required');
  const ex = (await _db.query('SELECT id, enabled, granted_by, granted_at, version_vector FROM steering WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
  if (!ex) return { id, enabled: false, changed: false };
  if (!ex.enabled && !ex.granted_by && !ex.granted_at) return { id, enabled: false, changed: false };
  const vv = _vvStringify(_vvBump(ex.version_vector, await _localDeviceId()));
  await _db.query(
    'UPDATE steering SET enabled = false, granted_by = NULL, granted_at = NULL, updated_at = $1, version_vector = $2 WHERE id = $3',
    [_ts(), vv, id]);
  await _steeringReceipt('revoke', { id, reason: 'revoked', revoked_by: revokedBy, prior_granted_by: ex.granted_by || null, prior_granted_at: ex.granted_at || null, note });
  return { id, enabled: false, changed: true };
}

/**
 * Soft-delete a steering entry: a tombstone (deleted_at + version-vector bump),
 * exactly like deleteState/deleteMemory, so the delete propagates on sync
 * instead of being resurrected by a stale present-row. Filtered from every
 * read above. No-op if absent or already a tombstone.
 *
 * KNOWN GAP (not this issue's): pruneTombstones() reaps memories + state only,
 * so a steering tombstone is never garbage-collected. Harmless (one dead row)
 * but asymmetric.
 */
async function deleteSteering(id) {
  _ensure();
  const ex = await _db.query('SELECT version_vector, deleted_at FROM steering WHERE id = $1', [id]);
  if (!ex.rows[0] || ex.rows[0].deleted_at) return;
  const vv = _vvStringify(_vvBump(ex.rows[0].version_vector, await _localDeviceId()));
  // Clear the grant on the way down: a tombstoned rule must not be resurrectable
  // straight back into an ENABLED state by any path that only clears deleted_at.
  await _db.query('UPDATE steering SET deleted_at = $1, version_vector = $2, enabled = false, granted_by = NULL, granted_at = NULL WHERE id = $3',
    [_ts(), vv, id]);
}

// ── Review lessons: the learned-heuristics slot (elifant#11) ──────────────
//
// 'auto-generated rules from prior tasks' — the schema slot for what she has
// learned from experience. Unlike steering, this needs no grant: it records
// what she KNOWS, and knowing is not behaving. A consumer that wants a lesson
// to change behaviour must take it through proposeSteering + a keyholder
// grant, which is exactly the line elifant#14 draws.

/**
 * Append a learned lesson. Dedup'd on (task_type, rule) — the same key the
 * forward-merge already dedups by, and the reason review_lessons_dedup_idx
 * exists — so a producer re-deriving the same rule every pass does not grow
 * the table without bound. Returns the existing row with `deduped:true` in
 * that case, mirroring addCapture's shape.
 *
 * @param {object} lesson
 * @param {string} lesson.taskType   what kind of task this was learned from
 * @param {string} lesson.rule       the heuristic itself
 * @param {number|null} [lesson.sourceItemId] the item it was derived from
 * @param {'instance'|'pattern'} [lesson.layer='instance']
 */
async function addReviewLesson(lesson = {}) {
  _ensure();
  const { taskType, rule, sourceItemId = null, layer = 'instance' } = lesson;
  if (typeof taskType !== 'string' || !taskType) throw new Error('addReviewLesson: taskType (non-empty string) is required');
  if (typeof rule !== 'string' || !rule) throw new Error('addReviewLesson: rule (non-empty string) is required');
  if (sourceItemId !== null && sourceItemId !== undefined && !Number.isInteger(sourceItemId)) {
    throw new Error('addReviewLesson: sourceItemId must be an integer or null (the column is INTEGER)');
  }
  const ex = (await _db.query('SELECT id FROM review_lessons WHERE task_type = $1 AND rule = $2 ORDER BY id LIMIT 1', [taskType, rule])).rows[0];
  if (ex) return { id: Number(ex.id), deduped: true };
  const r = await _db.query(
    'INSERT INTO review_lessons (task_type, rule, source_item_id, layer, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [taskType, rule, sourceItemId == null ? null : sourceItemId, layer, _ts()]);
  return { id: Number(r.rows[0].id) };
}

/**
 * Read learned lessons, newest first ("what have I learned lately" is the
 * question this table gets asked). Filter by taskType to get the heuristics
 * for one kind of work. `limit` defaults to 1000 and is capped at 10000 —
 * bounded reads only (armor invariant 1).
 */
async function getReviewLessons({ taskType = null, limit = 1000 } = {}) {
  _ensure();
  const n = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
  const params = [];
  let where = '';
  if (taskType) { params.push(taskType); where = 'WHERE task_type = $1'; }
  params.push(n);
  const r = await _db.query(
    `SELECT id, task_type, rule, source_item_id, layer, created_at, restored_from
     FROM review_lessons ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  return r.rows;
}

/**
 * Delete one learned lesson by id. A hard delete, not a tombstone: this table
 * is deliberately outside the version-vector machinery (append-and-dedup by
 * (task_type, rule), see the 0.19.0 migration note), so there is nothing for a
 * tombstone to dominate. Returns true if a row was removed.
 */
async function deleteReviewLesson(id) {
  _ensure();
  if (!Number.isInteger(id)) throw new Error('deleteReviewLesson: id must be an integer');
  const r = await _db.query('DELETE FROM review_lessons WHERE id = $1 RETURNING id', [id]);
  return r.rows.length > 0;
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
    // Spore rows land enabled with NO origin, exactly as they always have.
    // elifant#15's decision (see _applySchema's grant-floor comment): this
    // stays as-is, on purpose. It is NOT the import gap #15 closed — a spore
    // is the shell's OWN default persona, installed at birth, not a foreign
    // keyholder's steering arriving over YOINK/SUMMON — and retrofitting a
    // grant here would mean inventing one (K-CARBON-4), while force-disabling
    // it would silently take away behaviour every existing shell ships with,
    // which is itself the unrequested-personality-change failure this issue
    // exists to prevent. It stays under the grandfather clause permanently,
    // not provisionally. New code should prefer proposeSteering() + grantSteering().
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

// ── crypto-04: signing key encryption at rest ──────────────────────────────
//
// When a keyholder passphrase is configured, the Ed25519 private PEM is sealed
// with AES-256-GCM under a KEK derived from the passphrase via PBKDF2-600k-SHA256
// (the scheme the elifantic spec prescribes; same params as the ecosystem vault).
// Only the sealed blob + salt/iv/tag are persisted — the plaintext PEM never
// touches disk. Wrong passphrase fails the GCM auth tag and is rejected loudly.
//
// THREAT MODEL: this provides CONFIDENTIALITY of the signing key at rest against a
// read-only disk attacker (the crypto-04 finding). It does NOT by itself provide
// integrity of WHICH key the bowl uses: an attacker with brain_meta WRITE access
// could swap in their own key. _getSigningKey re-derives the public key from the
// recovered private key and rejects a private/public mismatch (catches corruption
// and a private-key-only swap), but a full-record swap or a replay of an older
// sealed record under the same passphrase is a signing-key rollback that this
// layer does not detect — that needs an external/monotonic anchor and is out of
// scope for at-rest confidentiality.
const _KEK_ITER = 600000; // OWASP PBKDF2-SHA256 floor; must match unwrap
const _KEK_HASH = 'sha256';
const _KEK_LEN = 32; // AES-256
const _KEK_SALT_LEN = 16;
const _KEK_IV_LEN = 12; // AES-GCM

function _deriveKek(passphrase, salt) {
  return crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, _KEK_ITER, _KEK_LEN, _KEK_HASH);
}

// Seal a private PEM string. Returns a self-describing JSON-able envelope.
function _sealPrivatePem(pem, passphrase) {
  const salt = crypto.randomBytes(_KEK_SALT_LEN);
  const iv = crypto.randomBytes(_KEK_IV_LEN);
  const kek = _deriveKek(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2',
    hash: _KEK_HASH,
    iter: _KEK_ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// Recover a private PEM from a sealed envelope. Throws a clear error on a wrong
// passphrase (GCM auth-tag mismatch) or a malformed/unknown envelope — never
// returns garbage. The crypto params are FIXED here, deliberately NOT read from
// the envelope's kdf/hash/iter/alg fields: honoring attacker-supplied params
// would let a local writer downgrade (iter:1, aes-128) the record. Those fields
// are descriptive metadata only; we fail closed on anything but the one shape we
// wrote.
function _openPrivatePem(enc, passphrase) {
  if (!passphrase) {
    throw new Error('signing key is encrypted at rest but no keyPassphrase is configured — pass it to init() or set ELIFANT_KEY_PASSPHRASE');
  }
  if (!enc || enc.v !== 1 || enc.alg !== 'aes-256-gcm') {
    throw new Error('signing key envelope has an unsupported version or algorithm — refusing to open');
  }
  try {
    const salt = Buffer.from(enc.salt, 'base64');
    const iv = Buffer.from(enc.iv, 'base64');
    const tag = Buffer.from(enc.tag, 'base64');
    const ct = Buffer.from(enc.ct, 'base64');
    const kek = _deriveKek(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('signing key decryption failed — wrong keyPassphrase or corrupted key material');
  }
}

/**
 * Get or lazily-generate the bowl's Ed25519 signing keypair. Used to sign
 * soul-manifest.json on YOINK (export) and verify on SUMMON (import) per
 * elifantic-soul-v0.2. The private key persists in brain_meta; the public key
 * is embedded in every exported manifest for receivers to verify against.
 *
 * At rest the private key is either PLAINTEXT PEM (legacy — no keyPassphrase) or
 * an AES-256-GCM sealed envelope (crypto-04 — keyPassphrase configured). If a
 * passphrase is configured and a legacy plaintext key is found, it is migrated
 * to sealed on first use. The unwrapped key is cached for the session.
 *
 * Returns { privateKey, publicKeyB64 } where privateKey is a node KeyObject
 * suitable for crypto.sign, and publicKeyB64 is the base64-encoded raw
 * public key bytes (suitable for embedding in soul-manifest.json).
 */
async function _getSigningKey() {
  if (_signingKeyCache) return _signingKeyCache;

  let r = await _db.query("SELECT value FROM brain_meta WHERE key = 'signing_keypair_v1'");
  let stored = r.rows[0] && r.rows[0].value;
  if (!stored) {
    // First-run generation. Ed25519 keys are 32 bytes raw; node emits PEM/DER. We
    // store a JSON blob with a base64 raw public key + either a sealed envelope
    // (crypto-04, keyPassphrase set) or a plaintext PEM (legacy). Shared record
    // builder keeps this identical to the fork path.
    stored = JSON.stringify(_newSigningKeypairRecord());
    await _db.query(
      "INSERT INTO brain_meta (key, value) VALUES ('signing_keypair_v1', $1) ON CONFLICT(key) DO NOTHING",
      [stored]
    );
    r = await _db.query("SELECT value FROM brain_meta WHERE key = 'signing_keypair_v1'");
    stored = r.rows[0].value;
  }

  const parsed = JSON.parse(stored);
  let pem;
  if (parsed.enc) {
    // Sealed at rest — recover under the configured passphrase.
    pem = _openPrivatePem(parsed.enc, _keyPassphrase);
  } else {
    // Legacy plaintext key.
    pem = parsed.private_pem;
    // Opportunistic migration: a passphrase is now configured, so seal the
    // plaintext key in place (drop private_pem). Guarded so a concurrent writer
    // that already sealed it isn't clobbered.
    //
    // HONEST LIMITATION: this seals the ACTIVE key so no future write persists it
    // in clear, but the key was ALREADY on disk in plaintext (heap, WAL, prior
    // snapshots/backups). The in-place UPDATE leaves an MVCC dead tuple; we
    // VACUUM FULL to drop the live dead copy as best-effort, but WAL segments and
    // any existing backups may still hold the old plaintext until natural churn.
    // A keyholder wanting a hard guarantee should start a fresh brain born with a
    // passphrase (never writes the key in clear) — see signingKeyProtection() and
    // the crypto-04 note. Airtight zero-plaintext is the born-sealed path.
    if (_keyPassphrase) {
      const sealedRecord = {
        algorithm: parsed.algorithm,
        public_b64: parsed.public_b64,
        created_at: parsed.created_at,
        enc: _sealPrivatePem(pem, _keyPassphrase),
        migrated_at: new Date().toISOString(),
      };
      await _db.query(
        "UPDATE brain_meta SET value = $1 WHERE key = 'signing_keypair_v1' AND value = $2",
        [JSON.stringify(sealedRecord), stored]
      );
      // Best-effort scrub of the plaintext dead tuple from the live heap.
      try { await _db.exec('VACUUM FULL brain_meta'); } catch { /* best-effort */ }
    }
  }

  const privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
  // Integrity binding: the recovered private key MUST match the advertised public
  // key. GCM gives confidentiality but the envelope isn't cryptographically tied to
  // the cleartext public_b64, so a swap/corruption/migration-bug could leave the
  // bowl signing with one key while advertising another → silently unverifiable
  // exports (self-DoS). Re-derive and compare; fail loud on any drift.
  const derivedPub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const derivedPubB64 = derivedPub.subarray(derivedPub.length - 32).toString('base64');
  if (derivedPubB64 !== parsed.public_b64) {
    throw new Error('signing key integrity check failed — the stored private key does not match its advertised public key (corruption or tampering)');
  }
  _signingKeyCache = { privateKey, publicKeyB64: parsed.public_b64 };
  return _signingKeyCache;
}

/**
 * Report how the signing private key is protected at rest, without touching key
 * material. Returns 'encrypted' (AES-256-GCM sealed), 'plaintext' (legacy PEM on
 * disk), or 'none' (no signing key generated yet). Powers HEALTH + lets a
 * keyholder confirm crypto-04 is in force.
 */
async function signingKeyProtection() {
  _ensure();
  const r = await _db.query("SELECT value FROM brain_meta WHERE key = 'signing_keypair_v1'");
  if (!r.rows[0]) return 'none';
  const parsed = JSON.parse(r.rows[0].value);
  // A plaintext PEM present at all means the key is exposed at rest, even if a
  // sealed envelope also sits alongside — report 'plaintext' (defense in depth;
  // no current path writes both, but never let a stray plaintext read 'encrypted').
  if (parsed.private_pem) return 'plaintext';
  return parsed.enc ? 'encrypted' : 'none';
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
        sql = 'SELECT key, value, updated_by, updated_at, layer, anonymizable, trust_tier, version_vector, content_hash, deleted_at FROM state ORDER BY key';
        break;
      case 'memories':
        sql = 'SELECT filename, content, updated_by, updated_at, layer, anonymizable, trust_tier, version_vector, content_hash, deleted_at FROM memories ORDER BY filename';
        break;
      case 'steering':
        sql = 'SELECT id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier, version_vector, content_hash, deleted_at FROM steering ORDER BY id';
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
 * @param {'skip'|'overwrite'|'newer-wins'|'merge'} [input.conflict='newer-wins']
 *   skip/overwrite/newer-wins are the one-shot YOINK policies (wall-clock).
 *   'merge' is the causal multi-device sync policy: per-row version-vector
 *   domination → fast-forward; concurrent divergence → deterministic winner +
 *   the loser preserved as a `<key>.conflict-<hash>` copy + a surfaced capture
 *   (never a silent clobber); tombstones propagate (a delete dominates a stale
 *   present-row); a delete-vs-edit keeps the edit. Returns `conflict_copies`.
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
  if (!['skip', 'overwrite', 'newer-wins', 'merge'].includes(conflict)) {
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
  let conflictCopies = 0; // merge policy: concurrent-edit losers preserved as copies

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
      if (conflict === 'merge') {
        // Full column set: when this local row LOSES an edit-vs-edit conflict it is
        // re-written as a conflict-copy via _mergeWriteState(ex, ...), which needs
        // every column it persists. A narrow SELECT silently drops the keyholder's
        // layer/updated_by/trust_tier on the copy (and for steering, name is NOT NULL
        // → the whole import aborts). See the merge-conflict tests.
        const ex = (await _db.query('SELECT key, value, updated_by, updated_at, layer, anonymizable, trust_tier, version_vector, content_hash, deleted_at FROM state WHERE key = $1', [row.key])).rows[0] || null;
        const d = _mergeDecision(ex, row);
        if (d.action === 'skip') { skipped++; continue; }
        if (d.action === 'ff') { await _db.query('UPDATE state SET version_vector=$1 WHERE key=$2', [d.vv, row.key]); imported.state++; continue; }
        if (d.action === 'take') { await _mergeWriteState(row, { tierPolicy }); imported.state++; continue; }
        // conflict: the winning edit holds the key with the joined vector; the loser is
        // preserved (edit-vs-edit) and the conflict is surfaced — never a silent clobber.
        if (d.winnerIsIncoming) await _mergeWriteState(row, { tierPolicy, vv: d.vv, deleted: null });
        else await _db.query('UPDATE state SET version_vector=$1, deleted_at=NULL WHERE key=$2', [d.vv, row.key]);
        let copyKey = null;
        if (d.kind === 'edit-vs-edit') {
          const loser = d.winnerIsIncoming ? ex : row;
          copyKey = `${row.key}.conflict-${_conflictSuffix(loser.content_hash || _sha256(loser.value))}`;
          await _mergeWriteState(loser, { tierPolicy, keyOverride: copyKey, vv: loser.version_vector || '{}', deleted: null });
          conflictCopies++;
        }
        conflicts++;
        await _surfaceConflict({ table: 'state', key: row.key, kind: d.kind, winner: d.winnerIsIncoming ? 'incoming' : 'local', conflict_copy: copyKey });
        imported.state++;
        continue;
      }
      const existing = await _db.query('SELECT updated_at FROM state WHERE key = $1', [row.key]);
      if (existing.rows[0]) {
        conflicts++;
        if (conflict === 'skip') { skipped++; continue; }
        if (conflict === 'newer-wins' && existing.rows[0].updated_at >= row.updated_at) { skipped++; continue; }
      }
      await _db.query(`
        INSERT INTO state (key, value, updated_by, updated_at, layer, anonymizable, trust_tier, version_vector, content_hash, deleted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT(key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at,
          layer = EXCLUDED.layer,
          anonymizable = EXCLUDED.anonymizable,
          trust_tier = EXCLUDED.trust_tier,
          version_vector = EXCLUDED.version_vector,
          content_hash = EXCLUDED.content_hash,
          deleted_at = EXCLUDED.deleted_at
      `, [row.key, row.value, row.updated_by || 'import', row.updated_at || _ts(), row.layer || 'instance', row.anonymizable !== false, _resolveImportTier(row.trust_tier, tierPolicy), row.version_vector || '{}', row.content_hash || _sha256(row.value), row.deleted_at || null]);
      imported.state++;
    }
  }

  // ── memories ─────────────────────────────────────────────────────────
  if (byName['memories.jsonl']) {
    const rows = _parseJsonl(byName['memories.jsonl']);
    for (const row of rows) {
      if (!_layerOk(row, layerFilter)) { skipped++; continue; }
      if (conflict === 'merge') {
        // Full column set (see the state merge note): a local-loser conflict-copy
        // must preserve layer/updated_by/trust_tier/anonymizable.
        const ex = (await _db.query('SELECT filename, content, updated_by, updated_at, layer, anonymizable, trust_tier, version_vector, content_hash, deleted_at FROM memories WHERE filename = $1', [row.filename])).rows[0] || null;
        const d = _mergeDecision(ex, row);
        if (d.action === 'skip') { skipped++; continue; }
        if (d.action === 'ff') { await _db.query('UPDATE memories SET version_vector=$1 WHERE filename=$2', [d.vv, row.filename]); imported.memories++; continue; }
        if (d.action === 'take') { await _mergeWriteMemory(row, { tierPolicy }); imported.memories++; continue; }
        if (d.winnerIsIncoming) await _mergeWriteMemory(row, { tierPolicy, vv: d.vv, deleted: null });
        else await _db.query('UPDATE memories SET version_vector=$1, deleted_at=NULL WHERE filename=$2', [d.vv, row.filename]);
        let copyKey = null;
        if (d.kind === 'edit-vs-edit') {
          const loser = d.winnerIsIncoming ? ex : row;
          copyKey = `${row.filename}.conflict-${_conflictSuffix(loser.content_hash || _sha256(loser.content))}`;
          await _mergeWriteMemory(loser, { tierPolicy, keyOverride: copyKey, vv: loser.version_vector || '{}', deleted: null });
          conflictCopies++;
        }
        conflicts++;
        await _surfaceConflict({ table: 'memories', key: row.filename, kind: d.kind, winner: d.winnerIsIncoming ? 'incoming' : 'local', conflict_copy: copyKey });
        imported.memories++;
        continue;
      }
      const existing = await _db.query('SELECT updated_at FROM memories WHERE filename = $1', [row.filename]);
      if (existing.rows[0]) {
        conflicts++;
        if (conflict === 'skip') { skipped++; continue; }
        if (conflict === 'newer-wins' && existing.rows[0].updated_at >= row.updated_at) { skipped++; continue; }
      }
      await _db.query(`
        INSERT INTO memories (filename, content, updated_by, updated_at, layer, anonymizable, trust_tier, version_vector, content_hash, deleted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT(filename) DO UPDATE SET
          content = EXCLUDED.content,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at,
          layer = EXCLUDED.layer,
          anonymizable = EXCLUDED.anonymizable,
          trust_tier = EXCLUDED.trust_tier,
          version_vector = EXCLUDED.version_vector,
          content_hash = EXCLUDED.content_hash,
          deleted_at = EXCLUDED.deleted_at
      `, [row.filename, row.content, row.updated_by || 'import', row.updated_at || _ts(), row.layer || 'instance', row.anonymizable !== false, _resolveImportTier(row.trust_tier, tierPolicy), row.version_vector || '{}', row.content_hash || _sha256(row.content), row.deleted_at || null]);
      imported.memories++;
    }
  }

  // ── steering ─────────────────────────────────────────────────────────
  if (byName['steering.jsonl']) {
    const rows = _parseJsonl(byName['steering.jsonl']);
    for (const row of rows) {
      if (!_layerOk(row, layerFilter)) { skipped++; continue; }
      if (conflict === 'merge') {
        // Full column set (see the state merge note). CRITICAL: steering.name is
        // NOT NULL, so a narrow SELECT here made a local-loser conflict-copy insert
        // name=NULL → constraint violation → the ENTIRE merge import rolled back.
        const ex = (await _db.query('SELECT id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier, version_vector, content_hash, deleted_at FROM steering WHERE id = $1', [row.id])).rows[0] || null;
        const d = _mergeDecision(ex, row);
        if (d.action === 'skip') { skipped++; continue; }
        if (d.action === 'ff') { await _db.query('UPDATE steering SET version_vector=$1 WHERE id=$2', [d.vv, row.id]); imported.steering++; continue; }
        if (d.action === 'take') { await _mergeWriteSteering(row, { tierPolicy }); imported.steering++; continue; }
        if (d.winnerIsIncoming) await _mergeWriteSteering(row, { tierPolicy, vv: d.vv, deleted: null });
        else await _db.query('UPDATE steering SET version_vector=$1, deleted_at=NULL WHERE id=$2', [d.vv, row.id]);
        let copyKey = null;
        if (d.kind === 'edit-vs-edit') {
          const loser = d.winnerIsIncoming ? ex : row;
          copyKey = `${row.id}.conflict-${_conflictSuffix(loser.content_hash || _sha256(loser.content))}`;
          await _mergeWriteSteering(loser, { tierPolicy, keyOverride: copyKey, vv: loser.version_vector || '{}', deleted: null });
          conflictCopies++;
        }
        conflicts++;
        await _surfaceConflict({ table: 'steering', key: row.id, kind: d.kind, winner: d.winnerIsIncoming ? 'incoming' : 'local', conflict_copy: copyKey });
        imported.steering++;
        continue;
      }
      const existing = await _db.query('SELECT updated_at FROM steering WHERE id = $1', [row.id]);
      if (existing.rows[0]) {
        conflicts++;
        if (conflict === 'skip') { skipped++; continue; }
        if (conflict === 'newer-wins' && existing.rows[0].updated_at >= row.updated_at) { skipped++; continue; }
      }
      // origin/granted_by/granted_at/proposal_id are written NULL, on insert AND
      // on conflict (elifant#11). A grant is a LOCAL act by the LOCAL keyholder
      // over LOCAL text: once a foreign row replaces the text, any local grant
      // described something that no longer exists, so carrying it forward would
      // be a lie and re-deriving one would be a forgery.
      // enabled is forced false, ALWAYS, regardless of what the foreign row
      // carried (elifant#15 — closing the gap #11 flagged and left open). This
      // answers #11's open policy question ("may a foreign soul's steering be
      // enabled at all?") with no: import lands exactly where resurrection
      // already lands (see _rollbackForwardMerge below) — disabled, because a
      // manner rule steers behaviour and a peer's SUMMON is not a keyholder
      // grant over THIS bowl's local text. A keyholder who wants a peer's rule
      // active reviews it via getAllSteering({enabled:false}) and grants it
      // explicitly, same as any other proposal.
      await _db.query(`
        INSERT INTO steering (id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier, version_vector, content_hash, deleted_at, origin, granted_by, granted_at, proposal_id)
        VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11, $12, $13, NULL, NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          content = EXCLUDED.content,
          mode = EXCLUDED.mode,
          match_pattern = EXCLUDED.match_pattern,
          priority = EXCLUDED.priority,
          enabled = false,
          layer = EXCLUDED.layer,
          updated_at = EXCLUDED.updated_at,
          trust_tier = EXCLUDED.trust_tier,
          version_vector = EXCLUDED.version_vector,
          content_hash = EXCLUDED.content_hash,
          deleted_at = EXCLUDED.deleted_at,
          origin = NULL,
          granted_by = NULL,
          granted_at = NULL,
          proposal_id = NULL
      `, [row.id, row.name, row.content, row.mode || 'always', row.match_pattern || null, row.priority || 0, row.layer || 'instance', row.created_at || _ts(), row.updated_at || _ts(), _resolveImportTier(row.trust_tier, tierPolicy), row.version_vector || '{}', row.content_hash || _sha256(row.content), row.deleted_at || null]);
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
  return { imported, skipped, conflicts, conflict_copies: conflictCopies, manifest, signature_status: signatureStatus, sender_trust: senderTrust };
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
// Snapshots carry the same at-rest posture as the live brain/ store — a snapshot is
// a dumpDataDir of it. crypto-04: when a keyPassphrase is configured the signing
// private key is AES-256-GCM sealed (PBKDF2-600k KEK), so neither the live store nor
// any snapshot tarball holds it in clear; without a passphrase it stays plaintext PEM
// (legacy). All OTHER brain data (memories/state/steering/captures) is plaintext in a
// snapshot regardless — full at-rest data encryption is a separate tracked follow-on.

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

// ── Version vectors (continuity fix — causal merge) ─────────────────────────
//
// A per-row version vector is a map {device_id: counter} recording how many edits
// each device has contributed to THAT row's history (device_id = the writing
// bowl's substrate_identity). It replaces the wall-clock `updated_at >=` arbiter,
// which silently loses concurrent edits and lets a future-stamped row clobber
// everything. Comparison is CAUSAL, not chronological:
//   - 'a-dominates'  → a's history already includes all of b's (a is strictly ahead)
//   - 'b-dominates'  → vice versa  → fast-forward to b
//   - 'equal'        → identical history (same lineage; content should match)
//   - 'concurrent'   → each side has edits the other never saw → a real conflict
// Per-row vectors suffice because a memory is a whole-blob replace — no need for a
// character-level CRDT. An empty vector ('{}', the backfill default) is the
// earliest possible lineage, so any stamped edit dominates a legacy row.

function _vvParse(s) {
  if (s == null || s === '') return {};
  const raw = typeof s === 'object' ? s : (() => { try { return JSON.parse(s); } catch { return null; } })();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  // Coerce to a clean {non-empty-string: positive-int} map; drop garbage entries
  // so a malformed/hostile vector can't poison comparison with NaN or fractions.
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Math.floor(Number(v));
    if (typeof k === 'string' && k && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

// Deterministic serialization (sorted keys) so the same vector is byte-identical
// across devices — it rides inside the hashed/signed payload, so stability matters.
function _vvStringify(vv) {
  const clean = _vvParse(vv);
  const out = {};
  for (const k of Object.keys(clean).sort()) out[k] = clean[k];
  return JSON.stringify(out);
}

// Record one new local edit: bump this device's counter by 1. Never bumps under a
// missing identity (would create an unattributable, non-converging entry).
function _vvBump(vv, deviceId) {
  const next = _vvParse(vv);
  if (!deviceId) return next;
  next[deviceId] = (next[deviceId] || 0) + 1;
  return next;
}

// Element-wise max — the join of two histories. Used on fast-forward so the
// surviving row records that it has now "seen" the lineage it superseded.
function _vvMerge(a, b) {
  const x = _vvParse(a), y = _vvParse(b), out = { ...x };
  for (const [k, v] of Object.entries(y)) out[k] = Math.max(out[k] || 0, v);
  return out;
}

// 'a-dominates' | 'b-dominates' | 'equal' | 'concurrent'
function _vvCompare(a, b) {
  const x = _vvParse(a), y = _vvParse(b);
  let aGreater = false, bGreater = false;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const av = x[k] || 0, bv = y[k] || 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
    if (aGreater && bGreater) return 'concurrent'; // short-circuit: both ahead somewhere
  }
  if (aGreater) return 'a-dominates';
  if (bGreater) return 'b-dominates';
  return 'equal';
}

// Short deterministic suffix for a conflict-copy key — derived from the LOSER's
// content hash so every device names the copy identically and converges (a local
// sequence number would diverge across devices).
function _conflictSuffix(contentHash) {
  const h = (typeof contentHash === 'string' && contentHash) ? contentHash : _sha256('');
  return h.replace(/^sha256:/, '').slice(0, 8);
}

// Decide how an incoming synced row reconciles against the local row under the
// causal `merge` policy. Pure (no DB). localRow may be null (never seen).
//   {action:'take'}     — incoming dominates, or local absent → write incoming
//   {action:'skip'}     — local dominates, or identical lineage → keep local
//   {action:'ff', vv}   — concurrent but identical outcome → just join the vectors
//   {action:'conflict', winnerIsIncoming, vv, kind} — concurrent + divergent
function _mergeDecision(localRow, incoming) {
  if (!localRow) return { action: 'take' };
  const inVV = incoming.version_vector || '{}';
  const exVV = localRow.version_vector || '{}';
  const cmp = _vvCompare(inVV, exVV);
  if (cmp === 'equal') return { action: 'skip' };
  if (cmp === 'a-dominates') return { action: 'take' };   // incoming ahead → fast-forward
  if (cmp === 'b-dominates') return { action: 'skip' };   // local ahead → keep local
  // ── concurrent: neither lineage contains the other → a genuine divergence ──
  const vv = _vvStringify(_vvMerge(exVV, inVV));           // join so the survivor dominates both
  const inDel = !!incoming.deleted_at, exDel = !!localRow.deleted_at;
  const inHash = incoming.content_hash || null, exHash = localRow.content_hash || null;
  // Same outcome reached independently (same content AND same liveness) → not a real
  // conflict; collapse to the joined vector and keep what's there.
  if (inDel === exDel && inHash && exHash && inHash === exHash) return { action: 'ff', vv };
  // delete-vs-edit: the EDIT always wins (never silently lose content to a delete);
  // the delete is surfaced, not obeyed. winnerIsIncoming = whichever side is the edit.
  if (inDel !== exDel) return { action: 'conflict', winnerIsIncoming: !inDel, vv, kind: 'delete-vs-edit' };
  // edit-vs-edit divergent: deterministic winner by greater content_hash (tiebreak the
  // serialized vector) so both devices pick the SAME winner + name the SAME copy.
  const winnerIsIncoming = (inHash || '') > (exHash || '') || ((inHash || '') === (exHash || '') && inVV > exVV);
  return { action: 'conflict', winnerIsIncoming, vv, kind: 'edit-vs-edit' };
}

// Surface a merge conflict into the captures event stream (visible to HEALTH and any
// consumer) — never silently. Best-effort: a capture failure must not abort the merge.
async function _surfaceConflict(detail) {
  try {
    await _db.query("INSERT INTO captures (source, type, ts, data) VALUES ('sync-merge','conflict',$1,$2)",
      [_ts(), JSON.stringify(detail)]);
  } catch (e) { _debug(`[brain] surface conflict capture failed: ${e.message}`); }
}

// Merge-path row writers (causal `merge` policy only). Each writes a normalized
// incoming/loser row carrying the continuity columns. `vv`/`deleted` override the
// row's own values (for fast-forward winners + conflict copies); content_hash
// defaults to the row's hash or a fresh digest. memories null the embedding so a
// content change lands in the re-embed queue (never a stale Scent).
async function _mergeWriteState(r, { tierPolicy, keyOverride, vv, deleted } = {}) {
  await _db.query(`INSERT INTO state (key,value,updated_by,updated_at,layer,anonymizable,trust_tier,version_vector,content_hash,deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at,layer=EXCLUDED.layer,anonymizable=EXCLUDED.anonymizable,trust_tier=EXCLUDED.trust_tier,version_vector=EXCLUDED.version_vector,content_hash=EXCLUDED.content_hash,deleted_at=EXCLUDED.deleted_at`,
    [keyOverride || r.key, r.value, r.updated_by || 'import', r.updated_at || _ts(), r.layer || 'instance', r.anonymizable !== false, _resolveImportTier(r.trust_tier, tierPolicy),
     vv !== undefined ? vv : (r.version_vector || '{}'), r.content_hash || _sha256(r.value), deleted !== undefined ? deleted : (r.deleted_at || null)]);
}
async function _mergeWriteMemory(r, { tierPolicy, keyOverride, vv, deleted } = {}) {
  await _db.query(`INSERT INTO memories (filename,content,updated_by,updated_at,layer,anonymizable,trust_tier,version_vector,content_hash,deleted_at,embedding)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)
    ON CONFLICT(filename) DO UPDATE SET content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at,layer=EXCLUDED.layer,anonymizable=EXCLUDED.anonymizable,trust_tier=EXCLUDED.trust_tier,version_vector=EXCLUDED.version_vector,content_hash=EXCLUDED.content_hash,deleted_at=EXCLUDED.deleted_at,embedding=NULL`,
    [keyOverride || r.filename, r.content, r.updated_by || 'import', r.updated_at || _ts(), r.layer || 'instance', r.anonymizable !== false, _resolveImportTier(r.trust_tier, tierPolicy),
     vv !== undefined ? vv : (r.version_vector || '{}'), r.content_hash || _sha256(r.content), deleted !== undefined ? deleted : (r.deleted_at || null)]);
}
// Same origin/grant-clearing rule as importBrain's one-shot steering path
// (elifant#11): a merged-in row's text is not the text this keyholder granted,
// so the local provenance + grant are cleared rather than inherited. And the
// same elifant#15 closure as that path: enabled is forced false regardless of
// what the incoming/losing row carried — a foreign soul's steering never
// lands active through ANY import branch, conflict-policy included.
async function _mergeWriteSteering(r, { tierPolicy, keyOverride, vv, deleted } = {}) {
  await _db.query(`INSERT INTO steering (id,name,content,mode,match_pattern,priority,enabled,layer,created_at,updated_at,trust_tier,version_vector,content_hash,deleted_at,origin,granted_by,granted_at,proposal_id)
    VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,NULL,NULL,NULL,NULL)
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,content=EXCLUDED.content,mode=EXCLUDED.mode,match_pattern=EXCLUDED.match_pattern,priority=EXCLUDED.priority,enabled=false,layer=EXCLUDED.layer,updated_at=EXCLUDED.updated_at,trust_tier=EXCLUDED.trust_tier,version_vector=EXCLUDED.version_vector,content_hash=EXCLUDED.content_hash,deleted_at=EXCLUDED.deleted_at,origin=NULL,granted_by=NULL,granted_at=NULL,proposal_id=NULL`,
    [keyOverride || r.id, r.name, r.content, r.mode || 'always', r.match_pattern || null, r.priority || 0, r.layer || 'instance', r.created_at || _ts(), r.updated_at || _ts(), _resolveImportTier(r.trust_tier, tierPolicy),
     vv !== undefined ? vv : (r.version_vector || '{}'), r.content_hash || _sha256(r.content), deleted !== undefined ? deleted : (r.deleted_at || null)]);
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
// Wrap a Buffer for PGlite's loadDataDir. Use Blob (a Node 18 global) NOT File (Node 20+)
// so the package's declared engines '>=18' stays honest — all three rollback modes would
// otherwise throw ReferenceError on Node 18. PGlite detects gzip via the blob's `type`
// ('application/x-gzip'), so no filename is needed.
function _blobFromBuffer(buf) { return new Blob([buf], { type: 'application/x-gzip' }); }

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

// Mint a fresh Ed25519 signing keypair record (same shape _getSigningKey persists),
// honoring crypto-04: when a keyPassphrase is configured the private key is SEALED,
// never written in clear. Shared by first-run generation and fork so the two can't
// drift (the fork path once wrote plaintext despite a passphrase — do not regress).
function _newSigningKeypairRecord() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' });
  const pubRawKey = pubRaw.subarray(pubRaw.length - 32);
  const record = {
    algorithm: 'ed25519',
    public_b64: pubRawKey.toString('base64'),
    created_at: new Date().toISOString(),
  };
  if (_keyPassphrase) record.enc = _sealPrivatePem(privPem, _keyPassphrase);
  else record.private_pem = privPem;
  return record;
}

// Used by fork: a fork is a new being and must never be able to sign as the parent.
function _generateSigningKeypairJson() {
  return JSON.stringify(_newSigningKeypairRecord());
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
// Same backoff for the swap renames: directory rename can transiently fail EPERM/EBUSY
// on Windows (AV/indexer probing a freshly-closed dir) right after close().
function _renameRetry(from, to) {
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i === 4) throw e; _sleepSync(150); }
  }
}
function _writeJournal(obj) {
  // Durable: fsync so a power loss can't persist rename#1 while the journal blocks are
  // lost/torn (which would strand recovery). Mirrors snapshot()'s tarball write.
  const fd = fs.openSync(_rollbackJournalPath(), 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
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
    if (valid(brainDir)) { rm(newDir); rm(oldDir); return; } // tidy strays from a completed swap
    // No journal but brain/ is missing/invalid while a valid sibling store exists — a
    // crash whose journal was lost or torn (power loss, AV quarantine, a dotfile-skipping
    // copy tool). NEVER bootstrap a fresh empty brain over recoverable data. Without a
    // journal we can't know rename#2's intent, so prefer brain.old (the pre-rollback
    // store) when present; otherwise complete forward to brain.new.
    if (valid(oldDir)) { rm(brainDir); fs.renameSync(oldDir, brainDir); rm(newDir); return; }
    if (valid(newDir)) { rm(brainDir); fs.renameSync(newDir, brainDir); rm(oldDir); return; }
    return; // genuinely fresh first run: no journal, no brain, no siblings
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
  fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 }); // 0700: snapshots mirror the brain (keyholder data; signing key sealed only when keyPassphrase set)
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
  const fd = fs.openSync(tmpPath, 'w', 0o600); // 0600: snapshot mirrors the brain's at-rest data (signing key sealed only when keyPassphrase set)
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
  // Resolve the LOCAL path first; fall back to the receipt's (absolute) storage_uri only
  // if the local tarball is absent. A baked-in absolute storage_uri would otherwise break
  // EVERY restore after the dataDir moves (new laptop / restored-from-backup / renamed
  // folder) — the exact disaster-recovery moment this feature exists for.
  const local = path.join(_snapDir(), `${receipt.snapshot_id}.tar.gz`);
  const p = fs.existsSync(local) ? local : (receipt.storage_uri || local);
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

  // From here until the swap completes, block concurrent external writes/reads: they
  // would otherwise land in live brain/ during the verify-load, then be renamed into
  // brain.old and deleted = silent loss. _ensure() rejects while _swapInProgress; the
  // rollback's own ops use the separate `verify` instance or direct _db (no _ensure).
  _swapInProgress = true;
  let verify = null;
  try {
    if (fs.existsSync(newDir)) _rmDir(newDir); // stale from a prior crashed replace (loadDataDir refuses a populated dir)
    if (fs.existsSync(oldDir)) _rmDir(oldDir);

    // Load into brain.new + VERIFY (counts + vector probe) BEFORE touching live. A bad
    // blob fails here with live untouched.
    verify = _newPglite(newDir, { loadDataDir: _blobFromBuffer(buf) });
    await verify.query('SELECT 1');
    await _applySchema(verify);
    const restored_counts = await _tableCounts(verify);
    await verify.query('SELECT embedding::text FROM memories WHERE embedding IS NOT NULL LIMIT 1'); // exercise the vector ext
    await verify.close(); verify = null;

    // Journaled directory swap. _recoverInterruptedSwap completes/reverts on next init.
    _writeJournal({ phase: 'swapping', snapshot_id: receipt.snapshot_id, safety_snapshot_id: safety.snapshot_id, at: _ts() });
    _ready = false;
    await close(); // close live _db so the rename can't hit an open handle (Windows EPERM)
    try {
      _renameRetry(brainDir, oldDir); // rename#1
    } catch (e) {
      // rename#1 never moved brain/ — it's intact. Reopen live and bail cleanly so the
      // brain isn't left offline; no changes were applied.
      _clearJournal();
      try { _rmDir(newDir); } catch { /* best effort */ }
      _db = _newPglite(brainDir); await _applySchema(_db); _ready = true;
      throw new Error(`rollback replace: directory swap blocked (${e.message}); live brain intact, no changes applied`);
    }
    // rename#2: if this fails after retries, brain/ is missing but the journal +
    // brain.new are intact → next init()'s _recoverInterruptedSwap completes it forward.
    _renameRetry(newDir, brainDir);
    _clearJournal(); // brain/ is the restored store; past the no-empty-bootstrap risk

    _db = _newPglite(brainDir);
    await _applySchema(_db);
    _ready = true;
    _rmDir(oldDir);
    return { snapshot_id: receipt.snapshot_id, mode: 'replace', imported: restored_counts, skipped: 0, conflicts: 0, safety_snapshot_id: safety.snapshot_id };
  } catch (e) {
    if (verify) { try { await verify.close(); } catch { /* ignore */ } try { _rmDir(newDir); } catch { /* ignore */ } }
    throw e;
  } finally {
    _swapInProgress = false;
  }
}

async function _rollbackFork(receipt, buf) {
  const forkId = `fork_${_compactTs()}_${crypto.randomBytes(4).toString('hex')}`;
  const forkRoot = path.join(path.dirname(_dbPath), 'forks', forkId);
  const forkBrain = path.join(forkRoot, 'brain');
  fs.mkdirSync(path.dirname(forkBrain), { recursive: true, mode: 0o700 });
  let forkDb = null;
  try {
    forkDb = _newPglite(forkBrain, { loadDataDir: _blobFromBuffer(buf) });
    await forkDb.query('SELECT 1');
    await _applySchema(forkDb);
    // A fork is a NEW being: fresh substrate_identity + fresh signing keypair (must
    // never sign as the parent). The forking bowl's own identity is untouched.
    const newIdentity = crypto.randomUUID();
    await forkDb.query("INSERT INTO brain_meta (key, value) VALUES ('substrate_identity', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value", [newIdentity]);
    await forkDb.query("INSERT INTO brain_meta (key, value) VALUES ('signing_keypair_v1', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value", [_generateSigningKeypairJson()]);
    const counts = await _tableCounts(forkDb);
    await forkDb.close(); forkDb = null;
    return { snapshot_id: receipt.snapshot_id, mode: 'fork', imported: counts, skipped: 0, conflicts: 0, fork_bowl_id: newIdentity, fork_path: forkRoot };
  } catch (e) {
    if (forkDb) { try { await forkDb.close(); } catch { /* ignore */ } }
    try { _rmDir(forkRoot); } catch { /* don't strand a forks/<id>/ holding the parent's keypair */ }
    throw e;
  }
}

async function _rollbackForwardMerge(receipt, buf) {
  // Mandatory pre-merge safety snapshot (kernel-ethics #11; also the undo for the
  // merge itself, so even a surprising merge is rollback-able).
  const safety = await snapshot(`pre-forward-merge safety net (before ${receipt.snapshot_id})`, { trigger: 'pre-action' });

  // IN-MEMORY temp instance — options-first form is REQUIRED (see _newPglite). Wrapped
  // in try/finally so a throw mid-merge never leaks the in-memory WASM instance.
  const tmp = _newPglite({ loadDataDir: _blobFromBuffer(buf) });
  try {
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
      const ex = await tx.query('SELECT updated_at, deleted_at FROM state WHERE key = $1', [row.key]);
      // A live tombstone counts as ABSENT here: a deliberate rollback is the keyholder
      // asking to UNDO deletes since the snapshot, so the snapshot's row resurrects
      // (clearing the tombstone). Sync merges respect tombstones; rollback overrides.
      if (ex.rows[0] && !ex.rows[0].deleted_at) {
        conflicts++;
        if (_liveWins(ex.rows[0].updated_at, row.updated_at)) { skipped++; continue; }
        await tx.query(`INSERT INTO state (key,value,updated_by,updated_at,layer,anonymizable,trust_tier) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at, layer=EXCLUDED.layer, anonymizable=EXCLUDED.anonymizable, trust_tier=EXCLUDED.trust_tier`,
          [row.key, row.value, row.updated_by, row.updated_at, row.layer, row.anonymizable, row.trust_tier]);
        imported.state++;
      } else {
        await tx.query(`INSERT INTO state (key,value,updated_by,updated_at,layer,anonymizable,trust_tier,restored_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at, layer=EXCLUDED.layer, anonymizable=EXCLUDED.anonymizable, trust_tier=EXCLUDED.trust_tier, restored_from=EXCLUDED.restored_from, deleted_at=NULL`,
          [row.key, row.value, row.updated_by, row.updated_at, row.layer, row.anonymizable, row.trust_tier, sid]);
        imported.state++; resurrected.state.push(row.key);
      }
    }
    // memories — embedding gated on noseMatch (NULL → re-embed queue)
    // archived_reason (elifant#9) rides alongside pinned/archived here for the
    // same fidelity reason: this is a LOCAL full-state snapshot (unlike
    // exportBrain/importBrain, which deliberately omit pinned/archived
    // entirely — those are local curation, not portable identity), so a
    // rollback that restored `archived = true` but dropped WHY would silently
    // turn a decay-archived row into an unattributed one — which mind.js's
    // SOURCE_WHERE reads as evidence loss instead of the non-event it was.
    for (const row of (await tmp.query('SELECT filename, content, updated_by, updated_at, layer, anonymizable, embedding::text AS embedding, pinned, archived, archived_reason, trust_tier FROM memories')).rows) {
      const emb = noseMatch ? row.embedding : null;
      const ex = await tx.query('SELECT updated_at, deleted_at FROM memories WHERE filename = $1', [row.filename]);
      if (ex.rows[0] && !ex.rows[0].deleted_at) { // tombstone counts as absent → resurrect on rollback
        conflicts++;
        if (_liveWins(ex.rows[0].updated_at, row.updated_at)) { skipped++; continue; }
        await tx.query(`INSERT INTO memories (filename,content,updated_by,updated_at,layer,anonymizable,embedding,pinned,archived,archived_reason,trust_tier) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,$11)
          ON CONFLICT(filename) DO UPDATE SET content=EXCLUDED.content, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at, layer=EXCLUDED.layer, anonymizable=EXCLUDED.anonymizable, embedding=EXCLUDED.embedding, pinned=EXCLUDED.pinned, archived=EXCLUDED.archived, archived_reason=EXCLUDED.archived_reason, trust_tier=EXCLUDED.trust_tier`,
          [row.filename, row.content, row.updated_by, row.updated_at, row.layer, row.anonymizable, emb, row.pinned, row.archived, row.archived_reason, row.trust_tier]);
        imported.memories++;
      } else {
        await tx.query(`INSERT INTO memories (filename,content,updated_by,updated_at,layer,anonymizable,embedding,pinned,archived,archived_reason,trust_tier,restored_from) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,$11,$12)
          ON CONFLICT(filename) DO UPDATE SET content=EXCLUDED.content, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at, layer=EXCLUDED.layer, anonymizable=EXCLUDED.anonymizable, embedding=EXCLUDED.embedding, pinned=EXCLUDED.pinned, archived=EXCLUDED.archived, archived_reason=EXCLUDED.archived_reason, trust_tier=EXCLUDED.trust_tier, restored_from=EXCLUDED.restored_from, deleted_at=NULL`,
          [row.filename, row.content, row.updated_by, row.updated_at, row.layer, row.anonymizable, emb, row.pinned, row.archived, row.archived_reason, row.trust_tier, sid]);
        imported.memories++; resurrected.memories.push(row.filename);
      }
    }
    // steering — RESURRECTED rows come back DISABLED (they steer behavior; the
    // keyholder re-enables deliberately). A snapshot-wins UPDATE keeps the snapshot's
    // enabled flag (it's a content update, not a resurrection).
    //
    // A snapshot is the SAME bowl, so unlike YOINK/SUMMON its grant record is
    // this keyholder's own and travels with the row (elifant#11). Two branches,
    // two rules:
    //   snapshot-wins UPDATE — carry origin + granted_by/granted_at + proposal_id
    //     verbatim. Carrying `enabled` WITHOUT them would have re-enabled a rule
    //     while leaving the live row's grant columns describing different text,
    //     and against the storage floor that is not a subtle inconsistency but a
    //     constraint violation that aborts the whole merge transaction.
    //   RESURRECTION — enabled=false AND the grant forced NULL. "Disabled" and
    //     "ungranted" must not drift apart, or the next grant-aware read would
    //     see a rule that looks vouched-for and merely switched off.
    //     origin/proposal_id DO carry: where a rule came from is still true.
    for (const row of (await tmp.query('SELECT id, name, content, mode, match_pattern, priority, enabled, layer, created_at, updated_at, trust_tier, origin, granted_by, granted_at, proposal_id FROM steering')).rows) {
      const ex = await tx.query('SELECT updated_at, deleted_at FROM steering WHERE id = $1', [row.id]);
      if (ex.rows[0] && !ex.rows[0].deleted_at) { // tombstone counts as absent → resurrect on rollback
        conflicts++;
        if (_liveWins(ex.rows[0].updated_at, row.updated_at)) { skipped++; continue; }
        await tx.query(`INSERT INTO steering (id,name,content,mode,match_pattern,priority,enabled,layer,created_at,updated_at,trust_tier,origin,granted_by,granted_at,proposal_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, content=EXCLUDED.content, mode=EXCLUDED.mode, match_pattern=EXCLUDED.match_pattern, priority=EXCLUDED.priority, enabled=EXCLUDED.enabled, layer=EXCLUDED.layer, updated_at=EXCLUDED.updated_at, trust_tier=EXCLUDED.trust_tier, origin=EXCLUDED.origin, granted_by=EXCLUDED.granted_by, granted_at=EXCLUDED.granted_at, proposal_id=EXCLUDED.proposal_id`,
          [row.id, row.name, row.content, row.mode, row.match_pattern, row.priority, row.enabled, row.layer, row.created_at, row.updated_at, row.trust_tier, row.origin, row.granted_by, row.granted_at, row.proposal_id]);
        imported.steering++;
      } else {
        await tx.query(`INSERT INTO steering (id,name,content,mode,match_pattern,priority,enabled,layer,created_at,updated_at,trust_tier,restored_from,origin,granted_by,granted_at,proposal_id) VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,NULL,NULL,$13)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, content=EXCLUDED.content, mode=EXCLUDED.mode, match_pattern=EXCLUDED.match_pattern, priority=EXCLUDED.priority, enabled=false, layer=EXCLUDED.layer, updated_at=EXCLUDED.updated_at, trust_tier=EXCLUDED.trust_tier, restored_from=EXCLUDED.restored_from, deleted_at=NULL, origin=EXCLUDED.origin, granted_by=NULL, granted_at=NULL, proposal_id=EXCLUDED.proposal_id`,
          [row.id, row.name, row.content, row.mode, row.match_pattern, row.priority, row.layer, row.created_at, row.updated_at, row.trust_tier, sid, row.origin, row.proposal_id]);
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
    // Both scans go through the byte-budgeted reader: either side can hold a
    // capture stream too fat to materialize in one WASM query (armor invariant 1).
    const liveHashes = new Set(
      (await _readCapturesBudgeted((sql, p) => tx.query(sql, p), { columns: 'id, source, type, ts, data' })).map(_captureHash)
    );
    for (const row of await _readCapturesBudgeted((sql, p) => tmp.query(sql, p), { columns: 'id, source, type, ts, data, layer, anonymizable' })) {
      if (pruneWatermark && row.ts && row.ts <= pruneWatermark) { skipped++; continue; }
      const h = _captureHash(row);
      if (liveHashes.has(h)) { skipped++; continue; }
      liveHashes.add(h);
      await tx.query('INSERT INTO captures (source, type, ts, data, layer, anonymizable) VALUES ($1,$2,$3,$4,$5,$6)', [row.source, row.type, row.ts, row.data == null ? null : JSON.stringify(row.data), row.layer, row.anonymizable]);
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
  // Bound snapshots/ growth on the repeated default-mode path (each rollback took a
  // safety snapshot). Exempt the target + the just-taken safety net.
  try { _applyRetention([sid, safety.snapshot_id]); } catch (e) { _debug(`[brain] retention after merge: ${e.message}`); }
  return { snapshot_id: sid, mode: 'forward-merge', imported, skipped, conflicts, safety_snapshot_id: safety.snapshot_id, resurrected_counts: { state: resurrected.state.length, memories: resurrected.memories.length, steering: resurrected.steering.length, review_lessons: resurrected.review_lessons, captures: resurrected.captures }, audit_capture_id: auditId };
  } finally {
    try { await tmp.close(); } catch { /* ignore */ }
  }
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
      // Require a meaningful baseline (~a week of activity) before flagging drift, so a
      // brand-new brain's very first capture isn't reported 'anomalous'.
      if (last7 >= 7 && dailyAvg > 0) { const ratio = last24 / dailyAvg; if (ratio >= 5) significance = 'anomalous'; else if (ratio >= 2.5) significance = 'notable'; }
      observations.push({ dimension: 'capture volume — last 24h vs trailing-7d daily average', baseline: Number(dailyAvg.toFixed(2)), current: last24, delta: dailyAvg > 0 ? Number((last24 - dailyAvg).toFixed(2)) : last24, significance });
    } catch (e) { observations.push(na('capture volume', 'query failed: ' + e.message)); }
  }
  if (want('overview')) {
    // Read canary FIRST: 'SELECT 1' must return exactly one row on any healthy
    // instance, so an empty/failed canary means every other count below is
    // untrustworthy — the silent-empty failure mode reads as 0 everywhere with
    // no error. (The query guard auto-reopens on this, so an anomalous reading
    // here means recovery itself failed.)
    try {
      const c = await _db.query('SELECT 1 AS ok');
      const alive = !!(c.rows && c.rows.length === 1);
      observations.push({
        dimension: 'storage read canary (SELECT 1)', baseline: '1 row',
        current: alive ? '1 row' : 'EMPTY — instance cannot be trusted to read',
        delta: 0, significance: alive ? 'normal' : 'anomalous',
        ...(alive ? {} : { note: 'the storage instance returns empty results without erroring; all counts in this report are unreliable — reopen/restart required' }),
      });
    } catch (e) {
      observations.push({ dimension: 'storage read canary (SELECT 1)', baseline: '1 row', current: 'ERROR: ' + e.message, delta: 0, significance: 'anomalous', note: 'reads are failing outright; all counts in this report are unreliable' });
    }
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
      // crypto-04 — honestly report signing-key at-rest protection. 'plaintext' is
      // reported 'normal' (not a drift anomaly) with a note nudging toward a
      // keyPassphrase; it doesn't trigger the snapshot proposal.
      const prot = await signingKeyProtection();
      observations.push({
        dimension: 'signing key protection at rest',
        baseline: 'n/a',
        current: prot,
        delta: 0,
        significance: 'normal',
        note: prot === 'plaintext'
          ? 'private key is plaintext on disk — configure a keyPassphrase (init option / ELIFANT_KEY_PASSPHRASE) to seal it (AES-256-GCM)'
          : prot === 'encrypted' ? 'AES-256-GCM sealed under a PBKDF2-derived key' : 'no signing key generated yet',
      });
    } catch (e) { observations.push(na('signing key protection', e.message)); }
    try {
      const t = (await _db.query("SELECT count(*) FILTER (WHERE trust_tier='tier-3-observed-external')::int t3, count(*) FILTER (WHERE trust_tier='tier-4-raw-exhaust')::int t4 FROM memories WHERE deleted_at IS NULL")).rows[0];
      observations.push({ dimension: 'memories by trust tier (observed/raw)', baseline: 'n/a', current: `tier-3: ${t.t3}, tier-4: ${t.t4}`, delta: 0, significance: 'normal' });
    } catch (e) { observations.push(na('trust tiers', e.message)); }
  }
  if (want('pattern-additions')) {
    try {
      const n = (await _db.query("SELECT count(*)::int n FROM memories WHERE layer='pattern' AND deleted_at IS NULL")).rows[0].n;
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
  if (want('recall-shift')) {
    // elifant#10 — this used to be a flat 'not available' ("recall history not
    // retained in this build"). It is retained now, so the question gets a real
    // answer: how much recall there was, whether it is landing where it was
    // landing before, and how concentrated it is.
    //
    // An EMPTY log is still a real answer — "no recalls recorded in the window"
    // — not a refusal. The only honest 'not available' left here is a query that
    // actually failed. And nothing below is judged without enough volume to
    // judge it: an under-evidenced reading is REPORTED with its number and left
    // at 'normal', never rounded up to a significance it hasn't earned.
    try {
      const dayAgo = _tsAgo(_DAY_MS), weekAgo = _tsAgo(7 * _DAY_MS);
      const last24 = (await _db.query('SELECT count(*)::int n FROM recall_log WHERE ts >= $1', [dayAgo])).rows[0].n;
      const last7 = (await _db.query('SELECT count(*)::int n FROM recall_log WHERE ts >= $1', [weekAgo])).rows[0].n;
      const dailyAvg = last7 / 7;
      let volSig = 'normal';
      // Same baseline guard as capture volume: a brand-new brain's first day of
      // recalls is not drift.
      if (last7 >= 7 && dailyAvg > 0) {
        const ratio = last24 / dailyAvg;
        if (ratio >= 5) volSig = 'anomalous'; else if (ratio >= 2.5) volSig = 'notable';
      }
      observations.push({
        dimension: 'recall volume — last 24h vs trailing-7d daily average',
        baseline: Number(dailyAvg.toFixed(2)),
        current: last24,
        delta: dailyAvg > 0 ? Number((last24 - dailyAvg).toFixed(2)) : last24,
        significance: volSig,
        ...(last7 === 0 ? { note: 'no recalls recorded in the window — either nothing was recalled, or the callers are not naming a recall origin (an unattributed search is deliberately never counted)' } : {}),
      });

      // Per-memory hit counts inside a window. Guarded on jsonb_typeof so a
      // hand-written or future-shaped row can't take the whole facet down.
      const hitCounts = async (from, to) => {
        const w = ['hits IS NOT NULL', "jsonb_typeof(hits) = 'array'", 'ts >= $1'];
        const p = [from];
        if (to) { w.push('ts < $2'); p.push(to); }
        const r = await _db.query(
          `SELECT h->>'f' AS f, count(*)::int AS n FROM recall_log, LATERAL jsonb_array_elements(hits) h WHERE ${w.join(' AND ')} GROUP BY 1`, p
        );
        return r.rows;
      };

      // The shift itself: of the hits recalled in the last 24h, what share landed
      // on memories the prior six days never surfaced? High novelty is attention
      // MOVING; zero is attention settled. Neither is a fault — that is the
      // keyholder's call, which is why this reports a share and not a verdict.
      const today = await hitCounts(dayAgo, null);
      const prior = await hitCounts(weekAgo, dayAgo);
      const priorSet = new Set(prior.map((r) => r.f));
      const todayHits = today.reduce((s, r) => s + r.n, 0);
      const novelHits = today.filter((r) => !priorSet.has(r.f)).reduce((s, r) => s + r.n, 0);
      const novelty = todayHits > 0 ? novelHits / todayHits : 0;
      const judgeable = todayHits >= 5 && priorSet.size >= 5;
      let shiftSig = 'normal';
      if (judgeable) { if (novelty >= 0.8) shiftSig = 'anomalous'; else if (novelty >= 0.5) shiftSig = 'notable'; }
      observations.push({
        dimension: 'recall distribution shift — last-24h hits landing outside the prior 6 days',
        baseline: `${priorSet.size} memories recalled in the prior 6 days`,
        current: todayHits > 0 ? `${Math.round(novelty * 100)}% of ${todayHits} hits are new` : 'no recall hits in the last 24h',
        delta: Number(novelty.toFixed(2)),
        significance: shiftSig,
        ...(judgeable ? {} : { note: 'below the volume needed to call a shift (wants >= 5 hits today and >= 5 memories in the baseline) — reported, not judged' }),
      });

      // Concentration: is recall spreading across the library or collapsing onto
      // a handful of rows? Informational at any value — a concentrated brain is
      // not a sick one, it is a brain with a current obsession, and only the
      // keyholder knows whether that is the right obsession.
      const week = await hitCounts(weekAgo, null);
      const totalHits = week.reduce((s, r) => s + r.n, 0);
      const top5 = week.map((r) => r.n).sort((a, b) => b - a).slice(0, 5).reduce((s, n) => s + n, 0);
      observations.push({
        dimension: 'recall concentration — share of trailing-7d hits on the top 5 memories',
        baseline: `${week.length} distinct memories recalled`,
        current: totalHits > 0 ? `${Math.round((top5 / totalHits) * 100)}% of ${totalHits} hits` : 'no recall hits in the window',
        delta: totalHits > 0 ? Number((top5 / totalHits).toFixed(2)) : 0,
        significance: 'normal',
      });
    } catch (e) { observations.push(na('recall distribution shift', 'query failed: ' + e.message)); }
  }

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
    _deviceIdCache = null;
    _signingKeyCache = null; // drop the unwrapped signing key from memory
    _debug('[brain] closed');
  }
}

// ── the Keeper (0.22.0 — elifant#1/#2/#3) ─────────────────────────────────
// The idle-time librarian: neighbour graph + shelving pass + thought producer.
// All mechanics live in src/keeper.js (pure, model-free); this is the wiring
// that hands it the live store and the kernel's own primitives. The daemon
// calls keeperTick() when the keyholder is idle; every call is bounded and
// every write is receipted.
const _keeperModule = require('./keeper');
const _keeper = _keeperModule.createKeeper({
  query: (sql, params) => { _ensure(); return _db.query(sql, params); },
  addCapture,
  setMemoryDerived: _setMemoryDerived,
  setMemoryArchive,
  snapshot,
  ts: _ts,
  trustTier: TRUST_TIER,
  // elifant#15 — the manner-mismatch notice's only door into steering: it may
  // propose (never enable, see proposeSteering's own grant floor) and read
  // (to avoid re-nagging about an already-granted rule). Nothing else here
  // hands the Keeper a write path into steering.
  proposeSteering,
  getSteering,
});

// ── the Mind (0.23.0 — elifant#5) ─────────────────────────────────────────
// The promotion ladder: thought -> pattern -> knowledge, with visible revision
// and retirement. Watches the Keeper's shelves persist across ticks; recurrence
// earns confidence, confidence crosses thresholds, transitions are receipted
// captures {source:'mind'} and knowledge lands as durable pinned tier-2 rows.
// All mechanics live in src/mind.js (pure, model-free); this is the wiring.
const _mindModule = require('./mind');
const _mind = _mindModule.createMind({
  query: (sql, params) => { _ensure(); return _db.query(sql, params); },
  addCapture,
  setMemoryDerived: _setMemoryDerived,
  setMemoryArchive,
  getState,
  setState,
  deleteState,
  ts: _ts,
  trustTier: TRUST_TIER,
  archiveReason: ARCHIVE_REASON, // elifant#9 — _retire() tags its archive 'mind-retirement'
});

// ── Decay (elifant#9) ──────────────────────────────────────────────────────
// The forgetting curve: untouched, never/rarely-recalled, old keyholder rows
// drift toward archived on their own — reversibly, visibly, never deleted.
// All mechanics live in src/decay.js (pure thresholds, model-free); this is
// the wiring. strengthOf is index.js's OWN private reinforcement curve
// (elifant#8) handed in by reference so decay's "low-strength" gate can never
// quietly drift from what searchMemories' fusion actually ranks by.
const _decayModule = require('./decay');
const _decay = _decayModule.createDecay({
  query: (sql, params) => { _ensure(); return _db.query(sql, params); },
  addCapture,
  setMemoryArchive,
  snapshot,
  ts: _ts,
  trustTier: TRUST_TIER,
  archiveReason: ARCHIVE_REASON,
  strengthOf: _strengthOf,
});

/**
 * Run one bounded Keeper pass, then the Mind's promotion pass over the fresh
 * shelves (pass {mind:false} to skip it; pass {mind:{...}} to override its
 * thresholds). Shipped shells calling keeperTick() bare get the ladder for
 * free on a kernel upgrade — that is the point of it living here.
 * Returns the tick receipt, with the mind's own receipt at receipt.mind
 * (null when skipped).
 */
async function keeperTick(opts = {}) {
  _ensure();
  const receipt = await _keeper.tick(opts);
  // opts.mind: false OR null skips the pass (the receipt already uses `mind:
  // null` as its own "skipped" sentinel, so a host writing that back to opt
  // out — the natural symmetric behavior — must not crash. typeof null ===
  // 'object', so a bare `typeof === 'object'` check would route null into
  // _mind.tick() as its options argument and blow up on `opts.now` after the
  // keeper phase above has already committed its writes.
  if (opts.mind === false || opts.mind === null) {
    receipt.mind = null;
  } else {
    receipt.mind = await _mind.tick(typeof opts.mind === 'object' ? opts.mind : {});
  }
  // keeper.js already persisted 'keeper_last_tick' from INSIDE its own tick(),
  // before .mind existed on this object — so that write is mind-less and
  // keeperStatus().lastTick.mind would silently never appear, contradicting
  // the KeeperTickReceipt type. Re-persist the now-complete receipt so the
  // stored liveness record matches what keeperTick() actually returned.
  await _db.query(
    "INSERT INTO brain_meta (key, value) VALUES ('keeper_last_tick', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(receipt)]
  );
  return receipt;
}

/** The Keeper's own liveness: queue depth, edge/shelf counts, last tick receipt. */
async function keeperStatus() { _ensure(); return _keeper.status(); }

/** Run one Mind pass standalone (opts.now overrides the clock — test hook). */
async function mindTick(opts) { _ensure(); return _mind.tick(opts); }

/** Run one Decay pass standalone (elifant#9). Not chained into keeperTick —
 *  see src/decay.js's header for why. opts.now overrides the clock. */
async function decayTick(opts) { _ensure(); return _decay.tick(opts); }

/** Decay's own liveness: the last tick's receipt. */
async function decayStatus() { _ensure(); return _decay.status(); }

// ── the Guard (elifant#16) ────────────────────────────────────────────────
// Permanent content floors under the promotion ladder (src/guard.js — pure,
// deterministic, reads no config). injectDisposition is the ONE canonical
// answer for how a memory may travel into an AI-facing context block
// ('plain' | 'mark-third-party' | 'hold') — RELEVANCE_FLOORS-style, so every
// shell reads the same verdict instead of re-deriving policy.
const _guardModule = require('./guard');

/** The Mind's liveness: day N, forming/hardened/retired counts, last receipt. */
async function mindStatus() { _ensure(); return _mind.status(); }

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
  // v0.18.0 — canonical relevance floors (one source of "close enough", named tiers)
  RELEVANCE_FLOORS,
  isRelevant,
  filterRelevant,
  // elifant#8 — reinforcement: which callers count as a real recall, and the
  // per-memory counters the fusion's strength leg ranks by
  RECALL_ORIGINS,
  getRecallCounts,
  // elifant#10 — retained recall history (bounded), feeding health('recall-shift')
  getRecallLog,
  pruneRecallLog,
  recallLogCeiling,
  // elifant#16 — inject guard: one canonical answer for how a memory may travel
  // into an AI-facing context block ('plain' | 'mark-third-party' | 'hold')
  injectDisposition: _guardModule.injectDisposition,
  deleteMemory,
  pruneTombstones,
  getAllMemories,
  // v0.6.0 — memory curation (pin + archive)
  setMemoryPin,
  setMemoryArchive,
  // elifant#6 follow-up — a keyholder's own "yes these are the same fact"
  confirmDuplicate,
  // v0.5.0-dev — captures (event stream / projection sink)
  addCapture,
  getCaptures,
  deleteCaptures,
  // elifant#11 — steering (the MANNER slot). Two doors and no third: propose
  // can only write DISABLED, grant is the only writer of enabled=true and
  // cannot run without attribution. Backed by a storage-layer CHECK so the
  // rule holds below the API too.
  STEERING_ORIGIN,
  getSteering,
  getAllSteering,
  proposeSteering,
  grantSteering,
  revokeSteering,
  deleteSteering,
  // elifant#11 — review_lessons (the LEARNED-HEURISTICS slot). No grant needed:
  // this is what she knows, not how she behaves.
  addReviewLesson,
  getReviewLessons,
  deleteReviewLesson,
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
  // crypto-04 — signing key encryption at rest
  signingKeyProtection,
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
  // v0.22.0 — the Keeper (idle-time librarian: neighbour graph, shelves, thoughts)
  keeperTick,
  keeperStatus,
  // v0.23.0 — the Mind (promotion ladder: pattern -> knowledge, visible revision)
  mindTick,
  mindStatus,
  // elifant#9 — the forgetting curve (decay toward the archive, never delete)
  decayTick,
  decayStatus,
  ARCHIVE_REASON,
  // Internal, test-only — NOT a stable public API. Exposed so the version-vector
  // algebra (the causal-merge continuity primitive) can be unit-tested directly.
  _internal: {
    vvParse: _vvParse,
    vvStringify: _vvStringify,
    vvBump: _vvBump,
    vvMerge: _vvMerge,
    vvCompare: _vvCompare,
    sha256: _sha256,
    // Read-through to the live PGlite, so tests can assert on columns the public
    // API doesn't surface (version_vector, deleted_at, conflict-copies). Test-only.
    query: (sql, params) => { _ensure(); return _db.query(sql, params); },
    // crypto-04 — expose the seal/open primitives so tests can prove the sealed
    // envelope round-trips and rejects a wrong passphrase. Test-only.
    sealPrivatePem: _sealPrivatePem,
    openPrivatePem: _openPrivatePem,
    getSigningKey: _getSigningKey,
    // instance armor (2026-07-28) — expose the pure helpers + the failure
    // injector so WASM-death recovery and the silent-empty canary can be
    // proven end-to-end in the suite. Test-only.
    armor: {
      isWasmDeath: _isWasmDeath,
      batchByBudget: _batchByBudget,
      simulateFailure: _simulateFailure,
    },
  },
};
