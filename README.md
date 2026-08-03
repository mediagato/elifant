---
name: "@mediagato/elifant"
type: kernel
status: active
license: BSL-1.1
version: 0.25.1
summary: Local-first PGlite/Postgres-dialect memory kernel for embedding in Node apps -- state, long-form memories, steering rules, semantic search, signed YOINK/SUMMON portability, a polyglot-skills layer, the Keeper (idle-time consolidation), and the Mind (promotion ladder -- pattern to knowledge with visible revision). Reference storage implementation of the Elifantic protocol v0.1.
updated: 2026-08-03
stack: [Node.js, PGlite, pgvector, Postgres-dialect SQL, Ed25519]
tags: [substrate, kernel, memory-engine, local-first, elifantic, byok-sovereignty]
---

# @mediagato/elifant

A memory kernel you embed in a Node application. It stores key/value state, long-form
memories, an append-only event stream, behaviour rules, and learned lessons — then
consolidates them on idle into patterns and, eventually, into knowledge.

It runs **in-process**. PGlite is Postgres compiled to WASM, so there is no server to
start, no port to open, no container, and no account. `init()` opens a directory. The
data belongs to whoever owns that directory.

The interesting part of this kernel is not what it stores. It is what it refuses to do
quietly — see [The refusals](#the-refusals).

## Install

```sh
npm install @mediagato/elifant
```

Node 18+. One runtime dependency (`@electric-sql/pglite`).

## Quickstart

```js
const brain = require('@mediagato/elifant');

await brain.init('./data');            // opens ./data/brain/

await brain.setMemory('kiln-notes.md', 'Cone 6 oxidation, 8h hold.');
const row = await brain.getMemory('kiln-notes.md');
console.log(row.content, row.updated_at);

await brain.setState('last_fired', '2026-08-01');
console.log(await brain.getState('last_fired'));

await brain.addCapture({
  source: 'app',
  type: 'exchange',
  data: { entity: 'assistant', kind: 'prompt' },
});

const recent = await brain.getCaptures({ limit: 20 });   // newest first

await brain.close();
```

Every function throws `Brain not initialized` if called before `init()`.

## What it stores

| Surface | Written with | Notes |
| --- | --- | --- |
| State | `setState` / `getState` / `getAllState` | Small key/value. Soft-deleted, so a delete propagates on sync. |
| Memories | `setMemory` / `getMemory` / `getAllMemories` | Long-form text, optional embedding, `pinned` and `archived` flags. |
| Captures | `addCapture` / `getCaptures` | Append-only event log. Identical rows dedupe. |
| Steering | `proposeSteering` / `grantSteering` | Rules that change how the host **behaves**. |
| Review lessons | `addReviewLesson` | Records what it **knows**. Deliberately not the same table. |

Reads are byte-budgeted internally, so no single query can push the WASM instance past
its memory ceiling — a large event stream cannot be made to read as an empty brain.

## Search

`searchMemories` takes an embedding you supply. **No embedding model ships with this
package** — bring your own, and `migrateEmbedDim` re-homes the column if you change it.

```js
const hits = await brain.searchMemories({
  queryEmbedding: vec,          // number[]
  queryText: 'kiln schedule',   // optional; enables hybrid reranking
  k: 10,
  recall: 'search',             // who is asking; omit for an unattributed read
});
```

With `queryText`, results are re-ranked by Reciprocal Rank Fusion across four legs:
semantic distance, lexical BM25, pin-aware recency, and pin-aware strength (how often a
memory has actually been recalled). The raw cosine `distance` is preserved on every row
either way, so a downstream relevance floor can still key on an absolute number.

`recall` is opt-in on purpose. An unattributed read counts nothing, so instrumentation
never inflates a memory's own strength.

## The refusals

Three places where the kernel declines to do the convenient thing.

**A behaviour rule cannot switch itself on.** `proposeSteering` has no `enabled`
parameter — that is the point of its type, not an omission. `grantSteering` is the only
writer of `enabled = true`, and it cannot be called without `grantedBy`. Enabled,
`granted_by` and `granted_at` are written in one statement, so the row is never
observably enabled-without-a-grant. For any row whose origin has been declared, that
state is rejected by a storage CHECK constraint as well — unrepresentable in SQL, not
merely discouraged by the API.

```js
await brain.proposeSteering({
  id: 'manner.directness',
  name: 'be more direct',
  content: 'brief',
  origin: 'learned',            // 'shell-seeded' | 'keyholder' | 'learned'
});                             // -> { enabled: false }

await brain.grantSteering('manner.directness', { grantedBy: 'keyholder' });
```

Re-proposing with any behavioural field changed revokes an existing grant, because the
grant was for the old text. An identical re-propose keeps it, so a boot-time re-seed does
not switch a user's rules off.

**An inference is never promoted silently.** `mindTick` walks thoughts to patterns to
knowledge, and every visible transition — promotion, revision, retirement — emits its own
capture. Nothing hardens into knowledge without leaving a record of having done so.

**Forgetting is not retraction.** `decayTick` archives old, weak, never-recalled rows. It
never deletes, never touches a pinned or synthesized row, and is reversible with
`setMemoryArchive(filename, false)`. `archived` also carries a *reason*
(`'keyholder' | 'mind-retirement' | 'decay'`), and the Mind's evidence predicates read a
decay-archived row as still live. A memory that faded is not evidence the fact was
withdrawn. A memory a user archived by hand is.

## Consolidation

Both passes are bounded — each does a batch and returns a receipt, so a host can run them
on an idle timer rather than surrender a background thread it does not control.

```js
const keeper = await brain.keeperTick();  // neighbour graph, shelving, thought captures
const mind   = await brain.mindTick();    // the promotion ladder
const decay  = await brain.decayTick();   // the forgetting curve
```

`keeperStatus`, `mindStatus` and `decayStatus` each return the last receipt, so liveness
is a question the kernel can answer about itself.

## Portability

`exportBrain` produces a manifest plus a tar payload, signed with an Ed25519 key the
brain generates for itself. `importBrain` verifies it and reports `signature_status` — a
tampered payload imports as `invalid` rather than silently.

```js
const soul = await brain.exportBrain({ include: { tables: ['memories', 'state'] } });
const result = await brain.importBrain(soul, { conflict: 'newer-wins' });
```

Conflict modes are `skip`, `overwrite` and `newer-wins`. The receiving brain's own
identity and signing key are never overwritten by an import, and steering rows arriving
from elsewhere are forced disabled — a rule granted somewhere else is not a rule granted
here.

The signing key can be sealed at rest with `init(dir, { keyPassphrase })` (AES-256-GCM
under a PBKDF2-600k KEK), and `signingKeyProtection()` reports which mode is in force.
One residual worth stating plainly: migrating an *existing* plaintext key cannot scrub
prior plaintext from WAL or backups. Born-sealed is the hard guarantee.

## Snapshots and health

`snapshot` / `rollback` / `listSnapshots` cover the whole store, and bulk operations take
their own snapshot before writing. `health()` answers a fixed set of questions about the
brain's own state, returning observations and proposals rather than a score.

## Skills

A small polyglot layer for reading skill definitions and carrying them between host
dialects, so one skill set can be presented to more than one runtime.

## Elifantic

This is the reference storage implementation of the Elifantic protocol v0.1. The protocol
spec is separate and permissively licensed; this kernel is not.

## Licence

**Business Source License 1.1.** The source is readable and usable for development,
testing and internal work. It is not a permissive licence, and that is deliberate: this is
the engine, and the terms exist so that reading it is not the same as being handed a
competing product. The adoption-facing pieces of the wider project — the protocol spec and
the client libraries — are MIT. See `LICENSE` for the exact grant.

## API index

Lifecycle `init` `close` `dbPath` `getName` `setName` `signingKeyProtection`
· State `getState` `setState` `getAllState` `deleteState`
· Memories `getMemory` `setMemory` `getAllMemories` `deleteMemory` `setMemoryPin` `setMemoryArchive` `confirmDuplicate` `pruneTombstones`
· Embeddings `setMemoryEmbedding` `getMemoriesNeedingEmbedding` `migrateEmbedDim` `getEmbedMeta` `setEmbedMeta`
· Search `searchMemories` `isRelevant` `filterRelevant` `injectDisposition`
· Recall `getRecallCounts` `getRecallLog` `pruneRecallLog` `recallLogCeiling`
· Captures `addCapture` `getCaptures` `deleteCaptures`
· Steering `getSteering` `getAllSteering` `proposeSteering` `grantSteering` `revokeSteering` `deleteSteering`
· Lessons `addReviewLesson` `getReviewLessons` `deleteReviewLesson`
· Consolidation `keeperTick` `keeperStatus` `mindTick` `mindStatus` `decayTick` `decayStatus`
· Portability `exportBrain` `importBrain` `syncUp` `syncDown` `seedFromSpore` `isSeeded`
· Keyholders `listKeyholders` `setKeyholderTrust` `forgetKeyholder` `pinKeyholder`
· Durability `snapshot` `rollback` `listSnapshots` `health`

Full types and per-function contracts are in `src/index.d.ts`, which ships with the
package.
