/**
 * Type declarations for @mediagato/elifant -- a local-first PGlite memory
 * engine that is the reference implementation of Elifantic protocol v0
 * storage primitives, including YOINK/SUMMON (with v0.2 Ed25519 manifest
 * signing + file_hashes payload integrity) and skeleton operations for
 * SNAPSHOT / ROLLBACK / HEALTH (protocol v0.1).
 */

// ── Layer + tier vocabulary ───────────────────────────────────────────────

/** Substrate-layer enum. `instance` = keyholder-created; `pattern` = spore-seeded template. */
export type Layer = 'instance' | 'pattern';

/** Layer filter accepts the wildcard 'any' in addition to the layer enum. */
export type LayerFilter = Layer | 'any';

/** Conflict-resolution mode for importBrain. Default: 'newer-wins'. */
export type ConflictMode = 'skip' | 'overwrite' | 'newer-wins';

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

/** A metadata row returned from getAllMemories (NO content; for the index). */
export interface MemoryListRow {
  filename: string;
  layer: Layer;
  updated_at: string;
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
  manifest: SoulManifest;
  /**
   * Outcome of the signature + payload-integrity check. See SignatureStatus.
   * Treat anything other than 'verified' as "I do not know who created this
   * data" — the import still applied any non-conflicting rows for forward
   * compatibility, but downstream consumers should gate trust on this value.
   */
  signature_status: SignatureStatus;
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
  /** Set if mode='fork' — the sibling bowl's id. */
  fork_bowl_id?: string;
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

/**
 * Initialize the brain. Opens the database at `<dataDir>/brain/`. Must be
 * called before any other operation; functions throw "Brain not initialized"
 * if called before init.
 */
export function init(dataDir: string): Promise<unknown>;

/** Return the on-disk directory path. */
export function dbPath(): string;

/** Close the brain. Releases file handles. */
export function close(): Promise<void>;

// ── Brain identity ────────────────────────────────────────────────────────

/** Get this brain's display name. Default: 'Bob'. */
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

/** A row returned from searchMemories. distance is pgvector cosine distance (0=identical, 2=opposite). */
export interface MemorySearchHit {
  filename: string;
  content: string;
  layer: Layer;
  updated_at: string;
  distance: number;
}

/**
 * Semantic search over memories. Returns top-k hits ordered by cosine
 * distance to queryEmbedding. Memories without an embedding are excluded.
 * Optional filters narrow by layer and/or filename prefix.
 */
export function searchMemories(options: {
  queryEmbedding: number[];
  k?: number;
  layer?: Layer | null;
  prefix?: string | null;
}): Promise<MemorySearchHit[]>;

/** Return all memory metadata (NO content) ordered by filename. */
export function getAllMemories(): Promise<MemoryListRow[]>;

/** Delete a memory by filename. No-op if it doesn't exist. */
export function deleteMemory(filename: string): Promise<void>;

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

// ── SNAPSHOT / ROLLBACK / LIST_SNAPSHOTS / HEALTH (v0.3 — protocol v0.1) ──

/**
 * Capture a portable restore point. Sugar over exportBrain with retention
 * discipline. Skeleton in v0.3.0-dev (throws NotImplementedError until full
 * impl lands in a future release).
 */
export function snapshot(reason: string, options?: SnapshotOptions): Promise<SnapshotReceipt>;

/**
 * Restore from a snapshot. Default mode: 'forward-merge' (safest). 'replace'
 * mode requires explicit keyholder confirmation per spec. Skeleton in v0.3.0-dev.
 */
export function rollback(snapshotId: string, mode?: RollbackMode): Promise<RollbackResult>;

/**
 * Enumerate available restore points. Metadata only. Skeleton in v0.3.0-dev.
 */
export function listSnapshots(filter?: SnapshotFilter): Promise<SnapshotManifest[]>;

/**
 * Self-diagnostic; reports drift or poisoning signals. Skeleton in
 * v0.3.0-dev. Implementations MAY refuse to answer specific questions but
 * MUST acknowledge the question was asked.
 */
export function health(question?: HealthQuestion): Promise<HealthReport>;

// ── Sync (skeletons today; full implementation lands alongside the sync server) ──

/** Encrypt + push the database to a sync server. Skeleton (throws NotImplementedError until the sync server ships). */
export function syncUp(options: SyncOptions): Promise<SyncUpResult>;

/** Pull from a sync server + decrypt + merge. Skeleton (throws NotImplementedError until the sync server ships). */
export function syncDown(options: SyncDownOptions): Promise<SyncDownResult>;
