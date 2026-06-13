# @mediagato/elifant

A local-first PGlite-backed memory engine for embedding in Node applications. Holds state, long-form memories, steering rules, and template seed data on the user's machine. Postgres-dialect throughout; nothing leaves the process unless the caller explicitly exports it.

## Install

This package is published to **GitHub Packages** (`https://npm.pkg.github.com`) with restricted access. To install:

1. Map the `@mediagato` scope to GitHub Packages in an `.npmrc` (repo-local or `~/.npmrc`):

   ```text
   @mediagato:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   always-auth=true
   ```

2. Export a token with `read:packages` scope before installing:

   ```bash
   export NODE_AUTH_TOKEN=$(gh auth token)   # or paste a PAT directly
   npm install @mediagato/elifant
   ```

In GitHub Actions, `actions/setup-node@v4` writes the same `.npmrc` automatically:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '22'
    registry-url: 'https://npm.pkg.github.com'
    scope: '@mediagato'
- name: Install
  env:
    NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_TOKEN }}
  run: npm ci
```

Default `secrets.GITHUB_TOKEN` does not have cross-repo read on user-namespace packages; either grant the consuming repo access via the package's "Manage Actions access" UI, or use a Classic PAT with `read:packages` scope in a repo secret.

## Usage

```js
const brain = require('@mediagato/elifant');

// Initialize against any directory; a 'brain/' subdir is created inside it.
await brain.init(process.env.HOME);

// State — key/value config
await brain.setState('profession', 'teacher');
const profession = await brain.getState('profession');
// { value: 'teacher', layer: 'instance', updated_at: '2026-04-27T...' }

// Memories — filename-keyed long-form content
await brain.setMemory('lesson_plan_template.md', '# Lesson Plan\n...');
const note = await brain.getMemory('lesson_plan_template.md');

// Spore seed — one-time setup with pattern-layer templates
await brain.seedFromSpore({
  state: [{ key: 'subject_default', value: 'biology' }],
  memories: [{ filename: 'rubric.md', content: '# Rubric template' }],
  steering: [{ id: 'tone', name: 'Tone', content: 'Plain language.' }],
});

// Idempotent — re-seeding never overwrites user data
await brain.isSeeded();  // → timestamp string after first seed

// Cleanup on app quit
await brain.close();
```

## API

### Lifecycle
- `init(dataDir)` — open the database under `dataDir/brain/`. Returns the underlying PGlite instance.
- `dbPath()` — return the on-disk path of the database.
- `close()` — close the database and release file handles.

### Identity
- `getName()` — returns the stored display name. Persona-agnostic default: `ELIFANT_DEFAULT_NAME` if set, else `'your brain'`. The kernel ships nameless; shells (and users) name the brain.
- `setName(name)` — set the display name.

### State
- `getState(key)` — return `{ value, layer, updated_at }` or `null`.
- `setState(key, value, updatedBy?)` — upsert. `updatedBy` defaults to `'brain'`.
- `getAllState()` — return all rows ordered by key.
- `deleteState(key)` — remove the row.

### Memories
- `getMemory(filename)` — return `{ content, layer, updated_at }` or `null`.
- `setMemory(filename, content, updatedBy?, layer?, embedding?)` — upsert. Layer defaults to `'instance'`. Optional embedding is a `number[]` of dimension 384.
- `getAllMemories(options?)` — return metadata for memories. Each row is `{ filename, layer, updated_at, updated_by, pinned, archived }`. Pinned rows float to the top, then filename order. Archived rows are excluded by default; pass `{ includeArchived: true }` to see everything or `{ onlyArchived: true }` for the archive view.
- `deleteMemory(filename)` — remove by filename.

### Curation (v0.6+)
- `setMemoryPin(filename, pinned)` — toggle the pin flag. Pinned memories float to the top of `getAllMemories`; semantic recall does not auto-boost them (boost is the caller's call). No-op if the filename doesn't exist.
- `setMemoryArchive(filename, archived)` — toggle the archive flag. Archived memories are excluded from default `getAllMemories` and from `searchMemories`. The row itself is preserved. No-op if the filename doesn't exist.

### Semantic search (v0.4+)
Powered by pgvector. The memories table has an `embedding vector(384)` column; callers supply the embeddings (the kernel itself never runs a model -- bring your own embedder, e.g. `Xenova/all-MiniLM-L6-v2` for 384-d vectors).

- `setMemoryEmbedding(filename, embedding)` — update only the embedding for an existing memory. Use after async embed-on-save flows.
- `getMemoriesNeedingEmbedding(limit?)` — return up to `limit` memories with NULL embeddings, oldest first. Use for backfill workers.
- `searchMemories({ queryEmbedding, k?, layer?, prefix?, includeArchived? })` — return top-K hits ordered by cosine distance. Hits include `filename`, `content`, `layer`, `updated_at`, and the raw pgvector `distance` (0 = identical, 2 = opposite). Memories without an embedding are excluded. Archived memories are excluded by default; pass `includeArchived: true` to opt back in.

### Seed
- `seedFromSpore(sporeData)` — idempotent insert of pattern-layer templates. Pass `{ state, memories, steering }`. Returns the count of rows attempted.
- `isSeeded()` — return the seed timestamp or `null`.

### YOINK / SUMMON (v0.2+)

Portable export/import via a USTAR tarball with a signed manifest.

- `exportBrain(options?)` — serialize the database into a tarball. Options:
  - `include.tables?: string[]` — subset of `['state', 'memories', 'steering', 'review_lessons']`
  - `include.layers?: ('instance'|'pattern'|'any')[]` — default `['any']`
  - `unsigned?: boolean` — skip Ed25519 manifest signing (default false)

  Returns `{ manifest, payload: Buffer, bytes: number }`. The manifest carries an Ed25519 signature over its canonical form, plus SHA-256 hashes of every data file so payload tampering invalidates the signature.

- `importBrain(input)` — inverse of `exportBrain`. Input:
  - `payload: Buffer | string` — the tar bytes
  - `conflict?: 'skip' | 'overwrite' | 'newer-wins'` — default `'newer-wins'`
  - `layer_filter?: ('instance'|'pattern'|'any')[]` — default `['any']`
  - `signature_mode?: 'verify' | 'require' | 'skip'` — default `'verify'`

  Returns `{ imported, skipped, conflicts, manifest, signature_status }`.

  Behavior notes:
  - `review_lessons` always appends (no natural key).
  - `brain_meta.substrate_identity` is **never** overwritten — the importing database keeps its own identity. The incoming identity is reported in the returned manifest for audit.
  - `signing_keypair_v1` is **never** imported — each database keeps its own private signing key, even if a malicious sender includes their key in the payload.
  - Only `brain_name` and `spore_seeded_at` keys flow through `brain_meta` import. Other keys stay private to the source database.

```js
// Move a database between machines (manual transfer, no server needed)
const exported = await brain.exportBrain();
fs.writeFileSync('bob.tar', exported.payload);
// ... copy bob.tar to another machine ...
const back = await brain.importBrain({ payload: fs.readFileSync('bob.tar') });
console.log(back.imported);  // { state: 124, memories: 631, steering: 8, review_lessons: 14 }
console.log(back.signature_status);  // 'verified' | 'invalid' | 'unsigned' | 'skipped'
```

### Snapshot / Rollback / Health (v0.3, skeletons)

`snapshot()`, `rollback()`, `listSnapshots()`, and `health()` are declared and typed but throw `NotImplementedError` in v0.3.0-dev. Real implementations ship in a future release.

### Sync (skeletons)

`syncUp()` and `syncDown()` are declared and typed but throw `NotImplementedError`. The kernel itself never initiates network calls in its current implementation; sync ships in a future release alongside a sync server.

### Polyglot-skills layer (v0.10+) — `skills`

*Native everywhere, proprietary nowhere.* The substrate ships no walled skill format; it is fluent in every vendor's, because it knows where each host keeps them. The `skills` namespace folds two read-side verbs over a per-host **location + format map**. Pure filesystem, zero network.

```js
const { skills } = require('@mediagato/elifant');

// READ — inventory every skill on this machine across every host.
// projectRoots is LOCAL config (which dirs are project roots); supply it here.
const inv = skills.scanSkills({ projectRoots: ['C:/CascadeProjects'] });
// -> { hosts: [{ id, label, format, items: [{ name, desc, path }] }],
//      mcp:   [{ id, label, servers }],
//      stats: { skills, hostsHit, projectsScanned } }

// CARRY — translate a Claude skill into another host's dialect (cursor|agents|claude).
// Best-effort + honest: it NAMES what can't survive the trip and does NOT write to disk.
const out = skills.carrySkill({ name: 'seal', target: 'cursor' });
// -> { name, target, suggestedPath, text, lossy: [...], clean }
if (!out.clean) console.warn('lossy:', out.lossy); // bundled helpers a flat target can't hold
```

The **use** verb has no code here: once a carried skill sits in a host's slot, that host runs it natively — the substrate borrows the runtime, then owns it.

The canonical host-map lives in the [elifantic spec](https://github.com/mediagato/elifantic) (`spec/skills-registry.json`, MIT — the open joint everyone plugs into). This kernel **vendors a snapshot** (`src/skills-registry.json`) so a core substrate capability never depends on fetching cloud infra at runtime; `loadSkillRegistry({ registry })` lets a caller-supplied map win. Add a host (a new assistant grew an on-disk skill format?) by PR'ing the spec.

## Schema

```sql
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  layer TEXT DEFAULT 'instance',
  anonymizable BOOLEAN DEFAULT true
);

CREATE TABLE memories (
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

CREATE TABLE steering (
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

CREATE TABLE review_lessons (
  id SERIAL PRIMARY KEY,
  task_type TEXT NOT NULL,
  rule TEXT NOT NULL,
  source_item_id INTEGER,
  layer TEXT DEFAULT 'instance',
  created_at TEXT NOT NULL
);

CREATE TABLE brain_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## Environment variables

All optional.

- `MEDIAGATO_ELIFANT_DEBUG=1` (or `=true`) — emit `[brain] ...` diagnostics to stderr. Default: off. Checked at each call site, so toggling at runtime works.
- `MEDIAGATO_ELIFANT_REVEAL_HOST=1` (or `=true`) — embed the real `os.hostname()` in the `producer.host` field of every YOINK manifest. Default: the literal string `'redacted'`. Strict comparison (`'0'` / `'false'` do **not** enable disclosure).
- `MEDIAGATO_ELIFANT_PRODUCER_HOST=<string>` — pin a chosen string for `producer.host`. Ignored only if `MEDIAGATO_ELIFANT_REVEAL_HOST` is set to exactly `'1'` or `'true'`.
- `MEDIAGATO_ELIFANT_PRODUCER=<string>` — override the `producer.name` field in YOINK manifests. Default: `'mediagato-elifant'`.

## License

BSL 1.1 — see [LICENSE](LICENSE). Free for personal, non-commercial, and small-organization use (< 5 deployments or < $1M revenue); embedded use by end users of applications licensed by the Licensor is free. Commercial redistribution requires a license from the Licensor. Converts to Apache 2.0 on 2030-05-22.
