/**
 * Type declarations for @mediagato/elifant -- a local-first PGlite memory
 * engine that is the reference implementation of Elifantic protocol v0
 * storage primitives, including YOINK/SUMMON (with v0.2 Ed25519 manifest
 * signing + file_hashes payload integrity), SNAPSHOT / ROLLBACK / HEALTH
 * (protocol v0.1), and crypto-04 signing-key encryption at rest.
 */

// ── Layer + tier vocabulary ───────────────────────────────────────────────

/** Substrate-layer enum. `instance` = keyholder-created; `pattern` = spore-seeded template. */
export type Layer = 'instance' | 'pattern';

/** Layer filter accepts the wildcard 'any' in addition to the layer enum. */
export type LayerFilter = Layer | 'any';

/**
 * Conflict-resolution mode for importBrain. Default: 'newer-wins'.
 * 'skip'|'overwrite'|'newer-wins' are the one-shot YOINK policies (wall-clock).
 * 'merge' is the causal multi-device sync policy: per-row version-vector
 * domination → fast-forward; concurrent divergence → deterministic winner +
 * the loser preserved as a `<key>.conflict-<hash>` copy + a surfaced capture;
 * tombstones propagate; a delete-vs-edit keeps the edit.
 */
export type ConflictMode = 'skip' | 'overwrite' | 'newer-wins' | 'merge';

// ── State + memory row shapes ─────────────────────────────────────────────

/** A row returned from getState. Returns null if the key doesn't exist. */
export interface StateRow {
  value: string;
  layer: Layer;
  updated_at: string;
}

/** A row returned from getAllState. */
export interface StateListRow {
  key: string;
  value: string;
  layer: Layer;
  updated_at: string;
}

/** A row returned from getMemory. Returns null if the filename doesn't exist. */
export interface MemoryRow {
  content: string;
  layer: Layer;
  updated_at: string;
}

/**
 * A metadata row returned from getAllMemories (NO content; for the index).
 * Includes curation flags (pinned/archived) and provenance (updated_by)
 * for "why is this here?" rendering.
 */
export interface MemoryListRow {
  filename: string;
  layer: Layer;
  updated_at: string;
  updated_by: string | null;
  pinned: boolean;
  archived: boolean;
  /** WHY archived (elifant#9) — null when not archived, or when archived
   *  through a call site that pre-dates this column. */
  archived_reason: ArchiveReason | null;
}

/** Options for getAllMemories. By default archived memories are excluded. */
export interface ListMemoriesOptions {
  /** Include archived rows in the result. Default: false. */
  includeArchived?: boolean;
  /** Return ONLY archived rows (overrides includeArchived). Default: false. */
  onlyArchived?: boolean;
}

// ── Spore seed payload shape ──────────────────────────────────────────────

export interface SporeStateEntry {
  key: string;
  value: string;
}

export interface SporeMemoryEntry {
  filename: string;
  content: string;
}

export interface SporeSteeringEntry {
  id: string;
  name: string;
  content: string;
  mode?: 'always' | 'matched' | 'manual';
  match_pattern?: string | null;
  priority?: number;
}

export interface SporeData {
  state?: SporeStateEntry[];
  memories?: SporeMemoryEntry[];
  steering?: SporeSteeringEntry[];
}

// ── YOINK / SUMMON wire format ────────────────────────────────────────────

/** Ed25519 signature attached to a v0.2+ SoulManifest. */
export interface SoulManifestSignature {
  algorithm: 'ed25519';
  /** Base64-encoded 32-byte raw Ed25519 public key of the signer. */
  keyholder_public_key: string;
  /** Base64-encoded Ed25519 signature over the canonical manifest. */
  signature: string;
}

/** The structured manifest at the root of a YOINK tarball. */
export interface SoulManifest {
  schema: 'elifantic-soul-v0' | 'elifantic-soul-v0.2';
  substrate_identity: string;
  display_name: string;
  brain_version: string;
  exported_at: string;
  table_counts: {
    state?: number;
    memories?: number;
    steering?: number;
    review_lessons?: number;
  };
  encryption: null | {
    method: 'aes-256-gcm';
    kdf: 'pbkdf2-sha256';
    iterations: number;
  };
  producer: {
    name: string;
    version: string;
    host: string;
  };
  filter: {
    tables: string[];
    layers: LayerFilter[];
  };
  /**
   * SHA-256 hashes of every data file in the tarball (".jsonl" + brain_meta.json).
   * The signature covers the manifest including these hashes, so changing a
   * data file's bytes after signing causes signature verification to fail
   * on the receiver. Present on all v0.2 manifests produced by v0.3.0-dev.3+.
   */
  file_hashes?: Record<string, string>;
  /**
   * Ed25519 signature over the canonical form of this manifest (with the
   * signature field itself excluded from the signed bytes). Present unless
   * exportBrain was called with { unsigned: true }.
   */
  signature?: SoulManifestSignature;
}

/** Options for exportBrain. All fields optional. */
export interface ExportOptions {
  /** Wire format. v0 only supports 'tar'. */
  format?: 'tar';
  /** Filter the export by table or layer. */
  include?: {
    tables?: Array<'state' | 'memories' | 'steering' | 'review_lessons'>;
    layers?: LayerFilter[];
  };
  /** Encryption options. v0.3+ only (reserved). */
  encrypt?: {
    method: 'aes-256-gcm';
    kdf: 'pbkdf2-sha256';
    iterations: number;
    passphrase: string;
  };
  /**
   * If true, do not attach an Ed25519 signature to the manifest. The export
   * still travels with full data; only the manifest signature is omitted.
   * Default is false (sign by default).
   */
  unsigned?: boolean;
}

/** Result of a successful exportBrain call. */
export interface ExportResult {
  manifest: SoulManifest;
  payload: Buffer;
  bytes: number;
}

/**
 * Receiver-side signature verification mode for importBrain.
 *
 * - 'verify' (default): if the manifest has a signature, verify it. If
 *   missing, accept (treats legacy v0 unsigned manifests as compatible).
 * - 'require': the manifest MUST be signed AND verifiable AND every
 *   file_hashes entry must match the received bytes. Anything else throws.
 * - 'skip': do not verify even if a signature is present. Returned
 *   signature_status will be 'skipped'. For migration/debug only.
 */
export type SignatureMode = 'verify' | 'require' | 'skip';

/**
 * Outcome of the receiver-side signature + payload-integrity check.
 *
 * - 'verified': signature OK and every file_hashes entry matches.
 * - 'invalid': signature failed OR a data file's hash did not match.
 *   Treated as a hard error under signature_mode='require'.
 * - 'skipped': manifest carries a signature but caller chose not to verify.
 * - 'unsigned': manifest does not carry a signature (legacy v0 only).
 */
export type SignatureStatus = 'verified' | 'invalid' | 'skipped' | 'unsigned';

/** Input to importBrain. `payload` is the tar bytes from a prior export. */
export interface ImportInput {
  payload: Buffer | string;
  /** Required if payload is encrypted. v0.3+ only (reserved). */
  passphrase?: string;
  /** Conflict-resolution mode per primary-key row. Default: 'newer-wins'. */
  conflict?: ConflictMode;
  /** Filter import by layer. Default: ['any']. */
  layer_filter?: LayerFilter[];
  /**
   * How strictly to check the manifest signature + file_hashes on receive.
   * Default: 'verify'.
   */
  signature_mode?: SignatureMode;
}

/** Per-table import counts. */
export interface ImportedCounts {
  state: number;
  memories: number;
  steering: number;
  review_lessons: number;
}

/** Result of a successful importBrain call. */
export interface ImportResult {
  imported: ImportedCounts;
  skipped: number;
  conflicts: number;
  /** `merge` policy only: count of concurrent-edit losers preserved as `<key>.conflict-<hash>` copies. */
  conflict_copies?: number;
  manifest: SoulManifest;
  /**
   * Outcome of the signature + payload-integrity check. See SignatureStatus.
   * Treat anything other than 'verified' as "I do not know who created this
   * data" — the import still applied any non-conflicting rows for forward
   * compatibility, but downstream consumers should gate trust on this value.
   */
  signature_status: SignatureStatus;
  /**
   * Trust of the sending keyholder as resolved against the local pin store
   * (crypto-01 TOFU): 'trusted' | 'known' | 'first-contact' | 'unsigned' etc.
   * Present when the import carried a signed manifest.
   */
  sender_trust?: string;
}

// ── SNAPSHOT / ROLLBACK / HEALTH (v0.3 — protocol v0.1) ───────────────────

/** Why a snapshot fired. See protocol v0.1 spec. */
export type SnapshotTrigger =
  | 'keyholder-explicit'
  | 'schedule'
  | 'pre-action'
  | 'anomaly-triggered'
  | 'capture-burst';

/** Rollback mode. Default: 'forward-merge' (safest — never discards keyholder content). */
export type RollbackMode = 'replace' | 'forward-merge' | 'fork';

/** Scope passed to snapshot(). Implementation-defined. */
export interface Scope {
  duration_s?: number;
  geo?: string;
  surface?: string;
  [key: string]: unknown;
}

export interface SnapshotOptions {
  trigger?: SnapshotTrigger;
  scope?: Scope;
}

/** Receipt returned from snapshot(). */
export interface SnapshotReceipt {
  snapshot_id: string;
  reason: string;
  trigger: SnapshotTrigger;
  exported_at: string;
  table_counts: { [table: string]: number };
  bytes: number;
  storage_uri?: string;
  /** "sha256:" + hex digest of the tarball; verified before a rollback restores from it. */
  sha256?: string;
  /** Kernel version that produced the snapshot. */
  brain_version?: string;
  /** The bowl's substrate_identity at snapshot time. */
  substrate_identity?: string;
}

/** Metadata returned from listSnapshots() (no payload). */
export interface SnapshotManifest {
  snapshot_id: string;
  reason: string;
  trigger: SnapshotTrigger;
  exported_at: string;
  table_counts: { [table: string]: number };
  bytes: number;
}

/** Filter passed to listSnapshots(). */
export interface SnapshotFilter {
  since_ts?: string;
  until_ts?: string;
  trigger?: SnapshotTrigger;
  reason_match?: string;
  limit?: number;
}

/** Result of rollback(). */
export interface RollbackResult {
  snapshot_id: string;
  mode: RollbackMode;
  imported: ImportedCounts;
  skipped: number;
  conflicts: number;
  /** Set if mode='fork' — the sibling bowl's (new) substrate_identity. */
  fork_bowl_id?: string;
  /** Set if mode='fork' — filesystem path of the materialized sibling bowl. */
  fork_path?: string;
  /** The auto-snapshot taken before a 'replace'/'forward-merge' (the undo for the op). */
  safety_snapshot_id?: string;
  /** forward-merge: per-table count of rows resurrected (absent-in-live, re-added + flagged). */
  resurrected_counts?: { [table: string]: number };
  /** forward-merge: id of the audit capture listing what was resurrected. */
  audit_capture_id?: string | null;
}

/** Options for rollback(). */
export interface RollbackOptions {
  /** REQUIRED true for mode='replace' (the only data-losing mode) — keyholder confirmation. */
  confirm?: boolean;
}

/** Question the keyholder asks of HEALTH. Default: 'overview'. */
export type HealthQuestion =
  | 'overview'
  | 'director-changes'
  | 'pattern-additions'
  | 'recall-shift'
  | 'capture-volume'
  | 'unknown-sources';

/** A single observation in a HealthReport. */
export interface HealthObservation {
  dimension: string;
  baseline: number | string;
  current: number | string;
  delta: number;
  significance: 'normal' | 'notable' | 'anomalous';
  source_attribution?: string[];
}

/** A proposed one-gesture remediation. */
export interface HealthProposal {
  kind: 'snapshot' | 'rollback' | 'z86' | 'zhush' | 'capture-pause';
  target?: { kind: string; id?: string };
  reason: string;
}

/** Full health report. */
export interface HealthReport {
  question: HealthQuestion;
  baseline_window: string;
  observations: HealthObservation[];
  proposals?: HealthProposal[];
}

// ── Sync options (skeletons until v0.3) ───────────────────────────────────

export interface SyncOptions {
  /** Keyholder secret; never sent in plaintext over the wire. */
  passphrase: string;
  /** Sync server base URL. No default; the caller must supply one. */
  endpoint?: string;
  /** Opaque per-keyholder identifier (32-128 chars [A-Za-z0-9_-]). */
  keyholderId: string;
}

export interface SyncUpResult {
  stored_at: string;
  version: string;
  bytes: number;
}

export interface SyncDownOptions extends SyncOptions {
  conflict?: ConflictMode;
}

export interface SyncDownResult {
  imported: ImportedCounts;
  version: string;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export interface InitOptions {
  /**
   * crypto-04 — encrypt the Ed25519 signing private key at rest. When set (or via
   * env ELIFANT_KEY_PASSPHRASE), the key is AES-256-GCM sealed under a
   * PBKDF2-600k-SHA256-derived KEK; the plaintext PEM never touches disk. An
   * existing plaintext key is migrated to sealed on first use. Omit for legacy
   * plaintext-at-rest behavior. The same passphrase must be supplied on every
   * init or signing (YOINK export) fails loudly rather than silently.
   */
  keyPassphrase?: string;
}

/**
 * Initialize the brain. Opens the database at `<dataDir>/brain/`. Must be
 * called before any other operation; functions throw "Brain not initialized"
 * if called before init.
 */
export function init(dataDir: string, options?: InitOptions): Promise<unknown>;

/**
 * crypto-04 — report how the signing private key is protected at rest, without
 * touching key material: 'encrypted' (AES-256-GCM sealed), 'plaintext' (legacy
 * PEM on disk), or 'none' (no signing key generated yet).
 */
export function signingKeyProtection(): Promise<'encrypted' | 'plaintext' | 'none'>;

/** Return the on-disk directory path. */
export function dbPath(): string;

/** Close the brain. Releases file handles. */
export function close(): Promise<void>;

// ── Brain identity ────────────────────────────────────────────────────────

/** Get this brain's display name. Persona-agnostic: stored name, else
 *  ELIFANT_DEFAULT_NAME, else 'your brain'. Shells name the brain. */
export function getName(): Promise<string>;

/** Set this brain's display name. */
export function setName(name: string): Promise<void>;

// ── State (key/value) ─────────────────────────────────────────────────────

/** Get a state row by key. Returns null if not found. */
export function getState(key: string): Promise<StateRow | null>;

/** Upsert a state row. */
export function setState(key: string, value: string, updatedBy?: string): Promise<void>;

/** Return all state rows ordered by key. */
export function getAllState(): Promise<StateListRow[]>;

/** Delete a state row. No-op if it doesn't exist. */
export function deleteState(key: string): Promise<void>;

// -- Memory (filename/content) ---------------------------------------------

/** Get a memory by filename. Returns null if not found. */
export function getMemory(filename: string): Promise<MemoryRow | null>;

/**
 * Upsert a memory. An optional embedding (number[] of dim 384) can be
 * supplied at write time; if omitted, the row is stored without one and
 * can be filled in later via setMemoryEmbedding.
 */
export function setMemory(
  filename: string,
  content: string,
  updatedBy?: string,
  layer?: Layer,
  embedding?: number[] | null
): Promise<void>;

/** Update only the embedding column for an existing memory. No-op if filename doesn't exist. */
export function setMemoryEmbedding(filename: string, embedding: number[]): Promise<void>;

/**
 * Return memories that don't have an embedding yet (oldest first).
 * Use for backfill workers that compute embeddings asynchronously.
 */
export function getMemoriesNeedingEmbedding(limit?: number): Promise<{ filename: string; content: string }[]>;

/** A row returned from searchMemories. distance is the raw pgvector cosine distance (0=identical, 2=opposite) — ALWAYS preserved, even in hybrid mode. */
export interface MemorySearchHit {
  filename: string;
  content: string;
  layer: Layer;
  updated_at: string;
  distance: number;
  /** Present only in hybrid mode (queryText supplied): the Reciprocal-Rank-Fusion score the rows were re-ordered by. Higher = better. */
  rerank_score?: number;
  /** Present only in hybrid mode. */
  pinned?: boolean;
  /** Present only in hybrid mode (elifant#8): the decayed reinforcement score the strength leg ranked by. 0 = never recalled. */
  strength?: number;
}

/**
 * Who is asking, for recall accounting (elifant#8/#10). `keyholder` and
 * `inject` are REAL recalls: they advance the per-memory access counters and
 * append to the recall log. `housekeeping`, `keeper` and `audit` are named
 * honestly and never counted — the kernel must not reinforce its own
 * bookkeeping. Omitting it entirely is an unattributed read: also never
 * counted. An unrecognized value throws.
 */
export type RecallOrigin = 'keyholder' | 'inject' | 'housekeeping' | 'keeper' | 'audit';

/** Map of recognized recall origins to whether they count as a real recall. */
export const RECALL_ORIGINS: Readonly<Record<RecallOrigin, boolean>>;

/**
 * Semantic search over memories.
 *
 * Base mode (queryEmbedding only): top-k hits ordered by cosine distance to
 * queryEmbedding — byte-identical to pre-0.7.0. Memories without an embedding
 * are excluded; archived excluded unless includeArchived:true. Filters narrow
 * by layer and/or filename prefix.
 *
 * Hybrid mode (also pass queryText): re-ranks a wider candidate pool by
 * Reciprocal Rank Fusion of semantic + lexical (BM25) + pin-aware recency +
 * pin-aware strength (elifant#8) before the top-k cut. The raw cosine `distance`
 * is PRESERVED on every row (downstream relevance floors depend on its absolute
 * value); the fused order is exposed as `rerank_score`. Pass rerank:false to
 * force base mode.
 *
 * Pass `recall` to say who is asking. A real recall (keyholder/inject) advances
 * the access counters of every hit that cleared the LOOSE relevance floor and
 * appends one row to the recall log; anything else leaves no trace. Recall
 * accounting happens in both modes — the strength LEG is hybrid-only, but a
 * recall is a recall.
 */
export function searchMemories(options: {
  queryEmbedding: number[];
  /** Raw query text. When provided, enables hybrid (lexical+recency+strength) reranking. */
  queryText?: string | null;
  k?: number;
  layer?: Layer | null;
  prefix?: string | null;
  includeArchived?: boolean;
  /** Default true; only has effect when queryText is a non-empty string. */
  rerank?: boolean;
  /** Weight of the pin-aware recency leg in the fusion. Default 0.5 (light tie-breaker). */
  recencyWeight?: number;
  /** Weight of the pin-aware strength (reinforcement) leg. Default 0.25 — weighted, not dominant. */
  strengthWeight?: number;
  /** Who is asking. Omit for an unattributed read (counts nothing). @throws on an unrecognized origin */
  recall?: RecallOrigin | null;
}): Promise<MemorySearchHit[]>;

/** A named relevance tier. `strict` (auto/ambient surfaces) favors precision; `loose` (user-initiated exploration) favors recall. */
export type RelevanceTier = 'strict' | 'loose';

/**
 * Canonical cosine-distance floors — the single source of "close enough".
 * MEASURED on the live nomic-embed-text Nose (2026-06-16). A hit is relevant
 * when its `distance` is below the tier's floor. Change the numbers HERE when
 * the embedder changes; shells name a tier instead of hardcoding a value.
 */
export const RELEVANCE_FLOORS: Readonly<Record<RelevanceTier, number>>;

/** True if a hit is relevant at the given tier (default `strict`). A hit with no numeric distance is always relevant. */
export function isRelevant(hit: { distance?: number } | null | undefined, tier?: RelevanceTier): boolean;

/** Filter a hit list to those relevant at the given tier (default `strict`), order preserved. */
export function filterRelevant<T extends { distance?: number }>(hits: T[] | null | undefined, tier?: RelevanceTier): T[];

// ── Reinforcement + recall history (elifant#8 / elifant#10) ───────────────

/** Per-memory recall accounting. Device-local: never exported in a YOINK. */
export interface RecallCountRow {
  filename: string;
  access_count: number;
  first_accessed: string;
  last_accessed: string;
  /** The decayed score the fusion's strength leg ranks by, recomputed at read time. */
  strength: number;
}

/**
 * Read the recall counters — how often each memory actually proved to be the
 * answer, and when it last did. Ordered by access_count descending.
 */
export function getRecallCounts(opts?: { filenames?: string[] | null; limit?: number }): Promise<RecallCountRow[]>;

/** One retained recall. `query_fp` is a fingerprint of the query terms — the words themselves are never stored. */
export interface RecallLogRow {
  id: string;
  ts: string;
  origin: RecallOrigin;
  query_fp: string;
  /** Rows returned by the search (top-k, whether relevant or not). */
  hit_count: number;
  /** Rows that cleared the loose relevance floor and were therefore reinforced. */
  counted_count: number;
  /** Smallest cosine distance in the result — how close the best answer was. Null if none. */
  top_distance: number | null;
  /** The counted hits, capped at 20 per row: `f` = filename, `d` = cosine distance. */
  hits: { f: string; d: number | null }[];
}

/**
 * Read the recall log, newest first. Device-local; feeds health('recall-shift')
 * and is the substrate for the Keeper's noticing detectors.
 */
export function getRecallLog(opts?: { since?: string | null; until?: string | null; origin?: RecallOrigin | null; limit?: number }): Promise<RecallLogRow[]>;

/**
 * Prune the recall log deliberately, by time (`olderThan`) and/or by count
 * (`keep` newest rows). One of the two is required. The log is ALREADY bounded
 * automatically — see recallLogCeiling — so this is the keyholder's gesture,
 * not the safety net. Returns rows deleted.
 */
export function pruneRecallLog(opts: { olderThan?: string | null; keep?: number | null }): Promise<number>;

/**
 * The hard ceiling on retained recall-log rows: ELIFANT_RECALL_LOG_MAX (default
 * 5000, floor 10) plus the amortized-trim slack. The table cannot exceed this.
 */
export function recallLogCeiling(): number;

/**
 * How a memory may travel into an AI-facing context block (elifant#16/#17):
 *   - 'hold': never inject — crisis-lexicon content at any tier (#17), or a
 *     synthesized (tier-2) row about a third party (#16);
 *   - 'mark-third-party': inject ONLY wrapped/marked as the keyholder's own
 *     past words about someone who is not them — never established fact;
 *   - 'plain': no constraint from this guard (tier-3 wrapping / tier-4 holding
 *     stay with the surfaces).
 */
export type InjectDisposition = 'plain' | 'mark-third-party' | 'hold';

/**
 * The one canonical inject-policy verdict for a memory row/search hit
 * (RELEVANCE_FLOORS-style: shells read this instead of re-deriving policy).
 * Pure and deterministic; reads no config — a permanent floor, not a dial.
 */
export function injectDisposition(hit: { content?: string | null; trust_tier?: string | null }): InjectDisposition;

/** The Nose (embedder) identity recorded in a brain. */
export interface EmbedMeta {
  model: string;
  dim: number;
  version: string;
}

/** Get the Nose (embedder) identity recorded in this brain. Defaults to the historical MiniLM/384 Nose. */
export function getEmbedMeta(): Promise<EmbedMeta>;

/** Record the Nose (embedder) identity. Used by a model-swap migration. */
export function setEmbedMeta(meta: { model?: string | null; dim?: number | null; version?: string | null }): Promise<void>;

/**
 * Re-dimension the Scent column for a Nose swap. DROPs + re-ADDs the embedding
 * column at newDim (nulling every Scent; CONTENT is preserved), then records the
 * new Nose identity. DESTRUCTIVE — back up the brain dir first and re-embed after
 * (the backfill queue re-embeds the now-null rows). Returns the count of memories
 * awaiting a fresh Scent.
 */
export function migrateEmbedDim(newDim: number, nose?: { model?: string; version?: string }): Promise<number>;

/**
 * Return memory metadata (NO content). Pinned rows float to the top, then
 * filename order. Archived rows are excluded by default; opt in via
 * includeArchived or fetch only archived via onlyArchived.
 */
export function getAllMemories(options?: ListMemoriesOptions): Promise<MemoryListRow[]>;

/** Toggle the pinned flag on a memory. No-op if the memory doesn't exist. */
export function setMemoryPin(filename: string, pinned: boolean): Promise<void>;

/**
 * Archival reason (elifant#9) — WHY a row was archived, not just that it was.
 * 'keyholder' = archived by hand. 'mind-retirement' = the Mind's own _retire()
 * walking a hardened pattern back down the ladder. 'decay' = src/decay.js's
 * forgetting curve — untouched, never-recalled, old. This is the ONE place
 * the distinction is load-bearing: mind.js's evidence predicates treat a
 * decay-archived row as still-live, and every other reason (including a
 * legacy/unattributed archive) as evidence loss, exactly as before this issue.
 */
export type ArchiveReason = 'keyholder' | 'mind-retirement' | 'decay';
export const ARCHIVE_REASON: { KEYHOLDER: 'keyholder'; MIND_RETIREMENT: 'mind-retirement'; DECAY: 'decay' };

/**
 * Toggle the archived flag on a memory. No-op if the memory doesn't exist.
 * `reason` (elifant#9) is optional and NULL by default — every call site that
 * pre-dates archived_reason keeps working unmodified. Un-archiving always
 * clears the reason regardless of what's passed.
 */
export function setMemoryArchive(filename: string, archived: boolean, reason?: ArchiveReason | null): Promise<void>;

/**
 * elifant#6 follow-up — the keyholder's own "yes, these two say the same
 * fact" (typically wired to a shell's near-dup Bell resolution). Writes ONE
 * new tier-2-synthesized row naming both members; sources are never touched.
 * Feeds the Mind's promotion ladder at full evidence weight (a direct vouch
 * doesn't need to wait for statistical recurrence) — the Guard (#16/#17) and
 * the age floor still apply unconditionally.
 * @throws if either filename is missing, not a live tier-1 row, or crisis-lexicon content
 */
export function confirmDuplicate(aFilename: string, bFilename: string): Promise<{ filename: string }>;

/**
 * Soft-delete a memory by filename: a tombstone (deleted_at + version-vector bump)
 * so the delete propagates on sync instead of being resurrected. Filtered from every
 * read. No-op if absent or already a tombstone.
 */
export function deleteMemory(filename: string): Promise<void>;

/**
 * Garbage-collect tombstones (memories + state) whose deleted_at is at/older than the
 * cutoff. Requires an explicit `olderThan` — a tombstone is only safe to reap once every
 * device has seen the delete, which has no safe default without a sync cursor. Advances
 * `tombstone_prune_watermark`. Returns the number of tombstones reaped.
 */
export function pruneTombstones(opts: { olderThan: string }): Promise<number>;

// ── Captures (event stream / projection sink, v0.5.0-dev) ─────────────────

/** A capture row — one structured event from a substrate-conformant source. */
export interface CaptureRow {
  id: string;
  source: string;
  type: string | null;
  ts: string;
  data: Record<string, unknown> | null;
}

export interface AddCaptureInput {
  source: string;
  type?: string | null;
  data?: Record<string, unknown> | null;
  ts?: string | null;
  /**
   * Store the capture even when it is byte-identical to the newest capture for
   * the same (source, type). Default false: consecutive duplicates are
   * suppressed and the existing row is returned with `deduped: true` — feeder
   * armor against a producer re-sending the same payload in a loop.
   */
  allowDuplicate?: boolean;
}

export interface GetCapturesOptions {
  since?: string;
  until?: string;
  source?: string;
  type?: string;
  limit?: number;
}

export interface DeleteCapturesOptions {
  until?: string;
  source?: string;
  type?: string;
}

/**
 * Append a capture event. Source-specific fields go on `data`; top-level
 * columns are the protocol contract. Designed so any process that can POST
 * JSON can append events without depending on this library directly.
 *
 * Armor: serialized `data` over ELIFANT_MAX_CAPTURE_BYTES (default 1 MiB)
 * is rejected (error code ECAPTURETOOLARGE); a byte-identical consecutive
 * duplicate for the same (source, type) is suppressed unless
 * `allowDuplicate: true`, returning the existing row with `deduped: true`.
 */
export function addCapture(cap: AddCaptureInput): Promise<{ id: string; ts: string; deduped?: true }>;

/**
 * Read captures, newest first. Returns at most `limit` rows (default 1000,
 * max 10000). Internally byte-budgeted (ELIFANT_READ_BUDGET_BYTES, default
 * 4 MiB per underlying query) so no result set can push the WASM instance
 * past its memory ceiling.
 */
export function getCaptures(opts?: GetCapturesOptions): Promise<CaptureRow[]>;

/**
 * Delete captures matching the filter. At least one filter (until/source/type)
 * is required to prevent accidental full-table wipes.
 */
export function deleteCaptures(opts: DeleteCapturesOptions): Promise<number>;

// ── Steering: the manner slot (elifant#11) ────────────────────────────────
//
// steering rows change how the brain BEHAVES (review_lessons, below, change
// what it KNOWS). So the write surface is split in two and there is no third
// door: `proposeSteering` takes no `enabled` argument and can only write a
// disabled entry; `grantSteering` is the only function that writes
// enabled=true and it cannot be called without `grantedBy`. An enabled entry
// with no recorded grant is unrepresentable through this API, and — for any
// row whose origin has been declared — unrepresentable in SQL as well.

/** Where a steering entry came from. A proposal must name one of these. */
export type SteeringOrigin = 'shell-seeded' | 'keyholder' | 'learned';

/** When a steering entry applies. */
export type SteeringMode = 'always' | 'matched' | 'manual';

/** The three origins as a frozen constant, so callers need not hardcode strings. */
export const STEERING_ORIGIN: Readonly<{
  SHELL_SEEDED: 'shell-seeded';
  KEYHOLDER: 'keyholder';
  LEARNED: 'learned';
}>;

/** A steering entry as read back. */
export interface SteeringRow {
  id: string;
  name: string;
  content: string;
  mode: SteeringMode;
  match_pattern: string | null;
  priority: number;
  /** True only when a grant is recorded — see granted_by/granted_at. */
  enabled: boolean;
  layer: Layer;
  /** null on rows that pre-date provenance, were spore-seeded, or arrived from
   *  another bowl. Never invented. */
  origin: SteeringOrigin | null;
  /** Who turned this on. null = not granted. */
  granted_by: string | null;
  /** When it was turned on. null = not granted. */
  granted_at: string | null;
  /** The proposal/evidence this rule came from, when it had one. */
  proposal_id: string | null;
  trust_tier: string;
  created_at: string;
  updated_at: string;
  /** Set when a rollback resurrected this row (resurrect-and-FLAG). */
  restored_from: string | null;
}

export interface ListSteeringOptions {
  /** Omit for ALL entries; true = active rules only; false = proposals only. */
  enabled?: boolean;
  mode?: SteeringMode;
  layer?: Layer;
  origin?: SteeringOrigin;
}

/**
 * A steering PROPOSAL. Note the absence of an `enabled` field: it is not an
 * option this type forgot, it is the point of the type.
 */
export interface SteeringProposal {
  id: string;
  name: string;
  content: string;
  mode?: SteeringMode;
  matchPattern?: string | null;
  priority?: number;
  layer?: Layer;
  /** REQUIRED — an unmarked manner rule is a silent promotion. */
  origin: SteeringOrigin;
  proposalId?: string | null;
}

/** One steering entry by id, or null. Tombstoned entries read as absent. */
export function getSteering(id: string): Promise<SteeringRow | null>;

/** Steering entries, highest priority first then id. Tombstones excluded. */
export function getAllSteering(opts?: ListSteeringOptions): Promise<SteeringRow[]>;

/**
 * Write a steering entry as a proposal — ALWAYS disabled. Cannot produce an
 * active rule; that is grantSteering's sole job.
 *
 * Re-proposing with any behavioural field changed (content / mode /
 * match_pattern / priority) revokes an existing grant, because the grant
 * covered the old text — reported as `revoked_grant`, never silent. An
 * identical re-propose keeps the grant, so an idempotent boot-time re-seed
 * does not switch the keyholder's rules off.
 *
 * @throws if id/name/content are missing, or `origin` is not a SteeringOrigin
 */
export function proposeSteering(entry: SteeringProposal): Promise<{
  id: string;
  enabled: boolean;
  revoked_grant: boolean;
}>;

/**
 * Turn a steering entry on. The ONLY writer of enabled=true in the kernel,
 * and it requires `grantedBy`: enabled, granted_by and granted_at are written
 * by one UPDATE, so the row is never observably enabled-without-a-grant.
 * @throws if grantedBy is missing/blank, or the entry does not exist
 */
export function grantSteering(
  id: string,
  grant: { grantedBy: string; proposalId?: string | null; note?: string | null },
): Promise<{ id: string; enabled: true; granted_by: string; granted_at: string }>;

/**
 * Turn a steering entry off and clear its grant. Idempotent — a missing,
 * tombstoned or already-ungranted entry reports `changed:false`. `revokedBy`
 * is recorded when given but never required: nothing should stand between a
 * keyholder and switching a behaviour off.
 */
export function revokeSteering(
  id: string,
  opts?: { revokedBy?: string | null; note?: string | null },
): Promise<{ id: string; enabled: false; changed: boolean }>;

/**
 * Soft-delete a steering entry (tombstone + version-vector bump), so the
 * delete propagates on sync instead of being resurrected. Clears the grant on
 * the way down. No-op if absent or already tombstoned.
 */
export function deleteSteering(id: string): Promise<void>;

// ── Review lessons: the learned-heuristics slot (elifant#11) ──────────────

/** A learned rule derived from prior tasks. */
export interface ReviewLessonRow {
  id: number;
  task_type: string;
  rule: string;
  source_item_id: number | null;
  layer: Layer;
  created_at: string;
  restored_from: string | null;
}

export interface ReviewLessonInput {
  /** camelCase on the way IN, snake_case on the way OUT (the column name). */
  taskType: string;
  rule: string;
  sourceItemId?: number | null;
  layer?: Layer;
}

export interface ListReviewLessonsOptions {
  taskType?: string | null;
  /** Default 1000, capped at 10000 (bounded reads only). */
  limit?: number;
}

/**
 * Append a learned lesson, dedup'd on (task_type, rule) — the same key the
 * snapshot forward-merge dedups by. A repeat returns the existing row with
 * `deduped:true`. No grant is required: this records what she KNOWS, and
 * knowing is not behaving. To make a lesson change behaviour, take it through
 * proposeSteering + grantSteering.
 */
export function addReviewLesson(lesson: ReviewLessonInput): Promise<{ id: number; deduped?: true }>;

/** Learned lessons, newest first. Filter by taskType for one kind of work. */
export function getReviewLessons(opts?: ListReviewLessonsOptions): Promise<ReviewLessonRow[]>;

/** Delete one lesson by id (a hard delete — this table is outside the
 *  version-vector machinery). True if a row was removed. */
export function deleteReviewLesson(id: number): Promise<boolean>;

// ── Spore seed ────────────────────────────────────────────────────────────

/**
 * Idempotent seed of pattern-layer data. Returns the count of rows attempted.
 * ON CONFLICT DO NOTHING — never overwrites existing user data.
 */
export function seedFromSpore(sporeData: SporeData): Promise<number>;

/** Return the seed timestamp or null if this brain has never been seeded. */
export function isSeeded(): Promise<string | null>;

// ── YOINK / SUMMON (v0.2+) ────────────────────────────────────────────────

/**
 * Serialize the bowl into a portable USTAR tarball per the Elifantic protocol v0
 * YOINK/SUMMON wire format. Returns { manifest, payload, bytes }.
 */
export function exportBrain(options?: ExportOptions): Promise<ExportResult>;

/**
 * Import a tarball produced by a prior exportBrain call. Inverse of exportBrain.
 * The receiving bowl's substrate_identity is NEVER overwritten; the incoming
 * identity is reported in the returned manifest for audit. Conflict policy
 * per primary-key row (skip / overwrite / newer-wins; default: newer-wins).
 */
export function importBrain(input: ImportInput): Promise<ImportResult>;

// ── Keyholder key pinning (crypto-01 — TOFU trust anchor) ──

/** A pinned keyholder (foreign substrate identity + its trusted signing key). */
export interface KeyholderRow {
  substrate_identity: string;
  public_key: string;
  display_name: string | null;
  trusted: boolean;
  first_seen: string;
  last_seen: string;
  last_exported_at: string | null;
  last_signature: string | null;
}

/** List known keyholders (pinned signing keys). Powers CONSENT/HEALTH surfaces. */
export function listKeyholders(): Promise<KeyholderRow[]>;

/** Bless/unbless a known keyholder — the "I trust this keyholder" gesture. */
export function setKeyholderTrust(identity: string, trusted: boolean): Promise<void>;

/** Un-pin a keyholder. A later import from them becomes first-contact again. */
export function forgetKeyholder(identity: string): Promise<void>;

/**
 * Pin a keyholder's public key OUT-OF-BAND (verified fingerprint / in person) —
 * the strongest trust establishment. After this, an import claiming this identity
 * with any other key is rejected as impersonation.
 */
export function pinKeyholder(
  identity: string,
  publicKey: string,
  options?: { trusted?: boolean; displayName?: string | null },
): Promise<void>;

// ── SNAPSHOT / ROLLBACK / LIST_SNAPSHOTS / HEALTH (v0.3 — protocol v0.1) ──

/**
 * Capture a portable restore point: a full-fidelity filesystem dumpDataDir copy of
 * the whole store (every table, embedding, flag, identity — NOT an exportBrain dump).
 */
export function snapshot(reason: string, options?: SnapshotOptions): Promise<SnapshotReceipt>;

/**
 * Restore from a snapshot. Default mode 'forward-merge' (safest — resurrect-and-flag,
 * newer-wins). 'replace' (full restore, the only data-losing mode) requires
 * options.confirm===true. 'fork' materializes a sibling bowl with a fresh identity.
 */
export function rollback(snapshotId: string, mode?: RollbackMode, options?: RollbackOptions): Promise<RollbackResult>;

/**
 * Enumerate available restore points (metadata only), newest-first.
 */
export function listSnapshots(filter?: SnapshotFilter): Promise<SnapshotManifest[]>;

/**
 * Self-diagnostic; reports drift/poisoning signals vs baseline. Never throws for a
 * known question; an unanswerable facet emits an explicit "not available" observation
 * (MAY refuse a facet but MUST acknowledge the question was asked).
 */
export function health(question?: HealthQuestion): Promise<HealthReport>;

// ── Sync (skeletons today; full implementation lands alongside the sync server) ──

/** Encrypt + push the database to a sync server. Skeleton (throws NotImplementedError until the sync server ships). */
export function syncUp(options: SyncOptions): Promise<SyncUpResult>;

/** Pull from a sync server + decrypt + merge. Skeleton (throws NotImplementedError until the sync server ships). */
export function syncDown(options: SyncDownOptions): Promise<SyncDownResult>;

// ── Polyglot-skills layer (v0.10.0) ──
//
// Read + carry verbs over a per-host skill location + format map. "Native
// everywhere, proprietary nowhere." The canonical map lives in the elifantic
// spec (spec/skills-registry.json, MIT); this kernel vendors a snapshot for
// sovereign offline operation. A caller-supplied map always wins.

/** One on-disk skill/rules surface in the host-map registry. */
export interface SkillsHost {
  id: string;
  label: string;
  scope: 'user' | 'project';
  path: string;
  match: string;
  format: 'skill-md' | 'mdc' | 'markdown' | 'plain';
  extract: 'frontmatter' | 'h1' | 'filename';
}

/** One MCP capability surface (config file + the key holding its server map). */
export interface SkillsMcp {
  id: string;
  label: string;
  path?: string;
  paths?: Partial<Record<NodeJS.Platform, string>>;
  key: string;
}

/** The host-map registry: where every host keeps its skills. */
export interface SkillRegistry {
  version: string;
  kind?: string;
  hosts: SkillsHost[];
  mcp?: SkillsMcp[];
  [k: string]: unknown;
}

export interface LoadRegistryOptions {
  /** A registry object supplied by the caller — wins over everything. */
  registry?: SkillRegistry;
  /** Path to a registry JSON file. Used when `registry` is absent. */
  registryPath?: string;
}

export interface ScanOptions extends LoadRegistryOptions {
  /** LOCAL config: dirs whose immediate children are project roots. */
  projectRoots?: string[];
  /** Override $HOME (testing). */
  home?: string;
}

export interface ScannedSkill {
  name: string;
  desc: string | null;
  path: string;
}

export interface ScannedHost {
  id: string;
  label: string;
  format: string;
  items: ScannedSkill[];
}

export interface ScannedMcp {
  id: string;
  label: string;
  servers: string[];
}

export interface ScanResult {
  hosts: ScannedHost[];
  mcp: ScannedMcp[];
  stats: { skills: number; hostsHit: number; projectsScanned: number };
}

export type CarryTarget = 'cursor' | 'agents' | 'claude';

export interface CarryOptions {
  /** Path to a Claude SKILL.md (alternative to skillsDir + name). */
  source?: string;
  /** Dir holding <name>/SKILL.md (default ~/.claude/skills). */
  skillsDir?: string;
  /** Skill dir name (with skillsDir). */
  name?: string;
  target: CarryTarget;
  /** Override $HOME (testing). */
  home?: string;
}

export interface CarryResult {
  name: string;
  target: CarryTarget;
  /** Relative path a caller MAY write the translated skill to. */
  suggestedPath: string;
  text: string;
  /** Sibling files that don't survive the trip to a flat target. */
  lossy: string[];
  /** True = pure prose, nothing lost. */
  clean: boolean;
}

export namespace skills {
  /** Resolve the host-map registry (caller registry > registryPath > vendored snapshot). */
  function loadSkillRegistry(opts?: LoadRegistryOptions): SkillRegistry;
  /** READ: inventory every skill on this machine across every host. Pure filesystem, zero network. */
  function scanSkills(opts?: ScanOptions): ScanResult;
  /** CARRY: translate a Claude skill into another host's dialect; names what can't survive the trip. Does not write to disk. */
  function carrySkill(opts: CarryOptions): CarryResult;
  /** Absolute path to the vendored registry snapshot. */
  const VENDORED_REGISTRY: string;
}

// ── the Keeper (0.22.0 — idle-time librarian) ──────────────────────────────

/** Receipt returned by one bounded Keeper pass — every number re-derives from
 *  the rows the tick wrote. */
export interface KeeperTickReceipt {
  at: string;
  /** Memories drained from the neighbour queue this tick. */
  processed: number;
  /** first-light thoughts emitted (new-territory notices). */
  firstLights: number;
  shelvesWritten: number;
  shelvesArchived: number;
  /** Total thought captures emitted (shelf + first-light). */
  thoughts: number;
  /** Contradiction needs-decision captures emitted this tick (elifant#7). */
  contradictions: number;
  /** Near-dup merge-proposal needs-decision captures emitted this tick (elifant#6). */
  nearDups: number;
  prunedEdges: number;
  /** True when the pre-write snapshot guard fired (kernel-ethic #11). */
  snapshotTaken: boolean;
  /** The Mind's promotion-pass receipt (0.23.0 — rides the tail of every
   *  keeperTick). null when skipped via {mind:false}. */
  mind: MindTickReceipt | null;
}

export interface KeeperStatus {
  /** Memories awaiting neighbour computation (embedding present, neighbours_at NULL). */
  queue: number;
  edges: number;
  /** Live (unarchived) shelves. */
  shelves: number;
  lastTick: KeeperTickReceipt | null;
}

/** Run one bounded Keeper pass: drain a batch of the neighbour queue, refresh
 *  shelves from the edge graph, emit receipted thought captures — then run the
 *  Mind's promotion pass over the fresh shelves (opt out with {mind:false},
 *  override its thresholds with {mind:{...}}). Deterministic, model-free,
 *  idempotent; sources are never modified. */
export function keeperTick(opts?: { batch?: number; mind?: false | MindTickOptions }): Promise<KeeperTickReceipt>;

/** The Keeper's own liveness: queue depth, graph size, last tick receipt. */
export function keeperStatus(): Promise<KeeperStatus>;

// ── the Mind (0.23.0 — promotion ladder, elifant#5) ────────────────────────

/** Threshold overrides for one Mind pass. `now` (ISO 8601) overrides the
 *  clock — a test hook, the Keeper `batch` twin. */
export interface MindTickOptions {
  now?: string;
  promoteConf?: number;
  promoteN?: number;
  promoteAgeH?: number;
  /** Evidence depth that buys a pattern out of `promoteAgeH` — and out of
   *  NOTHING else (confidence, recurrence and the Guard all still apply).
   *  Defaults to Infinity, so the age gate is unconditional unless a host
   *  opts in. For hosts whose evidence lives in a rolling window, where a
   *  pattern's `born` can never age past the window however deep the
   *  evidence gets (elifant#20). */
  promoteHighN?: number;
  reviseConf?: number;
  retireConf?: number;
  targetN?: number;
  freshDays?: number;
  horizonDays?: number;
}

/** Receipt returned by one Mind pass — every number re-derives from the
 *  ledger rows the tick wrote. */
export interface MindTickReceipt {
  at: string;
  /** New patterns first sighted this tick (each emitted a `pattern` capture). */
  upserted: number;
  /** Patterns hardened into pinned knowledge (each emitted a `knowledge` capture). */
  promoted: number;
  /** Visible revisions (each emitted a `revision` capture). */
  revised: number;
  /** Visible retirements (knowledge archived; each emitted a `retirement` capture). */
  retired: number;
  /** Retired patterns pulled back to forming by fresh evidence. */
  revived: number;
  /** Fizzled forming patterns culled from the ledger (quiet — never narrated). */
  culled: number;
  /** Otherwise-promotable patterns refused by the permanent content floor
   *  (elifant#16 third-party guard; elifant#17 domain denylist + crisis).
   *  A third-party/domain refusal is narrated once via a `guard` capture,
   *  then quiet; a crisis hold is never narrated at all. */
  guarded: number;
  forming: number;
  hardened: number;
  patterns: number;
}

/** One transition on the ladder, as carried in a {source:'mind'} capture's
 *  data. Stage vocabulary: 'pattern' | 'knowledge' | 'revision' | 'retirement'
 *  | 'guard' (a visible promotion refusal — elifant#16). */
export interface MindEvent {
  t: string;
  stage: 'pattern' | 'knowledge' | 'revision' | 'retirement' | 'guard';
  patternId: string;
  kind: string;
  /** The producer row this pattern was BORN on (a shelf/confirmed filename).
   *  Stable for the pattern's whole life — a pattern that dissolves and later
   *  reforms on a new shelf keeps this one (elifant#18), so it is an identity,
   *  not a pointer to a currently-live row. */
  theme: string;
  themeLabel: string;
  /** Stable public grouping key (hash of theme) — thread events without the raw id. */
  threadKey: string;
  /** Deterministic template line; hosts may re-voice it through a narrator. */
  text: string;
  confidence: number;
  evidenceSummary: string;
  /** The durable knowledge row (knowledge/revision/retirement stages). */
  knowledge?: string;
  retired?: boolean;
  /** The refusal reason on a 'guard' capture (e.g. 'third-party'). */
  guard?: string;
}

export interface MindStatus {
  /** Days since the mind's epoch (0 before the first tick). */
  day: number;
  forming: number;
  hardened: number;
  retired: number;
  patterns: number;
  lastTick: MindTickReceipt | null;
}

/** Run one Mind pass standalone: read the Keeper's live shelves as pattern
 *  candidates, earn/decay confidence, walk the ladder (promote / revise /
 *  retire / revive), emit a receipted {source:'mind'} capture per transition.
 *  Knowledge lands as durable PINNED tier-2-synthesized memories
 *  (producer 'mind/promotion-v1') — never through the keyholder's pin path. */
export function mindTick(opts?: MindTickOptions): Promise<MindTickReceipt>;

/** The Mind's own liveness: day N, ladder counts, last tick receipt. */
export function mindStatus(): Promise<MindStatus>;

// ── Decay (elifant#9 — the forgetting curve) ───────────────────────────────

/** Threshold overrides for one Decay pass. `now` (ISO 8601) overrides the
 *  clock — a test hook, same convention as MindTickOptions.now. */
export interface DecayTickOptions {
  now?: string;
  /** A keyholder-direct row untouched (no edit) for at least this long is
   *  old enough to be considered. Default 60 — double mind.js's own
   *  horizonDays (30), so decay never front-runs the Mind's own recency
   *  judgement on a pattern's member rows. */
  decayAgeDays?: number;
  /** Earned recall strength (elifant#8's curve) below this is "weak enough"
   *  to decay, given it is also old enough. Default 0.1. */
  decayStrengthFloor?: number;
  /** Bounded writes (archives) per tick. Default 50. */
  batch?: number;
  /** Bounded reads (candidates considered, oldest-edited-first) per tick. Default 500. */
  scanLimit?: number;
}

/** Receipt returned by one Decay pass. */
export interface DecayTickReceipt {
  at: string;
  /** Old-enough candidates examined this tick (read bound, not write bound). */
  scanned: number;
  /** Rows archived (reason 'decay') this tick — each emitted a
   *  {source:'decay', type:'decayed'} capture. */
  decayed: number;
  /** True when the pre-write snapshot guard fired (kernel-ethic #11). */
  snapshotTaken: boolean;
}

export interface DecayStatus {
  lastTick: DecayTickReceipt | null;
}

/** One decay event, as carried in a {source:'decay', type:'decayed'}
 *  capture's data. */
export interface DecayEvent {
  t: string;
  filename: string;
  /** The row's earned recall strength (elifant#8) at the moment it decayed —
   *  always below decayStrengthFloor. */
  strength: number;
  text: string;
}

/**
 * Run one Decay pass standalone: archive (reason 'decay') every keyholder-
 * direct, unpinned, live row that is both old enough (no edit in
 * decayAgeDays) and weak enough (earned recall strength under
 * decayStrengthFloor), up to `batch` per tick. Reversible via
 * setMemoryArchive(filename, false) exactly like any other archive; never
 * deletes; never touches a pinned or synthesized row. NOT chained into
 * keeperTick — see src/decay.js's header for why. */
export function decayTick(opts?: DecayTickOptions): Promise<DecayTickReceipt>;

/** Decay's own liveness: the last tick's receipt. */
export function decayStatus(): Promise<DecayStatus>;
